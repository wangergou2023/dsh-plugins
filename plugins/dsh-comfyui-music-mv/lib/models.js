/**
 * 通用的「模型清单」模块：从工作流模板里找出所有加载器，列出当前值与可选项。
 * 不针对具体插件，任何模板都能用。
 */
import path from 'node:path';

const MODEL_EXT = /\.(safetensors|ckpt|pt|pth|bin|gguf|onnx)$/i;
const LOADER_FIELDS = new Set([
  'ckpt_name', 'unet_name', 'clip_name', 'clip_name1', 'clip_name2', 'clip_name3',
  'vae_name', 'lora_name', 'model_name', 'diffusion_model', 'control_net_name',
  'upscale_model', 'style_model_name', 'gligen_name',
]);

const cache = new Map(); // host -> { at, info: Map<class, spec|null> }

async function classInfo(host, className) {
  let bucket = cache.get(host);
  if (!bucket || Date.now() - bucket.at > 60000) {
    bucket = { at: Date.now(), info: new Map() };
    cache.set(host, bucket);
  }
  if (bucket.info.has(className)) return bucket.info.get(className);
  let spec = null;
  try {
    const res = await fetch(host + '/object_info/' + encodeURIComponent(className), { signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const json = await res.json();
      spec = json && json[className] ? json[className] : null;
    }
  } catch { /* 连不上就当没有 */ }
  bucket.info.set(className, spec);
  return spec;
}

/** 从模板里扫出所有「模型型」输入。 */
export async function scanModels(template, host = 'http://127.0.0.1:8188') {
  const entries = [];
  const nodes = Object.entries(template || {});
  for (const [nodeId, node] of nodes) {
    const className = node && node.class_type;
    if (!className) continue;
    const spec = await classInfo(host, className);
    if (!spec) continue;
    const inputs = { ...(spec.input?.required || {}), ...(spec.input?.optional || {}) };
    for (const [field, def] of Object.entries(inputs)) {
      const options = Array.isArray(def && def[0])
        ? def[0]
        : (def && def[1] && Array.isArray(def[1].options)
          ? def[1].options.map((o) => (o && typeof o === 'object' ? o.key : o))
          : null);
      if (!options || options.length === 0) continue;
      const isLoaderField = LOADER_FIELDS.has(field);
      const looksLikeFile = options.some((o) => MODEL_EXT.test(String(o)));
      if (!isLoaderField && !looksLikeFile) continue;
      const current = node.inputs && node.inputs[field];
      entries.push({
        node: nodeId,
        class_type: className,
        field,
        label: field.replace(/_name$/, ''),
        value: typeof current === 'string' ? current : '',
        kind: path.extname(String(current || '')).replace('.', '') || '',
        options: options.map(String),
      });
    }
  }
  return entries;
}

/** 把用户选的模型覆盖进提交图。overrides = { nodeId: { field: value } } */
export function applyModelOverrides(prompt, overrides) {
  if (!overrides || typeof overrides !== 'object') return prompt;
  for (const [nodeId, fields] of Object.entries(overrides)) {
    const node = prompt && prompt[nodeId];
    if (!node || !node.inputs || !fields || typeof fields !== 'object') continue;
    for (const [field, value] of Object.entries(fields)) {
      const text = String(value == null ? '' : value).trim();
      if (text !== '') node.inputs[field] = text;
    }
  }
  return prompt;
}
