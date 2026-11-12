/**
 * 图片编辑（Qwen-Image 2.1）核心：模板装配 + 提交轮询 + 任务记录。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.join(HERE, '..', 'workflows');

let cached = null;

export async function loadSpec() {
  if (cached) return cached;
  const template = JSON.parse(await fs.readFile(path.join(WORKFLOW_DIR, 'qwen_image_edit.api.json'), 'utf8'));
  const slots = JSON.parse(await fs.readFile(path.join(WORKFLOW_DIR, 'qwen_image_edit.slots.json'), 'utf8'));
  cached = { template, slots };
  return cached;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const KIND_EXT = { images: new Set(['.png', '.jpg', '.jpeg', '.webp']) };

function outputRoots() {
  const list = [];
  const env = process.env.DSH_COMFY_OUTPUT_DIR;
  if (env) list.push(env);
  const local = process.env.LOCALAPPDATA || '';
  if (local) list.push(path.join(local, 'Comfy-Desktop', 'ComfyUI-Shared', 'output'));
  list.push('E:\\ComfyUI\\output', 'C:\\ComfyUI\\output', 'D:\\ComfyUI\\output');
  return list;
}

/** 列出 output 目录里的图片（按时间倒序）。 */
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
        if (!KIND_EXT.images.has(ext)) continue;
        const info = await fs.stat(path.join(dir, entry.name)).catch(() => null);
        if (info) files.push({ name: entry.name, subfolder, size: info.size, mtime: info.mtimeMs });
      }
    };
    for (const entry of entries) {
      if (entry.isDirectory()) await collect(path.join(root, entry.name), entry.name);
      else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!KIND_EXT.images.has(ext)) continue;
        const info = await fs.stat(path.join(root, entry.name)).catch(() => null);
        if (info) files.push({ name: entry.name, subfolder: '', size: info.size, mtime: info.mtimeMs });
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return { root, files: files.slice(0, limit) };
  }
  return { root: null, files: [] };
}

/** 把 output 里的图片复制进 input，返回 input 里的文件名。 */
export async function importFromOutput(client, name, subfolder = '') {
  const safeName = String(name || '').replace(/^.*[\\/]/, '');
  if (!safeName) throw new Error('没有指定文件名');
  const ext = path.extname(safeName).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
  for (const root of outputRoots()) {
    const full = path.join(root, String(subfolder || ''), safeName);
    let buffer;
    try {
      buffer = await fs.readFile(full);
    } catch {
      continue;
    }
    return client.upload(buffer, safeName, mime);
  }
  throw new Error(`在 output 目录里找不到 ${subfolder ? subfolder + '/' : ''}${safeName}`);
}

export async function buildPrompt(opts = {}) {
  const spec = await loadSpec();
  const prompt = JSON.parse(JSON.stringify(spec.template));
  const knobs = spec.slots.knobs;

  const image = String(opts.image || '').trim();
  if (!image) throw new Error('还没有主体图：先上传一张，或从 output 里选一张');
  prompt[knobs.image.node].inputs[knobs.image.input] = image;

  const text = String(opts.prompt || '').trim();
  if (!text) throw new Error('编辑指令不能为空：说清楚要改什么，例如「把衣服换成浅蓝色牛仔衬衫」');
  prompt[knobs.prompt.node].inputs[knobs.prompt.input] = text;
  prompt[knobs.enhancePrompt.node].inputs[knobs.enhancePrompt.input] = text;

  const enhance = opts.enhance === true;
  prompt[knobs.enhance.node].inputs[knobs.enhance.input] = enhance;

  if (typeof opts.negative === 'string') {
    prompt[knobs.negative.node].inputs[knobs.negative.input] = opts.negative;
  }

  // 参考图：最多 4 张。第 1 张复用模板自带的 475，其余动态建 900+ 的 LoadImage
  const refs = [];
  const pushRef = (value) => {
    const v = String(value || '').trim();
    if (v) refs.push(v);
  };
  if (Array.isArray(opts.refs)) opts.refs.forEach(pushRef);
  if (opts.image2) pushRef(opts.image2);
  if (refs.length > 9) throw new Error(`参考图最多 9 张（连底图共 10 张），收到 ${refs.length} 张`);

  const encodeNode = prompt['459:474'];
  const batchNode = prompt['459:485'];

  // 先清掉模板里的参考图接线
  for (const key of Object.keys(encodeNode.inputs)) {
    if (key.startsWith('images.image_')) delete encodeNode.inputs[key];
  }
  encodeNode.inputs['images.image_1'] = ['470', 0];

  if (refs.length > 0) {
    prompt['475'].inputs['image'] = refs[0];
    encodeNode.inputs['images.image_2'] = ['475', 0];
    batchNode.inputs['images.image1'] = ['475', 0];
  } else {
    delete prompt['475'];
    delete batchNode.inputs['images.image1'];
  }

  for (let i = 1; i < refs.length; i += 1) {
    const nodeId = String(900 + i - 1);
    prompt[nodeId] = { class_type: 'LoadImage', inputs: { image: refs[i] } };
    encodeNode.inputs['images.image_' + (i + 2)] = [nodeId, 0];
    batchNode.inputs['images.image' + (i + 1)] = [nodeId, 0];
  }

  prompt[knobs.steps.node].inputs[knobs.steps.input] =
    Math.round(clamp(opts.steps, knobs.steps.min, knobs.steps.max, knobs.steps.default));
  prompt[knobs.cfg.node].inputs[knobs.cfg.input] =
    clamp(opts.cfg, knobs.cfg.min, knobs.cfg.max, knobs.cfg.default);

  const rawSeed = opts.seed;
  const seedGiven = rawSeed !== undefined && rawSeed !== null && String(rawSeed).trim() !== '';
  const parsedSeed = seedGiven ? Number(rawSeed) : Number.NaN;
  const seed = Number.isFinite(parsedSeed) ? Math.trunc(parsedSeed) : Math.floor(Math.random() * 2 ** 48);
  prompt[knobs.seed.node].inputs[knobs.seed.input] = seed;

  if (Number.isFinite(Number(opts.resolution))) {
    prompt[knobs.resolution.node].inputs[knobs.resolution.input] =
      Math.round(clamp(opts.resolution, knobs.resolution.min, knobs.resolution.max, knobs.resolution.default));
  }

  const fixed = opts.fixedSize === true;
  prompt[knobs.fixedSize.node].inputs[knobs.fixedSize.input] = fixed;
  if (fixed) {
    prompt[knobs.width.node].inputs[knobs.width.input] =
      Math.round(clamp(opts.width, knobs.width.min, knobs.width.max, knobs.width.default));
    prompt[knobs.height.node].inputs[knobs.height.input] =
      Math.round(clamp(opts.height, knobs.height.min, knobs.height.max, knobs.height.default));
  }

  if (typeof opts.filenamePrefix === 'string' && opts.filenamePrefix.trim() !== '') {
    prompt[knobs.filenamePrefix.node].inputs[knobs.filenamePrefix.input] = opts.filenamePrefix;
  }

  return {
    prompt,
    summary: {
      image,
      refs: refs.slice(),
      prompt: text,
      enhance,
      steps: prompt[knobs.steps.node].inputs[knobs.steps.input],
      cfg: prompt[knobs.cfg.node].inputs[knobs.cfg.input],
      seed,
      fixedSize: fixed,
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
    if (res.ok) out.push({ buffer: Buffer.from(await res.arrayBuffer()), filename: item.filename });
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

  if (/out of memory|not enough memory|allocation on device/i.test(raw)) {
    return hint('显存不足（OOM）：降低像素或改用「按输入图尺寸」再试');
  }
  if (/prompt outputs failed validation|node_errors/i.test(raw)) {
    return hint('工作流校验失败：通常是图片文件名不在 input 目录，或参数越界');
  }
  if (/qwen/i.test(raw) && /not in|value not in list/i.test(raw)) {
    return hint('Qwen-Image 2.1 的模型文件不在位，检查 diffusion_models / text_encoders / vae 三个目录');
  }
  if (/cuda/i.test(raw)) {
    return hint('CUDA 报错：显卡驱动或显存状态异常，可重启 ComfyUI 再试');
  }
  if (/超时|timeout/i.test(raw)) {
    return hint('等待超时：25 步的编辑任务较慢，可能还在队列里跑');
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
    const id = 'ie_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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
