import { randomUUID } from 'node:crypto';

export function text(lines) {
  return { lines: (lines || []).filter((l) => l !== '' && l !== undefined && l !== null) };
}

export function hostMessages(systemText, userText) {
  const list = [];
  if (systemText) {
    list.push({ id: randomUUID(), role: 'system', content: [{ type: 'text', text: systemText }], source: { kind: 'system-prompt' } });
  }
  list.push({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user' } });
  return list;
}

/** 一口气取回 LLM 正文（兼容 text-delta 与 block-end 两种下发方式）。 */
export async function llmText(ctx, system, user, options = {}) {
  let llm;
  try { llm = ctx.get('llm'); } catch { llm = undefined; }
  if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有可用的模型服务（llm）');

  let selection;
  try {
    const service = ctx.get('agentDefaultModel');
    const current = service && typeof service.currentSelection === 'function' ? service.currentSelection() : undefined;
    if (current && typeof current.provider === 'string' && typeof current.model === 'string') selection = current;
  } catch { /* 走默认 */ }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 180000);
  const request = {
    messages: hostMessages(system, user),
    maxTokens: options.maxTokens || 3000,
    reasoningEffort: 'off',
    signal: controller.signal,
  };
  if (selection) { request.provider = selection.provider; request.model = selection.model; }

  let out = '';
  const streamed = new Set();
  try {
    for await (const chunk of llm.stream(request)) {
      if (!chunk) continue;
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        out += chunk.text;
        streamed.add(chunk.index);
      } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
        if (!streamed.has(chunk.index)) out += chunk.block.text;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  out = out.trim();
  if (!out) throw new Error('模型没有返回正文（可能推理占满了额度）');
  return { text: out, model: selection ? selection.model : 'default' };
}

export function friendlyError(error) {
  const raw = String((error && error.message) || error || '');
  const hint = (t) => `${t}｜原始信息：${raw.replace(/\s+/g, ' ').slice(0, 500)}`;
  if (/out of memory|not enough memory|allocation on device/i.test(raw)) {
    return hint('显存不足：把「像素」降到 0.3–0.4、镜头时长降到 5 秒，或减少镜头数');
  }
  if (/prompt outputs failed validation|node_errors/i.test(raw)) {
    return hint('工作流校验失败：多半是素材没进 ComfyUI 的 input 目录，或参数越界');
  }
  if (/no such file|file not found|not in input|cannot find/i.test(raw)) {
    return hint('素材找不到：参考图/音频/视频必须先上传到 ComfyUI 的 input 目录');
  }
  if (/cuda/i.test(raw)) return hint('CUDA 报错：可先重启 ComfyUI 再试');
  if (/超时|timeout/i.test(raw)) return hint('等待超时：任务可能还在跑，去 ComfyUI 队列看一眼');
  return raw.slice(0, 800) || '未知错误';
}

/* ---------------------------- 任务存储 ---------------------------- */

