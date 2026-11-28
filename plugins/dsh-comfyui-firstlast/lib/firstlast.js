/**
 * 首尾帧生视频（MiniMax H3 i2v）的核心：把参数注入模板，产出可 POST /prompt 的 API JSON。
 *
 * 这个插件只有一条路：给定首帧（必填）与尾帧（可选），中间由模型补出来。
 * 模板来自用户导入的 `video_minimax_h3_i2v.json`，只把示例图片换成占位、补了一个 last_frame 槽位。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyModelOverrides } from './models.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.join(HERE, '..', 'workflows');

export async function loadSpec() {
  const api = JSON.parse(await fs.readFile(path.join(WORKFLOW_DIR, 'minimax_h3_firstlast.api.json'), 'utf8'));
  const slots = JSON.parse(await fs.readFile(path.join(WORKFLOW_DIR, 'minimax_h3_firstlast.slots.json'), 'utf8'));
  return { template: api, slots };
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * H3 的视频长度必须是 17n+5 帧。
 * 5 秒 → 120 帧 → 对齐 124；这个函数与模板里的 ComfyMathExpression 完全等价。
 */
export function framesForSeconds(seconds) {
  const n = Math.max(5, Math.round(Number(seconds) * 24));
  return n + (5 - (n % 17)) % 17;
}

/** 把调用参数注入模板。summary 只用于回显。 */
export async function buildPrompt(opts = {}) {
  const spec = await loadSpec();
  const knobs = spec.slots.knobs;
  const targetId = spec.slots.target;
  const prompt = JSON.parse(JSON.stringify(spec.template));
  if (!prompt[targetId]) throw new Error(`模板缺少目标节点 ${targetId}（MiniMaxH3ImageToVideo）`);

  const text = String(opts.prompt || '').trim();
  if (!text) throw new Error('prompt 不能为空：这里描述"从首帧到尾帧之间发生了什么"');
  prompt[targetId].inputs.prompt = text;

  // 首帧必填：没有首帧就不是首尾帧生视频，直接拦下来，不要让 ComfyUI 拿占位图去跑。
  const first = String(opts.firstFrame || '').trim();
  if (!first) throw new Error('缺少 firstFrame：必须给一张首帧图（ComfyUI input 里的文件名，或本机绝对路径）');
  prompt[spec.slots.slots.firstFrame.loadNode].inputs.image = first;

  // 尾帧可选：给了就接上，没给就把 last_frame 摘掉（否则会拿占位图当尾帧）。
  const last = String(opts.lastFrame || '').trim();
  if (last) prompt[spec.slots.slots.lastFrame.loadNode].inputs.image = last;
  else delete prompt[targetId].inputs.last_frame;

  const aspect = String(opts.aspectRatio || knobs.aspectRatio.default);
  if (!knobs.aspectRatio.options.includes(aspect)) throw new Error(`比例不支持：${aspect}`);
  prompt[knobs.aspectRatio.node].inputs[knobs.aspectRatio.input] = aspect;

  const megapixels = clamp(opts.megapixels, knobs.megapixels.min, knobs.megapixels.max, knobs.megapixels.default);
  prompt[knobs.megapixels.node].inputs[knobs.megapixels.input] = megapixels;

  const inputMegapixels = clamp(opts.inputMegapixels, knobs.inputMegapixels.min, knobs.inputMegapixels.max, knobs.inputMegapixels.default);
  prompt[knobs.inputMegapixels.node].inputs[knobs.inputMegapixels.input] = inputMegapixels;

  const seconds = clamp(opts.durationSeconds, knobs.durationSeconds.min, knobs.durationSeconds.max, knobs.durationSeconds.default);
  prompt[knobs.durationSeconds.node].inputs[knobs.durationSeconds.input] = seconds;
  const frames = framesForSeconds(seconds);

  const rawSeed = opts.seed;
  const seedGiven = rawSeed !== undefined && rawSeed !== null && String(rawSeed).trim() !== '';
  const parsed = seedGiven ? Number(rawSeed) : Number.NaN;
  const seed = Number.isFinite(parsed) ? Math.trunc(parsed) : Math.floor(Math.random() * 2 ** 48);
  prompt[knobs.seed.node].inputs[knobs.seed.input] = seed;

  const lightning = opts.lightning !== false;
  prompt[knobs.lightning.node].inputs[knobs.lightning.input] = lightning;
  if (knobs.stepsFast) prompt[knobs.stepsFast.node].inputs[knobs.stepsFast.input] = Math.trunc(clamp(opts.stepsFast, 1, 12, knobs.stepsFast.default));
  if (knobs.stepsFull) prompt[knobs.stepsFull.node].inputs[knobs.stepsFull.input] = Math.trunc(clamp(opts.stepsFull, 4, 60, knobs.stepsFull.default));

  const lora = String(opts.lora || knobs.lora.default);
  if (!knobs.lora.options.includes(lora)) throw new Error(`LoRA 不在可选项里：${lora}`);
  prompt[knobs.lora.node].inputs[knobs.lora.input] = lora;

  if (opts.unet) {
    const unet = String(opts.unet);
    prompt[knobs.unet.node].inputs[knobs.unet.input] = unet;
  }

  // 面板顶部那排模型下拉：{ 节点id: { 输入名: 值 } }，直接覆盖模板里的 loader
  if (opts.models && typeof opts.models === 'object') applyModelOverrides(prompt, opts.models);

  return {
    prompt,
    summary: {
      prompt: text,
      firstFrame: first,
      lastFrame: last || null,
      aspectRatio: aspect,
      megapixels,
      inputMegapixels,
      durationSeconds: seconds,
      frames,
      fps: 24,
      seed,
      lightning,
      lora,
      nodes: Object.keys(prompt).length,
    },
  };
}

/** 提交并等待，返回产物 Buffer。 */
export async function run(client, opts = {}, hooks = {}) {
  const { prompt, summary } = await buildPrompt(opts);
  const promptId = await client.submit(prompt);
  if (hooks.onSubmit) hooks.onSubmit(promptId, summary);
  const entry = await client.wait(promptId, opts.timeoutMs || 3600000, (seconds) => {
    if (hooks.onTick) hooks.onTick(seconds, promptId, summary);
  });
  const out = await client.fetchOutput(entry);
  return { buffer: out.buffer, filename: out.filename, subfolder: out.subfolder, promptId, summary };
}
