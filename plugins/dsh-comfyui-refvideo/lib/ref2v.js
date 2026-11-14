/**
 * ref2v（参考图/音频/视频 → 视频）的宿主侧核心。
 *
 * 职责：读模板 + 注入参数 + 装配参考位 + 提交轮询 + 任务记录。
 * 不碰 UI，UI 和 Agent 工具都调这里，保证两条入口行为一致。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyModelOverrides } from './models.js';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.join(HERE, '..', 'workflows');

/** 参考位节点 id 分配，与 workflows/*.slots.json 的 idAllocation 保持一致。 */
const ID = { image: 900, video: 920, videoParts: 930, audio: 940 };

const TARGET = '136';

let cached = null;

/** 读取模板与注入契约（进程内缓存；改了文件重启插件即可）。 */
export async function loadSpec() {
  if (cached) return cached;
  const api = JSON.parse(await fs.readFile(path.join(WORKFLOW_DIR, 'minimax_h3_ref2va.api.json'), 'utf8'));
  const slots = JSON.parse(await fs.readFile(path.join(WORKFLOW_DIR, 'minimax_h3_ref2va.slots.json'), 'utf8'));
  cached = { template: api, slots };
  return cached;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 把调用参数注入模板，产出可直接 POST /prompt 的 API JSON。
 * 返回的 summary 只用于回显，不参与提交。
 */
export async function buildPrompt(opts = {}) {
  const spec = await loadSpec();
  const prompt = JSON.parse(JSON.stringify(spec.template));
  if (!prompt[TARGET]) throw new Error(`模板缺少目标节点 ${TARGET}（MiniMaxH3ReferenceToVideo），工作流文件可能被改过`);

  const knobs = spec.slots.knobs;
  const target = prompt[TARGET].inputs;

  // ---- 标量参数 ----
  const text = String(opts.prompt || '').trim();
  if (!text) throw new Error('prompt 不能为空：参考生视频靠提示词描述镜头，用 <Picture 1> / <Audio 1> 指代参考素材');
  target.prompt = text;

  const aspect = String(opts.aspectRatio || knobs.aspectRatio.default || '16:9 (Widescreen)');
  if (!knobs.aspectRatio.options.includes(aspect)) {
    throw new Error(`aspectRatio 不在可选范围内：${aspect}`);
  }
  prompt[knobs.aspectRatio.node].inputs[knobs.aspectRatio.input] = aspect;

  const megapixels = clamp(opts.megapixels, knobs.megapixels.min, knobs.megapixels.max, knobs.megapixels.default);
  prompt[knobs.megapixels.node].inputs[knobs.megapixels.input] = megapixels;

  const duration = clamp(opts.durationSeconds, knobs.durationSeconds.min, knobs.durationSeconds.max, knobs.durationSeconds.default);
  prompt[knobs.durationSeconds.node].inputs[knobs.durationSeconds.input] = duration;

  // 种子：空串 / null / 非数字都是「随机」。
  // 注意 Number('') === 0 且 Number.isFinite(0) 为真，不能直接用它判断。
  const rawSeed = opts.seed;
  const seedGiven = rawSeed !== undefined && rawSeed !== null && String(rawSeed).trim() !== '';
  const parsedSeed = seedGiven ? Number(rawSeed) : Number.NaN;
  const seed = Number.isFinite(parsedSeed) ? Math.trunc(parsedSeed) : Math.floor(Math.random() * 2 ** 48);
  prompt[knobs.seed.node].inputs[knobs.seed.input] = seed;

  prompt[knobs.lightning.node].inputs[knobs.lightning.input] = opts.lightning !== false;
  const lora = String(opts.lora || knobs.lora.default);
  if (!knobs.lora.options.includes(lora)) throw new Error(`lora 不在可选范围内：${lora}`);
  prompt[knobs.lora.node].inputs[knobs.lora.input] = lora;

  const refImageSize = String(opts.refImageSize || knobs.refImageSize.default);
  if (!knobs.refImageSize.options.includes(refImageSize)) throw new Error(`refImageSize 不在可选范围内：${refImageSize}`);
  target[knobs.refImageSize.input] = refImageSize;

  // ---- 参考位：按上传顺序平铺成 <类型>.<名> 键 ----
  const images = sanitizeList(opts.images, spec.slots.refSlots.images.max, 'images');
  const audios = sanitizeList(opts.audios, spec.slots.refSlots.audios.max, 'audios');
  const videos = sanitizeList(opts.videos, spec.slots.refSlots.videos.max, 'videos');

  images.forEach((file, i) => {
    const id = String(ID.image + i);
    prompt[id] = { class_type: 'LoadImage', inputs: { image: file } };
    target[`ref_images.ref_image_${i}`] = [id, 0];
  });

  audios.forEach((file, i) => {
    const id = String(ID.audio + i);
    prompt[id] = { class_type: 'LoadAudio', inputs: { audio: file } };
    target[`ref_audios.ref_audio_${i}`] = [id, 0];
  });

  videos.forEach((file, i) => {
    const loadId = String(ID.video + i);
    const partsId = String(ID.videoParts + i);
    prompt[loadId] = { class_type: 'LoadVideo', inputs: { file } };
    // LoadVideo 输出 VIDEO，必须拆成帧(0)与音轨(1)才能分别接两个参考位
    prompt[partsId] = { class_type: 'GetVideoComponents', inputs: { video: [loadId, 0] } };
    target[`ref_videos.ref_video_${i}`] = [partsId, 0];
    if (opts.videoAudio !== false) {
      target[`ref_video_audios.ref_video_audio_${i}`] = [partsId, 1];
    }
  });

  const summary = {
    prompt: text,
    aspectRatio: aspect,
    megapixels,
    durationSeconds: duration,
    seed,
    lightning: opts.lightning !== false,
    lora,
    refImageSize,
    images: images.length,
    videos: videos.length,
    audios: audios.length,
    nodes: Object.keys(prompt).length,
  };
  return { prompt, summary };
}

function sanitizeList(value, max, label) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} 必须是文件名数组`);
  const names = value.map((v) => String(v || '').trim()).filter(Boolean);
  if (names.length > max) throw new Error(`${label} 最多 ${max} 个，收到 ${names.length} 个`);
  return names;
}

/** 提交并等待完成，返回产物 Buffer。 */
export async function run(client, opts = {}, hooks = {}) {
  const { prompt, summary } = await buildPrompt(opts);
  applyModelOverrides(prompt, opts.models);
  const promptId = await client.submit(prompt);
  if (hooks.onSubmit) hooks.onSubmit(promptId, summary);
  const entry = await client.wait(promptId, opts.timeoutMs || 3600000, (seconds) => {
    if (hooks.onTick) hooks.onTick(seconds, promptId);
  });
  const { buffer, meta } = await client.fetchOutput(entry);
  return { buffer, meta, promptId, summary };
}

/**
 * 把 ComfyUI 的原始报错翻成能照做的中文，原文附在后面。
 * 不吞信息：诊断细节仍然可见，只是前面先给结论。
 */
export function friendlyError(error) {
  const raw = String((error && error.message) || error || '');
  const hint = (text) => `${text}｜原始信息：${raw.replace(/\s+/g, ' ').slice(0, 500)}`;

  if (/out of memory|not enough memory|allocation on device|cuda error: out of memory|hip out of memory/i.test(raw)) {
    return hint('显存不足（OOM）：这个工作流约需 22 GB 显存。可试 降低像素(megapixels)、缩短时长，或改用远程 ComfyUI');
  }
  if (/prompt outputs failed validation|node_errors/i.test(raw)) {
    return hint('工作流校验失败：通常是参数越界或素材文件名不在 ComfyUI 的 input 目录里');
  }
  if (/no such file|invalid image|file not found|cannot find|not in input/i.test(raw)) {
    return hint('素材找不到：参考素材必须已经上传到 ComfyUI 的 input 目录（面板上传会自己传）');
  }
  if (/cuda/i.test(raw)) {
    return hint('CUDA 报错：显卡驱动或显存状态异常，可先重启 ComfyUI 再试');
  }
  if (/超时|timeout/i.test(raw)) {
    return hint('等待超时：任务可能仍在跑，去 ComfyUI 队列看一眼再决定是否重试');
  }
  return raw.slice(0, 800) || '未知错误';
}

/** 把产物落到插件私有目录，返回可被 /media 路由读出的路径。 */
export async function saveMedia(dataDir, jobId, buffer) {
  const dir = path.join(dataDir, 'ref2v');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${jobId}.mp4`);
  await fs.writeFile(file, buffer);
  return file;
}

/* ------------------------------------------------------------------ */
/* output 目录：列出已生成的文件，选中时复制进 input 当素材用            */
/* ------------------------------------------------------------------ */

const KIND_EXT = {
  images: new Set(['.png', '.jpg', '.jpeg', '.webp']),
  videos: new Set(['.mp4', '.webm', '.mov', '.mkv']),
  audios: new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a']),
};

function outputRoots() {
  const list = [];
  const env = process.env.DSH_COMFY_OUTPUT_DIR;
  if (env) list.push(env);
  const local = process.env.LOCALAPPDATA || '';
  if (local) list.push(path.join(local, 'Comfy-Desktop', 'ComfyUI-Shared', 'output'));
  list.push('E:\\ComfyUI\\output', 'C:\\ComfyUI\\output', 'D:\\ComfyUI\\output');
  return list;
}

function kindOfExt(ext) {
  for (const [kind, set] of Object.entries(KIND_EXT)) if (set.has(ext)) return kind;
  return null;
}

/** 列出 output 目录里的媒体文件（按时间倒序），带 kind 分类。 */
export async function listOutputs(limit = 200) {
  for (const root of outputRoots()) {
    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = [];
    const collect = async (dir, subfolder) => {
      let list = [];
      try {
        list = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of list) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        const kind = kindOfExt(ext);
        if (!kind) continue;
        const info = await fs.stat(path.join(dir, entry.name)).catch(() => null);
        if (info) files.push({ name: entry.name, subfolder, kind, size: info.size, mtime: info.mtimeMs });
      }
    };
    for (const entry of entries) {
      if (entry.isDirectory()) await collect(path.join(root, entry.name), entry.name);
      else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const kind = kindOfExt(ext);
        if (!kind) continue;
        const info = await fs.stat(path.join(root, entry.name)).catch(() => null);
        if (info) files.push({ name: entry.name, subfolder: '', kind, size: info.size, mtime: info.mtimeMs });
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return { root, files: files.slice(0, limit) };
  }
  return { root: null, files: [] };
}

/** 把 output 里的文件复制进 ComfyUI 的 input 目录，返回 input 里的文件名。 */
export async function importFromOutput(client, name, subfolder = '') {
  const safeName = String(name || '').replace(/^.*[\\/]/, '');
  if (!safeName) throw new Error('没有指定文件名');
  const ext = path.extname(safeName).toLowerCase();
  const kind = kindOfExt(ext) || 'images';
  const mime = ext === '.mp4' ? 'video/mp4'
    : ext === '.webm' ? 'video/webm'
      : ext === '.mov' ? 'video/quicktime'
        : ext === '.wav' ? 'audio/wav'
          : ext === '.mp3' ? 'audio/mpeg'
            : ext === '.ogg' ? 'audio/ogg'
              : ext === '.flac' ? 'audio/flac'
                : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
                  : ext === '.webp' ? 'image/webp' : 'image/png';
  for (const root of outputRoots()) {
    const full = path.join(root, String(subfolder || ''), safeName);
    let buffer;
    try {
      buffer = await fs.readFile(full);
    } catch {
      continue;
    }
    const stored = await client.upload(buffer, safeName, mime);
    return { name: stored, kind };
  }
  throw new Error(`在 output 目录里找不到 ${subfolder ? subfolder + '/' : ''}${safeName}`);
}

/* ------------------------------------------------------------------ */
/* 任务记录：内存 + 落盘，面板刷新/插件重载后还能读到                     */
/* ------------------------------------------------------------------ */

const MAX_JOBS = 60;

export class JobStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'ref2v-jobs.json');
    this.jobs = new Map();
    this.ready = this.load();
  }

  async load() {
    try {
      const list = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (Array.isArray(list)) for (const job of list) this.jobs.set(job.id, job);
    } catch {
      /* 首次运行没有文件 */
    }
  }

  async persist() {
    const list = [...this.jobs.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_JOBS);
    this.jobs = new Map(list.map((job) => [job.id, job]));
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(list, null, 2), 'utf8');
  }

  create(params) {
    const id = 'r2v_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const job = { id, status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), params };
    this.jobs.set(id, job);
    return job;
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  list(limit = 20) {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  async patch(id, patch) {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: Date.now() });
    await this.persist();
    return job;
  }
}
