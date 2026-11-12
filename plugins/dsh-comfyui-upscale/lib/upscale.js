/**
 * 图片放大（SeedVR2 7B int8）核心：模板装配 + 提交轮询 + 任务记录。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.join(HERE, '..', 'workflows');

let cached = null;
let inputCache = { at: 0, list: [] };

export async function loadSpec() {
  if (cached) return cached;
  const template = JSON.parse(await fs.readFile(path.join(WORKFLOW_DIR, 'seedvr2_upscale_image.api.json'), 'utf8'));
  const slots = JSON.parse(await fs.readFile(path.join(WORKFLOW_DIR, 'seedvr2_upscale_image.slots.json'), 'utf8'));
  cached = { template, slots };
  return cached;
}

/** ComfyUI input 目录里可用的图片名（30 秒缓存）。 */
export async function availableInputImages(host = 'http://127.0.0.1:8188') {
  if (Date.now() - inputCache.at < 30000 && inputCache.list.length) return inputCache.list;
  try {
    const res = await fetch(host.replace(/\/+$/, '') + '/object_info/LoadImage', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return inputCache.list;
    const data = await res.json();
    const list = data?.LoadImage?.input?.required?.image?.[0];
    if (Array.isArray(list)) {
      inputCache = { at: Date.now(), list };
      return list;
    }
  } catch { /* 离线 */ }
  return inputCache.list;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);

/** 可能的 output 目录（ComfyUI Desktop 把输出放在共享目录，便携版在安装目录下）。 */
function outputRoots() {
  const env = process.env.DSH_COMFY_OUTPUT_DIR;
  const list = [];
  if (env) list.push(env);
  const local = process.env.LOCALAPPDATA || '';
  if (local) list.push(path.join(local, 'Comfy-Desktop', 'ComfyUI-Shared', 'output'));
  list.push('E:\\ComfyUI\\output', 'C:\\ComfyUI\\output', 'D:\\ComfyUI\\output');
  return list;
}

/** 列出 output 目录里的图片（按修改时间倒序）。 */
export async function listOutputs(limit = 120) {
  for (const root of outputRoots()) {
    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = [];
    for (const entry of entries) {
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
        let children = [];
        try {
          children = await fs.readdir(full, { withFileTypes: true });
        } catch { continue; }
        for (const child of children) {
          if (!child.isFile()) continue;
          const ext = path.extname(child.name).toLowerCase();
          if (!IMAGE_EXT.has(ext)) continue;
          const info = await fs.stat(path.join(full, child.name)).catch(() => null);
          if (info) files.push({ name: child.name, subfolder: entry.name, size: info.size, mtime: info.mtimeMs });
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!IMAGE_EXT.has(ext)) continue;
        const info = await fs.stat(full).catch(() => null);
        if (info) files.push({ name: entry.name, subfolder: '', size: info.size, mtime: info.mtimeMs });
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return { root, files: files.slice(0, limit) };
  }
  return { root: null, files: [] };
}

/** 把 output 里的一张图复制进 ComfyUI 的 input 目录，返回 input 里的文件名。 */
export async function importFromOutput(client, name, subfolder = '') {
  const safeName = String(name || '').replace(/^.*[\\/]/, '');
  if (!safeName) throw new Error('没有指定文件名');
  for (const root of outputRoots()) {
    const full = path.join(root, String(subfolder || ''), safeName);
    let buffer;
    try {
      buffer = await fs.readFile(full);
    } catch {
      continue;
    }
    const ext = path.extname(safeName).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
    return client.upload(buffer, safeName, mime);
  }
  throw new Error(`在 output 目录里找不到 ${subfolder ? subfolder + '/' : ''}${safeName}`);
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export async function buildPrompt(opts = {}) {
  const spec = await loadSpec();
  const prompt = JSON.parse(JSON.stringify(spec.template));
  const knobs = spec.slots.knobs;

  const image = String(opts.image || '').trim();
  if (!image) throw new Error('还没有选择输入图片：先上传一张，或从 input 目录里挑一张');
  prompt[knobs.image.node].inputs[knobs.image.input] = image;

  prompt[knobs.scale.node].inputs[knobs.scale.input] =
    clamp(opts.scale, knobs.scale.min, knobs.scale.max, knobs.scale.default);

  if (typeof opts.scaleMethod === 'string' && knobs.scaleMethod.options.includes(opts.scaleMethod)) {
    prompt[knobs.scaleMethod.node].inputs[knobs.scaleMethod.input] = opts.scaleMethod;
  }

  const tile = Math.round(clamp(opts.tileSize, knobs.tileSize.min, knobs.tileSize.max, knobs.tileSize.default));
  const overlap = Math.round(clamp(opts.overlap, knobs.overlap.min, knobs.overlap.max, knobs.overlap.default));
  // 编码与解码两个节点的分块参数必须一致
  for (const key of ['tileSize', 'overlap']) {
    const knob = knobs[key];
    const value = key === 'tileSize' ? tile : overlap;
    prompt[knob.node].inputs[knob.input] = value;
    const mirror = spec.slots.mirrorKnobs && spec.slots.mirrorKnobs[key];
    if (mirror) prompt[mirror.node].inputs[mirror.input] = value;
  }

  const rawSeed = opts.seed;
  const seedGiven = rawSeed !== undefined && rawSeed !== null && String(rawSeed).trim() !== '';
  const parsedSeed = seedGiven ? Number(rawSeed) : Number.NaN;
  const seed = Number.isFinite(parsedSeed) ? Math.trunc(parsedSeed) : Math.floor(Math.random() * 2 ** 48);
  prompt[knobs.seed.node].inputs[knobs.seed.input] = seed;

  if (typeof opts.colorCorrection === 'string' && knobs.colorCorrection.options.includes(opts.colorCorrection)) {
    prompt[knobs.colorCorrection.node].inputs[knobs.colorCorrection.input] = opts.colorCorrection;
  }
  if (typeof opts.filenamePrefix === 'string' && opts.filenamePrefix.trim() !== '') {
    prompt[knobs.filenamePrefix.node].inputs[knobs.filenamePrefix.input] = opts.filenamePrefix;
  }

  return {
    prompt,
    summary: {
      image,
      scale: prompt[knobs.scale.node].inputs[knobs.scale.input],
      tileSize: tile,
      overlap,
      seed,
      colorCorrection: prompt[knobs.colorCorrection.node].inputs[knobs.colorCorrection.input],
      nodes: Object.keys(prompt).length,
    },
  };
}

export async function fetchImages(client, entry) {
  const items = Object.values(entry.outputs || {}).flatMap((o) => o.images || []);
  const out = [];
  for (const item of items) {
    const url = client.host + '/view?filename=' + encodeURIComponent(item.filename)
      + '&subfolder=' + encodeURIComponent(item.subfolder || '')
      + '&type=' + encodeURIComponent(item.type || 'output');
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (res.ok) out.push({ buffer: Buffer.from(await res.arrayBuffer()), filename: item.filename, meta: item.metadata || {} });
  }
  if (out.length === 0) throw new Error('这次执行没有产出图片');
  return out;
}

export async function run(client, opts = {}, hooks = {}) {
  const { prompt, summary } = await buildPrompt(opts);
  const promptId = await client.submit(prompt);
  if (hooks.onSubmit) hooks.onSubmit(promptId, summary);
  const entry = await client.wait(promptId, opts.timeoutMs || 1800000, (seconds) => {
    if (hooks.onTick) hooks.onTick(seconds, promptId);
  });
  const images = await fetchImages(client, entry);
  return { images, promptId, summary };
}

export function friendlyError(error) {
  const raw = String((error && error.message) || error || '');
  const hint = (text) => `${text}｜原始信息：${raw.replace(/\s+/g, ' ').slice(0, 500)}`;

  if (/seedvr2/i.test(raw) && /not in|value not in list|not found/i.test(raw)) {
    return hint('SeedVR2 模型缺失：需要把 seedvr2_7b_int8_convrot.safetensors（放 diffusion_models/）和 seedvr2_ema_vae_fp16.safetensors（放 vae/）下载到 ComfyUI 的 models 目录，然后重启 ComfyUI');
  }
  if (/out of memory|not enough memory|allocation on device/i.test(raw)) {
    return hint('显存不足（OOM）：把「分块大小」调小（如 256）、或降低放大倍数再试');
  }
  if (/prompt outputs failed validation|node_errors/i.test(raw)) {
    return hint('工作流校验失败：通常是参数越界或模型文件不在位');
  }
  if (/cuda/i.test(raw)) {
    return hint('CUDA 报错：显卡驱动或显存状态异常，可重启 ComfyUI 再试');
  }
  if (/超时|timeout/i.test(raw)) {
    return hint('等待超时：大图放大会很慢，任务可能还在 ComfyUI 队列里跑');
  }
  return raw.slice(0, 800) || '未知错误';
}

export async function saveImage(dataDir, jobId, image) {
  const dir = path.join(dataDir, 'images');
  await fs.mkdir(dir, { recursive: true });
  const ext = path.extname(image.filename || '.png') || '.png';
  const file = path.join(dir, jobId + ext);
  await fs.writeFile(file, image.buffer);
  return file;
}

const MAX_JOBS = 60;

export class JobStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'jobs.json');
    this.jobs = new Map();
    this.ready = this.load();
  }

  async load() {
    try {
      const list = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (Array.isArray(list)) for (const job of list) this.jobs.set(job.id, job);
    } catch { /* 首次 */ }
  }

  async persist() {
    const list = [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_JOBS);
    this.jobs = new Map(list.map((job) => [job.id, job]));
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(list, null, 2), 'utf8');
  }

  create(params) {
    const id = 'up_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const job = { id, status: 'queued', createdAt: Date.now(), updatedAt: Date.now(), params };
    this.jobs.set(id, job);
    return job;
  }

  get(id) { return this.jobs.get(id) || null; }

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
