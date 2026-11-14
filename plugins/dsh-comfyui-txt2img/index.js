/**
 * dsh-comfyui-txt2img —— 独立的「文生图」插件（Krea2 Turbo）。
 *
 * 只管一件事：提示词 + 尺寸 + 张数 → 出图。
 * 与 ref2v 插件、与小说工坊完全解耦。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { ComfyClient } from './lib/comfy.js';
import { buildPrompt, run as runT2I, saveImages, JobStore, loadSpec, availableLoras, friendlyError } from './lib/t2i.js';
import { scanModels } from './lib/models.js';

const DATA_DIR = process.env.DSH_T2I_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '.data');
const DEFAULT_HOST = 'http://127.0.0.1:8188';

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function text(lines) {
  return { lines: (lines || []).filter((line) => line !== '' && line !== undefined && line !== null) };
}

const OUTPUT = {
  schema: { type: 'object' },
  render(_args, value) {
    const lines = value && Array.isArray(value.lines) ? value.lines : [];
    return [{ type: 'text', text: lines.join('\n') }];
  },
};

/* ---------------------------- 请求 / 响应 ---------------------------- */

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(payload);
}

async function readRawBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readJsonBody(request) {
  const buf = await readRawBody(request);
  if (buf.length === 0) return null;
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

function sameOrigin(request) {
  const origin = request.headers && request.headers.origin;
  const host = request.headers && request.headers.host;
  if (origin === undefined) return true;
  if (host === undefined) return false;
  return origin === `http://${host}` || origin === `https://${host}`;
}

/* ------------------------------- 插件 ------------------------------- */

/**
 * 宿主 llm 服务要「富消息」：content 是 parts 数组，每条带 id 与 source。
 * 传 content: string 会被 transport 直接拒掉。
 */
function hostMessages(systemText, userText) {
  const list = [];
  if (systemText) {
    list.push({
      id: randomUUID(),
      role: 'system',
      content: [{ type: 'text', text: systemText }],
      source: { kind: 'system-prompt' },
    });
  }
  if (userText) {
    list.push({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: userText }],
      source: { kind: 'user' },
    });
  }
  return list;
}

/** 从模型输出里拆出「画面提示词」与「风格后缀」两段。 */
function splitPolish(raw) {
  const text = String(raw || '').replace(/```[a-z]*\n?/gi, '').trim();
  const out = { prompt: '', suffix: '' };
  const suffixMatch = /\[SUFFIX\]([\s\S]*)$/i.exec(text);
  if (suffixMatch) out.suffix = suffixMatch[1].trim().replace(/^["'`]|["'`]$/g, '');
  const promptMatch = /\[PROMPT\]([\s\S]*?)(?:\[SUFFIX\]|$)/i.exec(text);
  if (promptMatch) out.prompt = promptMatch[1].trim();
  if (!out.prompt) out.prompt = text.replace(/\[SUFFIX\][\s\S]*$/i, '').replace(/\[PROMPT\]/i, '').trim();
  return out;
}

export const inject = ['tools'];

export function apply(ctx) {
  const tools = ctx.tools;
  const disposers = [];
  const jobs = new JobStore(DATA_DIR);

  function startJob(job, params) {
    const client = new ComfyClient(params.host || DEFAULT_HOST);
    (async () => {
      try {
        await jobs.patch(job.id, { status: 'running' });
        const alive = await client.alive();
        if (alive === null) throw new Error('连不上 ComfyUI（默认 127.0.0.1:8188），请先启动它');
        const out = await runT2I(client, params, {
          onSubmit: (promptId, summary) => { jobs.patch(job.id, { promptId, summary }); },
          onTick: (seconds) => {
            const live = jobs.get(job.id);
            if (live) { live.elapsedSeconds = seconds; live.updatedAt = Date.now(); }
          },
        });
        const files = await saveImages(DATA_DIR, job.id, out.images);
        await jobs.patch(job.id, {
          status: 'done',
          files,
          count: files.length,
          expanded: out.expanded || '',
          elapsedSeconds: Math.round((Date.now() - job.createdAt) / 1000),
          mediaUrl: '/api/comfyui-txt2img/media?id=' + job.id + '&i=0',
        });
      } catch (error) {
        await jobs.patch(job.id, {
          status: 'failed',
          error: friendlyError(error),
          elapsedSeconds: Math.round((Date.now() - job.createdAt) / 1000),
        });
      }
    })();
    return job;
  }

  disposers.push(tools.register({
    name: 't2i_generate',
    description: '文生图（Krea2 Turbo，默认 8 步）。可一次出多张；图里自带 ComfyUI 的提示词扩写节点（expand=true 时启用）。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '提示词' },
        aspectRatio: { type: 'string', description: '比例，如 "1:1 (Square)" / "16:9 (Widescreen)" / "9:16 (Portrait)"' },
        megapixels: { type: 'number', description: '总像素（百万），0.2–2.0，默认 1' },
        batchSize: { type: 'number', description: '张数，1–4，默认 1' },
        steps: { type: 'number', description: '步数，默认 8（turbo 模型）' },
        cfg: { type: 'number', description: 'CFG，默认 1' },
        seed: { type: 'number', description: '种子；不传则随机' },
        expand: { type: 'boolean', description: '是否用 ComfyUI 内置 TextGenerate 扩写提示词，默认 true' },
        style: { type: 'boolean', description: '是否启用 darkbrush 素描风（同时挂 LoRA 与追加风格后缀），默认 false' },
        styleSuffix: { type: 'string', description: '风格后缀文本，默认 "muted minimalist sketch style"' },
        loraStrength: { type: 'number', description: 'LoRA 强度，默认 0.8' },
        host: { type: 'string', description: 'ComfyUI 地址，默认 http://127.0.0.1:8188' },
        background: { type: 'boolean', description: 'true = 立刻返回任务 id，用 t2i_status 查进度' },
      },
      required: ['prompt'],
    },
    output: OUTPUT,
    timeoutMs: 1800000,
    async execute(args) {
      const client = new ComfyClient(args.host || DEFAULT_HOST);
      const alive = await client.alive();
      if (alive === null) throw new Error('连不上 ComfyUI（默认 127.0.0.1:8188），请先启动它');

      if (args.background === true) {
        const job = jobs.create(args);
        startJob(job, args);
        return text([
          `已排入后台任务 ${job.id}`,
          `ComfyUI ${alive.version} · ${alive.device} · 空闲 ${alive.vramFreeGB} GB`,
          '用 t2i_status 查进度。',
        ]);
      }

      const startedAt = Date.now();
      let result;
      try {
        result = await runT2I(client, args);
      } catch (error) {
        throw new Error(friendlyError(error));
      }
      const job = jobs.create(args);
      const files = await saveImages(DATA_DIR, job.id, result.images);
      await jobs.patch(job.id, {
        status: 'done', promptId: result.promptId, files, count: files.length, summary: result.summary,
        expanded: result.expanded || '',
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        mediaUrl: '/api/comfyui-txt2img/media?id=' + job.id + '&i=0',
      });

      return text([
        `已生成 ${files.length} 张：${result.summary.aspectRatio} · ${result.summary.megapixels}MP · ${result.summary.steps} 步`,
        `种子 ${result.summary.seed}${result.summary.expand ? ' · 已扩写' : ' · 未扩写'}${result.summary.style ? ' · darkbrush 风格' : ''}`,
        ...files.map((f) => '· ' + f),
      ]);
    },
  }));

  disposers.push(tools.register({
    name: 't2i_status',
    description: '查看文生图任务状态，或列出最近的任务。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '任务 id；不传则列出最近的' } },
    },
    output: OUTPUT,
    async execute(args) {
      const id = String(args.id || '');
      if (id) {
        const job = jobs.get(id);
        if (!job) throw new Error('没有这个任务：' + id);
        return text([
          `${job.id} · ${job.status}${job.elapsedSeconds ? ` · ${job.elapsedSeconds}s` : ''}`,
          job.error ? `失败：${job.error}` : '',
          ...(job.files || []).map((f) => '文件：' + f),
        ]);
      }
      const list = jobs.list(10);
      if (list.length === 0) return text(['还没有文生图任务']);
      return text(list.map((job) => `· ${job.id} ${job.status}${job.elapsedSeconds ? ` ${job.elapsedSeconds}s` : ''}${job.count ? ` ${job.count} 张` : ''}${job.error ? ' — ' + job.error : ''}`));
    },
  }));

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer');
    if (webServer === undefined) return;

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-txt2img/meta',
      handler: async (_request, response) => {
        const spec = await loadSpec();
        const models = await scanModels(spec.template, new ComfyClient().host);
        const client = new ComfyClient();
        const probe = { host: client.host, ok: false };
        try {
          const res = await fetch(client.host + '/system_stats', { signal: AbortSignal.timeout(5000) });
          probe.status = res.status;
          if (res.ok) {
            const data = await res.json();
            probe.ok = true;
            probe.version = data.system?.comfyui_version;
            probe.device = data.devices?.[0]?.name;
            probe.vramFreeGB = Math.round(((data.devices?.[0]?.vram_free || 0) / 1024 ** 3) * 10) / 10;
          }
        } catch (error) {
          probe.error = String((error && error.message) || error);
        }
        sendJson(response, 200, {
          models,
          knobs: spec.slots.knobs,
          loras: await availableLoras(client.host),
          comfyui: probe.ok
            ? { online: true, version: probe.version, device: probe.device, vramFreeGB: probe.vramFreeGB }
            : { online: false, probe },
        });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-txt2img/polish',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }

        let body = null;
        try { body = await readJsonBody(request); } catch { body = null; }
        const raw = String((body && body.prompt) || '').trim();
        if (!raw) { sendJson(response, 400, { error: 'prompt_required', message: '先写一点提示词，再润化' }); return; }

        let llm;
        try { llm = ctx.get('llm'); } catch { llm = undefined; }
        if (!llm || typeof llm.stream !== 'function') {
          sendJson(response, 503, { error: 'llm_unavailable', message: '当前宿主没有可用的模型服务（llm）' });
          return;
        }

        let selection;
        try {
          const service = ctx.get('agentDefaultModel');
          const current = service && typeof service.currentSelection === 'function' ? service.currentSelection() : undefined;
          if (current && typeof current.provider === 'string' && typeof current.model === 'string') selection = current;
        } catch { /* 走默认 */ }

        const loraName = String((body && body.loraName) || '');
        const system = [
          '你是文生图提示词助手，服务 Krea2 Turbo 模型。',
          '任务：把用户给的提示词改写成更有效的一版，只输出改写后的提示词本身。',
          '',
          '硬性要求：',
          '1. 只输出提示词正文，不要解释、不要加标题、不要用代码块包裹。',
          '2. 保持原文语言（中文就中文，英文就英文）。',
          '3. 不要提到不存在的素材：不要新增用户没提到的元素。',
          '4. 输出两段，且只出现这两段：[PROMPT] 后面跟完整的画面提示词，[SUFFIX] 后面跟一段简短的风格后缀短语（逗号分隔）。',
          '5. 没有选中 LoRA、或提示词里已经把风格写清楚时，[SUFFIX] 留空。',
          '',
          '改写方向：',
          '- 主体与外观、动作、环境、光线、构图、画风都要具体，不要空话。',
          '- 保持用户原始语言；不要编造用户没提的主体。',
          '- 长度控制在原文的 1–2 倍，不要无限扩写。',
        ].join('\n');
        const user = `所选 LoRA：${loraName || '（无）'}\n\n原始描述：\n${raw}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 90000);
        try {
          const options = {
            messages: hostMessages(system, user),
            maxTokens: 1600,
            signal: controller.signal,
            reasoningEffort: 'off',
          };
          if (selection) {
            options.provider = selection.provider;
            options.model = selection.model;
          }

          const consume = async (opts) => {
            let text = '';
            const streamed = new Set();
            for await (const chunk of llm.stream(opts)) {
              if (!chunk) continue;
              if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                text += chunk.text;
                streamed.add(chunk.index);
              } else if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
                if (!streamed.has(chunk.index)) text += chunk.block.text;
              }
            }
            return text;
          };

          let out = '';
          try {
            out = (await consume(options)).trim();
          } catch {
            const fallback = { ...options };
            delete fallback.reasoningEffort;
            out = (await consume(fallback)).trim();
          }

          if (!out) {
            sendJson(response, 502, { error: 'empty_completion', message: '模型没有返回正文，换个模型再试' });
            return;
          }

          const parsed = splitPolish(out);
          sendJson(response, 200, {
            prompt: parsed.prompt || raw,
            suffix: parsed.suffix,
            model: selection ? selection.model : 'default',
          });
        } catch (error) {
          sendJson(response, 502, { error: 'llm_failed', message: String((error && error.message) || error) });
        } finally {
          clearTimeout(timer);
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-txt2img/run',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        let params = null;
        try { params = await readJsonBody(request); } catch { params = null; }
        if (!params || !String(params.prompt || '').trim()) {
          sendJson(response, 400, { error: 'prompt_required', message: '请求体里没有 prompt（或 body 无法解析）' });
          return;
        }
        const job = jobs.create(params);
        startJob(job, params);
        sendJson(response, 202, { job: { id: job.id, status: job.status } });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-txt2img/job',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const id = String(url.searchParams.get('id') || '');
        const job = jobs.get(id);
        if (!job) { sendJson(response, 404, { error: 'not_found', id }); return; }
        sendJson(response, 200, job);
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-txt2img/jobs',
      handler: async (_request, response) => {
        sendJson(response, 200, { jobs: jobs.list(20) });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-txt2img/media',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const id = String(url.searchParams.get('id') || '');
        const index = Number(url.searchParams.get('i') || 0) || 0;
        const job = jobs.get(id);
        if (!job || !Array.isArray(job.files) || !job.files[index]) {
          sendJson(response, 404, { error: 'not_found', id, index });
          return;
        }
        let buffer;
        try {
          buffer = await fs.readFile(job.files[index]);
        } catch {
          sendJson(response, 404, { error: 'file_missing', id, index });
          return;
        }
        const ext = path.extname(job.files[index]).toLowerCase();
        const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png';
        response.writeHead(200, {
          'content-type': type,
          'content-length': String(buffer.length),
          'cache-control': 'private, max-age=3600',
        });
        response.end(buffer);
      },
    }));

      });

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose();
  }, 't2i tools');
}
