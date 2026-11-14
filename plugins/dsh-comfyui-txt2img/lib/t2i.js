/**
 * 文生图（Krea2 Turbo）核心：模板装配 + 提交轮询 + 多图取回 + 任务记录。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyModelOverrides } from './models.js';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.join(HERE, '..', 'workflows');

let cached = null;
let loraCache = { at: 0, list: [] };

/** 从 ComfyUI 读当前可用的 LoRA 列表（30 秒缓存）。读不到就返回空数组，不阻断生成。 */
export async function availableLoras(host = 'http://127.0.0.1:8188') {
  if (Date.now() - loraCache.at < 30000 && loraCache.list.length) return loraCache.list;
  try {
    const res = await fetch(host.replace(/\/+$/, '') + '/object_info/LoraLoaderModelOnly', { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return loraCache.list;
    const data = await res.json();
    const list = data?.LoraLoaderModelOnly?.input?.required?.lora_name?.[0];
    if (Array.isArray(list)) {
      loraCache = { at: Date.now(), list };
      return list;
    }
  } catch { /* 离线时不校验 */ }
  return loraCache.list;
}

export async function loadSpec() {
  if (cached) return cached;
  const template = JSON.parse(await fs.readFile(path.join(WORKFLOW_DIR, 'krea2_turbo_t2i.api.json'), 'utf8'));
  const slots = JSON.parse(await fs.readFile(path.join(WORKFLOW_DIR, 'krea2_turbo_t2i.slots.json'), 'utf8'));
  cached = { template, slots };
  return cached;
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

  const text = String(opts.prompt || '').trim();
  if (!text) throw new Error('prompt 不能为空');
  prompt[knobs.prompt.node].inputs[knobs.prompt.input] = text;

  const aspect = String(opts.aspectRatio || knobs.aspectRatio.options[0]);
  if (!knobs.aspectRatio.options.includes(aspect)) throw new Error(`aspectRatio 不在可选范围内：${aspect}`);
  prompt[knobs.aspectRatio.node].inputs[knobs.aspectRatio.input] = aspect;

  prompt[knobs.megapixels.node].inputs[knobs.megapixels.input] =
    clamp(opts.megapixels, knobs.megapixels.min, knobs.megapixels.max, knobs.megapixels.default);

  prompt[knobs.batchSize.node].inputs[knobs.batchSize.input] =
    Math.round(clamp(opts.batchSize, knobs.batchSize.min, knobs.batchSize.max, knobs.batchSize.default));

  prompt[knobs.steps.node].inputs[knobs.steps.input] =
    Math.round(clamp(opts.steps, knobs.steps.min, knobs.steps.max, knobs.steps.default));

  prompt[knobs.cfg.node].inputs[knobs.cfg.input] =
    clamp(opts.cfg, knobs.cfg.min, knobs.cfg.max, knobs.cfg.default);

  // 种子：空串 / null / 非数字都算「随机」
  const rawSeed = opts.seed;
  const seedGiven = rawSeed !== undefined && rawSeed !== null && String(rawSeed).trim() !== '';
  const parsedSeed = seedGiven ? Number(rawSeed) : Number.NaN;
  const seed = Number.isFinite(parsedSeed) ? Math.trunc(parsedSeed) : Math.floor(Math.random() * 2 ** 48);
  prompt[knobs.seed.node].inputs[knobs.seed.input] = seed;

  prompt[knobs.expand.node].inputs[knobs.expand.input] = opts.expand !== false;

  // LoRA 与风格后缀已解耦；旧的 style 单开关仍然兼容（等同两个都开）
  const legacy = opts.style === true;
  prompt[knobs.loraEnabled.node].inputs[knobs.loraEnabled.input] = opts.loraEnabled === true || legacy;
  prompt[knobs.suffixEnabled.node].inputs[knobs.suffixEnabled.input] = opts.suffixEnabled === true || legacy;

  const loraName = String(opts.loraName || knobs.loraName.default);
  const live = await availableLoras(opts.host);
  if (live.length && !live.includes(loraName)) {
    throw new Error(`LoRA 不存在：${loraName}｜ComfyUI 当前能认到 ${live.length} 个：${live.slice(0, 6).join(', ')}（新加的文件需要重启 ComfyUI 才会出现）`);
  }

  // 后缀：只在显式传入时写；默认留空（由「AI 润化」生成或用户手填）
  if (typeof opts.styleSuffix === 'string') {
    prompt[knobs.styleSuffix.node].inputs[knobs.styleSuffix.input] = opts.styleSuffix;
  }
  if (typeof opts.expandInstruction === 'string' && opts.expandInstruction.trim() !== '') {
    prompt[knobs.expandInstruction.node].inputs[knobs.expandInstruction.input] = opts.expandInstruction;
  }

  prompt[knobs.loraName.node].inputs[knobs.loraName.input] = loraName;
  prompt[knobs.loraStrength.node].inputs[knobs.loraStrength.input] =
    clamp(opts.loraStrength, knobs.loraStrength.min, knobs.loraStrength.max, knobs.loraStrength.default);

  const summary = {
    prompt: text,
    aspectRatio: aspect,
    megapixels: prompt[knobs.megapixels.node].inputs[knobs.megapixels.input],
    batchSize: prompt[knobs.batchSize.node].inputs[knobs.batchSize.input],
    steps: prompt[knobs.steps.node].inputs[knobs.steps.input],
    cfg: prompt[knobs.cfg.node].inputs[knobs.cfg.input],
    seed,
    expand: opts.expand !== false,
    loraEnabled: prompt[knobs.loraEnabled.node].inputs[knobs.loraEnabled.input],
    suffixEnabled: prompt[knobs.suffixEnabled.node].inputs[knobs.suffixEnabled.input],
    loraName,
    loraStrength: prompt[knobs.loraStrength.node].inputs[knobs.loraStrength.input],
    nodes: Object.keys(prompt).length,
  };
  return { prompt, summary };
}

/** 从 history 条目里取回全部图片（batch_size 可能 > 1）。 */
export async function fetchAllImages(client, entry) {
  const items = Object.values(entry.outputs || {}).flatMap((o) => o.images || []);
  const out = [];
  for (const item of items) {
    const url = client.host + '/view?filename=' + encodeURIComponent(item.filename)
      + '&subfolder=' + encodeURIComponent(item.subfolder || '')
      + '&type=' + encodeURIComponent(item.type || 'output');
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (res.ok) out.push({ buffer: Buffer.from(await res.arrayBuffer()), filename: item.filename });
  }
  if (out.length === 0) throw new Error('这次执行没有产出图片');
  return out;
}

export async function run(client, opts = {}, hooks = {}) {
  const { prompt, summary } = await buildPrompt(opts);
  applyModelOverrides(prompt, opts.models);
  const promptId = await client.submit(prompt);
  if (hooks.onSubmit) hooks.onSubmit(promptId, summary);
  const entry = await client.wait(promptId, opts.timeoutMs || 1800000, (seconds) => {
    if (hooks.onTick) hooks.onTick(seconds, promptId);
  });
  const images = await fetchAllImages(client, entry);

  // 扩写后的提示词：PreviewAny 节点把透传的文本放进了 outputs
  let expanded = '';
  try {
    const spec = await loadSpec();
    const nodeId = spec.slots.output && spec.slots.output.previewNode;
    if (nodeId) {
      const text = entry?.outputs?.[nodeId]?.text;
      if (Array.isArray(text) && typeof text[0] === 'string') expanded = text[0];
    }
  } catch { /* 拿不到就算了，不影响出图 */ }

  return { images, promptId, summary, expanded };
}

export function friendlyError(error) {
  const raw = String((error && error.message) || error || '');
  const hint = (text) => `${text}｜原始信息：${raw.replace(/\s+/g, ' ').slice(0, 500)}`;

  if (/out of memory|not enough memory|allocation on device|cuda error: out of memory/i.test(raw)) {
    return hint('显存不足（OOM）：降低像素(megapixels)或张数再试');
  }
  if (/prompt outputs failed validation|node_errors/i.test(raw)) {
    return hint('工作流校验失败：通常是参数越界，或模型文件不在位');
  }
  if (/no such file|file not found|cannot find|not in input/i.test(raw)) {
    return hint('找不到文件：模型或素材文件名不对（先看 ComfyUI 控制台缺哪个）');
  }
  if (/cuda/i.test(raw)) {
    return hint('CUDA 报错：显卡驱动或显存状态异常，可重启 ComfyUI 再试');
  }
  if (/超时|timeout/i.test(raw)) {
    return hint('等待超时：任务可能还在 ComfyUI 队列里跑');
  }
  return raw.slice(0, 800) || '未知错误';
}

export async function saveImages(dataDir, jobId, images) {
  const dir = path.join(dataDir, 'images');
  await fs.mkdir(dir, { recursive: true });
  const files = [];
  for (let i = 0; i < images.length; i += 1) {
    const ext = path.extname(images[i].filename || '.png') || '.png';
    const file = path.join(dir, `${jobId}-${i}${ext}`);
    await fs.writeFile(file, images[i].buffer);
    files.push(file);
  }
  return files;
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
    } catch { /* 首次运行没有文件 */ }
  }

  async persist() {
    const list = [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_JOBS);
    this.jobs = new Map(list.map((job) => [job.id, job]));
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(list, null, 2), 'utf8');
  }

  create(params) {
    const id = 't2i_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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
