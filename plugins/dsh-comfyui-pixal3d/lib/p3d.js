/**
 * Pixal3D 四视图转 3D 核心：模板装配 + 图片尺寸探测 + 提交轮询 + 产物保存。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyModelOverrides } from './models.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.join(HERE, '..', 'workflows');
const MAX_JOBS = 40;

export async function loadSpec() {
  const template = JSON.parse(await fs.readFile(path.join(WORKFLOW_DIR, 'pixal3d_multiview.api.json'), 'utf8'));
  const slots = JSON.parse(await fs.readFile(path.join(WORKFLOW_DIR, 'pixal3d_multiview.slots.json'), 'utf8'));
  return { template, slots };
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

/** 从 PNG / JPEG 头部读出宽高。 */
export function imageSize(buffer) {
  try {
    if (buffer.length > 24 && buffer.readUInt32BE(0) === 0x89504e47) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset += 1; continue; }
        const marker = buffer[offset + 1];
        const length = buffer.readUInt16BE(offset + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }
        offset += 2 + length;
      }
    }
  } catch { /* 忽略 */ }
  return null;
}

/** 从 ComfyUI 拿 input 里的图，读尺寸。 */
export async function fetchImageSize(client, name) {
  try {
    const url = client.host + '/view?filename=' + encodeURIComponent(name) + '&type=input';
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return imageSize(buf);
  } catch {
    return null;
  }
}

export async function buildPrompt(opts = {}, client) {
  const spec = await loadSpec();
  const prompt = JSON.parse(JSON.stringify(spec.template));
  const knobs = spec.slots.knobs;

  const image = String(opts.image || '').trim();
  if (!image) throw new Error('还没有四视图图：先上传一张，或从 output 里选一张');
  prompt[knobs.image.node].inputs[knobs.image.input] = image;

  // 四视图切分
  const layout = String(opts.layout || knobs.layout.default);
  if (layout === 'quarters' && client) {
    const size = await fetchImageSize(client, image);
    if (size && size.width > 0) {
      const w = Math.floor(size.width / 4);
      spec.slots.cropNodes.forEach((nodeId, i) => {
        prompt[nodeId].inputs.crop_region = { x: i * w, y: 0, width: w, height: size.height };
      });
    }
  }

  const rawSeed = opts.seed;
  const seedGiven = rawSeed !== undefined && rawSeed !== null && String(rawSeed).trim() !== '';
  const parsedSeed = seedGiven ? Number(rawSeed) : Number.NaN;
  const seed = Number.isFinite(parsedSeed) ? Math.trunc(parsedSeed) : Math.floor(Math.random() * 2 ** 32);
  for (const nodeId of ['3', '12', '18', '23']) prompt[nodeId].inputs.seed = seed;

  const setInt = (key, value) => {
    const k = knobs[key];
    prompt[k.node].inputs[k.input] = Math.round(clamp(value, k.min, k.max, k.default));
  };
  setInt('shapeSteps', opts.shapeSteps);
  setInt('textureSteps', opts.textureSteps);
  setInt('voxelSteps', opts.voxelSteps);
  setInt('structureSteps', opts.structureSteps);
  setInt('resolution', opts.resolution);
  setInt('remesh', opts.remesh);
  setInt('textureSize', opts.textureSize);

  const k = knobs.shapeCfg;
  prompt[k.node].inputs[k.input] = clamp(opts.shapeCfg, k.min, k.max, k.default);
  const t = knobs.threshold;
  prompt[t.node].inputs[t.input] = clamp(opts.threshold, t.min, t.max, t.default);

  if (typeof opts.filenamePrefix === 'string' && opts.filenamePrefix.trim() !== '') {
    prompt[knobs.filenamePrefix.node].inputs[knobs.filenamePrefix.input] = opts.filenamePrefix.trim();
  }

  applyModelOverrides(prompt, opts.models);

  return {
    prompt,
    summary: {
      image,
      layout,
      seed,
      shapeSteps: prompt['18'].inputs.steps,
      textureSteps: prompt['12'].inputs.steps,
      resolution: prompt['94'].inputs.target_resolution,
      remesh: prompt['241'].inputs.resolution,
      textureSize: prompt['288'].inputs.value,
      nodes: Object.keys(prompt).length,
    },
  };
}

/** 取 Save3DAdvanced 产出的 3D 文件（优先取保存节点，别拿预览节点的临时文件）。 */
export async function fetchModel(client, entry, saveNode = '372') {
  const outputs = entry.outputs || {};
  const preferred = (outputs[saveNode] && outputs[saveNode]['3d']) || [];
  const all = Object.values(outputs).flatMap((o) => o['3d'] || []);
  const pool = preferred.length ? preferred : all;
  const first = pool.find((x) => x && x.filename && x.type === 'output')
    || pool.find((x) => x && x.filename && x.type !== 'temp')
    || pool.find((x) => x && x.filename);
  if (!first) throw new Error('这次执行没有产出 3D 文件');
  const url = client.host + '/view?filename=' + encodeURIComponent(first.filename)
    + '&subfolder=' + encodeURIComponent(first.subfolder || '')
    + '&type=' + encodeURIComponent(first.type || 'output');
  const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error('下载 3D 文件失败：HTTP ' + res.status);
  return { buffer: Buffer.from(await res.arrayBuffer()), filename: first.filename, subfolder: first.subfolder || '' };
}

export async function run(client, opts = {}, hooks = {}) {
  const { prompt, summary } = await buildPrompt(opts, client);
  const promptId = await client.submit(prompt);
  if (hooks.onSubmit) hooks.onSubmit(promptId, summary);
  const entry = await client.wait(promptId, opts.timeoutMs || 3600000, (seconds) => {
    if (hooks.onTick) hooks.onTick(seconds, promptId);
  });
  const model = await fetchModel(client, entry, (await loadSpec()).slots.output.saveNode);
  return { model, promptId, summary };
}

export function friendlyError(error) {
  const raw = String((error && error.message) || error || '');
  const hint = (text) => `${text}｜原始信息：${raw.replace(/\s+/g, ' ').slice(0, 500)}`;

  if (/out of memory|not enough memory|allocation on device/i.test(raw)) {
    return hint('显存不足：把「上采样分辨率」降到 1024、「重网格」降到 512 再试');
  }
  if (/prompt outputs failed validation|node_errors/i.test(raw)) {
    return hint('工作流校验失败：通常是图没进 input 目录，或切分坐标超出图片范围');
  }
  if (/pixal3d|trellis|dino|birefnet/i.test(raw) && /not in|value not in list/i.test(raw)) {
    return hint('模型文件不在位：pixal3d unet / dino clip / trellis 两个 vae / birefnet 缺一个');
  }
  if (/cuda/i.test(raw)) {
    return hint('CUDA 报错：显存或驱动异常，可重启 ComfyUI 再试');
  }
  if (/超时|timeout/i.test(raw)) {
    return hint('等待超时：这套流程通常 2–8 分钟，分辨率越高越久');
  }
  return raw.slice(0, 800) || '未知错误';
}

const MIME_BY_EXT = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.fbx': 'application/octet-stream',
  '.obj': 'text/plain',
  '.stl': 'model/stl',
  '.usdz': 'model/vnd.usdz+zip',
  '.ply': 'application/octet-stream',
};

export function mimeOf(file) {
  return MIME_BY_EXT[path.extname(String(file || '')).toLowerCase()] || 'application/octet-stream';
}

export async function saveModel(dataDir, jobId, model) {
  const dir = path.join(dataDir, 'mesh');
  await fs.mkdir(dir, { recursive: true });
  const ext = path.extname(model.filename || '.glb') || '.glb';
  const file = path.join(dir, jobId + ext);
  await fs.writeFile(file, model.buffer);
  return file;
}

/** 列表 output 里的图片（供选输入用）。 */
export async function listImages(limit = 120) {
  const exts = new Set(['.png', '.jpg', '.jpeg', '.webp']);
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
        if (!exts.has(path.extname(entry.name).toLowerCase())) continue;
        const info = await fs.stat(path.join(dir, entry.name)).catch(() => null);
        if (info) files.push({ name: entry.name, subfolder, size: info.size, mtime: info.mtimeMs });
      }
    };
    for (const entry of entries) {
      if (entry.isDirectory()) await scan(path.join(root, entry.name), entry.name);
      else if (entry.isFile()) {
        if (!exts.has(path.extname(entry.name).toLowerCase())) continue;
        const info = await fs.stat(path.join(root, entry.name)).catch(() => null);
        if (info) files.push({ name: entry.name, subfolder: '', size: info.size, mtime: info.mtimeMs });
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return { root, files: files.slice(0, limit) };
  }
  return { root: null, files: [] };
}

/** 列表 output 里的 3D 文件。 */
export async function listOutputs(limit = 100) {
  const exts = new Set(['.glb', '.gltf', '.fbx', '.obj', '.stl', '.usdz']);
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
        if (!exts.has(path.extname(entry.name).toLowerCase())) continue;
        const info = await fs.stat(path.join(dir, entry.name)).catch(() => null);
        if (info) files.push({ name: entry.name, subfolder, size: info.size, mtime: info.mtimeMs });
      }
    };
    for (const entry of entries) {
      if (entry.isDirectory()) await scan(path.join(root, entry.name), entry.name);
      else if (entry.isFile()) {
        if (!exts.has(path.extname(entry.name).toLowerCase())) continue;
        const info = await fs.stat(path.join(root, entry.name)).catch(() => null);
        if (info) files.push({ name: entry.name, subfolder: '', size: info.size, mtime: info.mtimeMs });
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return { root, files: files.slice(0, limit) };
  }
  return { root: null, files: [] };
}

const MAX_JOBS_LIMIT = MAX_JOBS;

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
    const list = [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_JOBS_LIMIT);
    this.jobs = new Map(list.map((job) => [job.id, job]));
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(list, null, 2), 'utf8');
  }

  create(params) {
    const id = 'px_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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
