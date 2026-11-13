/**
 * 文生音乐（YuE2 3B）核心：模板装配 + 提交轮询 + 任务记录。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.join(HERE, '..', 'workflows');

const AUDIO_EXT = new Set(['.flac', '.mp3', '.opus', '.wav', '.m4a', '.ogg']);
const MAX_JOBS = 40;

let cached = null;

export async function loadSpec() {
  if (cached) return cached;
  const template = JSON.parse(await fs.readFile(path.join(WORKFLOW_DIR, 'yue2_text2music.api.json'), 'utf8'));
  const slots = JSON.parse(await fs.readFile(path.join(WORKFLOW_DIR, 'yue2_text2music.slots.json'), 'utf8'));
  cached = { template, slots };
  return cached;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function outputRoots() {
  const list = [];
  const env = process.env.DSH_COMFY_OUTPUT_DIR;
  if (env) list.push(env);
  const local = process.env.LOCALAPPDATA || '';
  if (local) list.push(path.join(local, 'Comfy-Desktop', 'ComfyUI-Shared', 'output'));
  list.push('E:\\ComfyUI\\output', 'C:\\ComfyUI\\output', 'D:\\ComfyUI\\output');
  return list;
}

/** 列出 output 里的音频文件（按时间倒序）。 */
export async function listOutputs(limit = 200) {
  for (const root of outputRoots()) {
    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = [];
    const scan = async (dir, subfolder) => {
      let list = [];
      try {
        list = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of list) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!AUDIO_EXT.has(ext)) continue;
        const info = await fs.stat(path.join(dir, entry.name)).catch(() => null);
        if (info) files.push({ name: entry.name, subfolder, size: info.size, mtime: info.mtimeMs });
      }
    };
    for (const entry of entries) {
      if (entry.isDirectory()) await scan(path.join(root, entry.name), entry.name);
      else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!AUDIO_EXT.has(ext)) continue;
        const info = await fs.stat(path.join(root, entry.name)).catch(() => null);
        if (info) files.push({ name: entry.name, subfolder: '', size: info.size, mtime: info.mtimeMs });
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return { root, files: files.slice(0, limit) };
  }
  return { root: null, files: [] };
}

export async function buildPrompt(opts = {}) {
  const spec = await loadSpec();
  const prompt = JSON.parse(JSON.stringify(spec.template));
  const knobs = spec.slots.knobs;

  const style = String(opts.style || '').trim();
  if (!style) throw new Error('曲风描述不能为空：写清流派、乐器、情绪，例如「Upbeat indie pop, warm female vocals, bright guitars」');
  prompt[knobs.style.node].inputs[knobs.style.input] = style;

  const lyrics = String(opts.lyrics || '').trim();
  if (!lyrics) throw new Error('歌词不能为空：用 [Verse] / [Chorus] 这类段落标记分行写');

  prompt[knobs.lyrics.node].inputs[knobs.lyrics.input] = lyrics;
  prompt[knobs.useAbc.node].inputs[knobs.useAbc.input] = opts.useAbc !== false;

  if (Array.isArray(knobs.mode.options) && knobs.mode.options.includes(String(opts.mode))) {
    prompt[knobs.mode.node].inputs[knobs.mode.input] = String(opts.mode);
  }

  prompt[knobs.duration.node].inputs[knobs.duration.input] =
    clamp(opts.duration, knobs.duration.min, knobs.duration.max, knobs.duration.default);

  prompt[knobs.steps.node].inputs[knobs.steps.input] =
    Math.round(clamp(opts.steps, knobs.steps.min, knobs.steps.max, knobs.steps.default));
  prompt[knobs.cfg.node].inputs[knobs.cfg.input] =
    clamp(opts.cfg, knobs.cfg.min, knobs.cfg.max, knobs.cfg.default);

  const rawSeed = opts.seed;
  const seedGiven = rawSeed !== undefined && rawSeed !== null && String(rawSeed).trim() !== '';
  const parsedSeed = seedGiven ? Number(rawSeed) : Number.NaN;
  const seed = Number.isFinite(parsedSeed) ? Math.trunc(parsedSeed) : Math.floor(Math.random() * 2 ** 32);
  prompt[knobs.seed.node].inputs[knobs.seed.input] = seed;

  const format = Array.isArray(knobs.format.options) && knobs.format.options.includes(String(opts.format))
    ? String(opts.format)
    : knobs.format.default;
  prompt[knobs.format.node].inputs[knobs.format.input] = format;
  const quality = String(opts.quality || '').trim();
  if (format !== 'flac') {
    // 动态格式必须带 quality 子字段，否则 SaveAudioAdvanced 会静默不产出
    prompt[knobs.format.node].inputs['format.quality'] = quality || (format === 'mp3' ? 'V0' : '128k');
  } else {
    delete prompt[knobs.format.node].inputs['format.quality'];
  }

  if (typeof opts.filenamePrefix === 'string' && opts.filenamePrefix.trim() !== '') {
    prompt[knobs.filenamePrefix.node].inputs[knobs.filenamePrefix.input] = opts.filenamePrefix.trim();
  }

  return {
    prompt,
    summary: {
      style,
      lyrics,
      duration: prompt[knobs.duration.node].inputs[knobs.duration.input],
      useAbc: prompt[knobs.useAbc.node].inputs[knobs.useAbc.input],
      mode: prompt[knobs.mode.node].inputs[knobs.mode.input],
      steps: prompt[knobs.steps.node].inputs[knobs.steps.input],
      cfg: prompt[knobs.cfg.node].inputs[knobs.cfg.input],
      seed,
      format,
      quality: quality || '',
      nodes: Object.keys(prompt).length,
    },
  };
}

export async function fetchAudio(client, entry) {
  const items = Object.values(entry.outputs || {}).flatMap((o) => o.audio || []);
  if (items.length === 0) throw new Error('这次执行没有产出音频');
  const item = items[0];
  const url = client.host + '/view?filename=' + encodeURIComponent(item.filename)
    + '&subfolder=' + encodeURIComponent(item.subfolder || '')
    + '&type=' + encodeURIComponent(item.type || 'output');
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error('取音频失败：HTTP ' + res.status);
  return { buffer: Buffer.from(await res.arrayBuffer()), filename: item.filename };
}

export async function run(client, opts = {}, hooks = {}) {
  const { prompt, summary } = await buildPrompt(opts);
  const promptId = await client.submit(prompt);
  if (hooks.onSubmit) hooks.onSubmit(promptId, summary);
  const entry = await client.wait(promptId, opts.timeoutMs || 3600000, (seconds) => {
    if (hooks.onTick) hooks.onTick(seconds, promptId);
  });
  const audio = await fetchAudio(client, entry);
  return { audio, promptId, summary };
}

export function friendlyError(error) {
  const raw = String((error && error.message) || error || '');
  const hint = (text) => `${text}｜原始信息：${raw.replace(/\s+/g, ' ').slice(0, 500)}`;

  if (/out of memory|not enough memory|allocation on device/i.test(raw)) {
    return hint('显存不足：把「最长时长」调短（比如 60 秒），或减少步数');
  }
  if (/prompt outputs failed validation|node_errors/i.test(raw)) {
    return hint('工作流校验失败：通常是歌词/曲风为空，或时长越界');
  }
  if (/yue2|checkpoint/i.test(raw) && /not in|value not in list/i.test(raw)) {
    return hint('YuE2 检查点不在位：把 yue2_3b_int8_convrot.safetensors 放到 models/checkpoints/');
  }
  if (/cuda/i.test(raw)) {
    return hint('CUDA 报错：显卡驱动或显存状态异常，可重启 ComfyUI 再试');
  }
  if (/超时|timeout/i.test(raw)) {
    return hint('等待超时：长曲目（120 秒以上）可能要好几分钟');
  }
  return raw.slice(0, 800) || '未知错误';
}

const MIME_BY_EXT = {
  '.flac': 'audio/flac',
  '.mp3': 'audio/mpeg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
};

export function mimeOf(file) {
  return MIME_BY_EXT[path.extname(String(file || '')).toLowerCase()] || 'application/octet-stream';
}

export async function saveAudio(dataDir, jobId, audio) {
  const dir = path.join(dataDir, 'audio');
  await fs.mkdir(dir, { recursive: true });
  const ext = path.extname(audio.filename || '.flac') || '.flac';
  const file = path.join(dir, jobId + ext);
  await fs.writeFile(file, audio.buffer);
  return file;
}

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
    } catch { /* 首次运行 */ }
  }

  async persist() {
    const list = [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_JOBS);
    this.jobs = new Map(list.map((job) => [job.id, job]));
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(list, null, 2), 'utf8');
  }

  create(params) {
    const id = 'mu_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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
