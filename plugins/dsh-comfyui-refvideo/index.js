/**
 * dsh-comfyui-refvideo —— 独立的「参考生视频」插件。
 *
 * 只管一件事：拿参考图 / 参考视频 / 参考音频 + 提示词，跑 MiniMax H3 ref2va，出 mp4。
 * 与其它面板完全解耦：不共用面板、不共用工具。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { ComfyClient } from './lib/comfy.js';
import { buildPrompt, run as runRef2V, saveMedia, JobStore, loadSpec, friendlyError, listOutputs, importFromOutput } from './lib/ref2v.js';

const DATA_DIR = process.env.DSH_REF2V_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '.data');

const DEFAULT_HOST = 'http://127.0.0.1:8188';
const SELF_TEST_HOST = 'http://127.0.0.1:8188';

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

const KIND_BY_EXT = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.bmp'],
  audio: ['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac'],
  video: ['.mp4', '.webm', '.mov', '.mkv'],
};

const kindOf = (name) => {
  const ext = path.extname(String(name || '')).toLowerCase();
  for (const [kind, list] of Object.entries(KIND_BY_EXT)) if (list.includes(ext)) return kind;
  return 'image';
};

const mimeOf = (name, kind) => {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/wav' : 'image/png';
};

/* ---------------------------- 请求 / 响应 ---------------------------- */
/* 宿主 webServer 是 Node 风格：handler(request, response)，不用 Fetch API。 */

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

/** 极简 multipart 解析，本插件自己的上传走这里。 */
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  const boundary = m && (m[1] || m[2]);
  if (!boundary) return [];
  const delimiter = Buffer.from('--' + boundary);
  const files = [];
  let from = 0;
  for (;;) {
    const start = buffer.indexOf(delimiter, from);
    if (start < 0) break;
    const next = buffer.indexOf(delimiter, start + delimiter.length);
    if (next < 0) break;
    const part = buffer.subarray(start + delimiter.length + 2, Math.max(start + delimiter.length + 2, next - 2));
    const split = part.indexOf('\r\n\r\n');
    if (split > 0) {
      const head = part.subarray(0, split).toString('utf8');
      const body = part.subarray(split + 4);
      const nameMatch = /filename="([^"]*)"/i.exec(head);
      if (nameMatch && nameMatch[1]) {
        const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(head);
        files.push({
          filename: nameMatch[1],
          mime: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
          data: body,
        });
      }
    }
    from = next;
  }
  return files;
}

async function readUploads(request) {
  const buf = await readRawBody(request);
  const type = (request.headers && request.headers['content-type']) || '';
  return parseMultipart(buf, type);
}

/**
 * 宿主 llm 服务要的是「富消息」：content 必须是 parts 数组，且每条带 id 与 source。
 * 传 OpenAI 那种 content: string 会被 transport 直接拒掉（报 DeepSeek Messages transport failed）。
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

/** 带图片块的消息构造：parts 里可混排 {type:'text'} / {type:'image', attachment}。 */
function hostMessagesWithParts(systemText, parts) {
  const list = [];
  if (systemText) {
    list.push({
      id: randomUUID(),
      role: 'system',
      content: [{ type: 'text', text: systemText }],
      source: { kind: 'system-prompt' },
    });
  }
  list.push({ id: randomUUID(), role: 'user', content: parts, source: { kind: 'user' } });
  return list;
}

/* ------------------------------- 插件 ------------------------------- */

export const inject = ['tools'];

export function apply(ctx) {
  const tools = ctx.tools;
  const disposers = [];
  const jobs = new JobStore(DATA_DIR);

  async function materialize(client, items) {
    const out = [];
    for (const raw of items || []) {
      const item = String(raw || '').trim();
      if (!item) continue;
      if (!path.isAbsolute(item)) { out.push(item); continue; }
      const buffer = await fs.readFile(item);
      const name = await client.upload(buffer, path.basename(item), mimeOf(item, kindOf(item)));
      out.push(name);
    }
    return out;
  }

  function startJob(job, params) {
    const client = new ComfyClient(params.host || DEFAULT_HOST);
    (async () => {
      try {
        await jobs.patch(job.id, { status: 'running' });
        const alive = await client.alive();
        if (alive === null) throw new Error('连不上 ComfyUI（默认 127.0.0.1:8188），请先启动它');
        const out = await runRef2V(client, params, {
          onSubmit: (promptId, summary) => { jobs.patch(job.id, { promptId, summary }); },
          onTick: (seconds) => {
            const live = jobs.get(job.id);
            if (live) { live.elapsedSeconds = seconds; live.updatedAt = Date.now(); }
          },
        });
        const file = await saveMedia(DATA_DIR, job.id, out.buffer);
        await jobs.patch(job.id, {
          status: 'done',
          file,
          bytes: out.buffer.length,
          elapsedSeconds: Math.round((Date.now() - job.createdAt) / 1000),
          mediaUrl: `/api/comfyui-refvideo/media?id=${job.id}`,
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
    name: 'ref2v_generate',
    description:
      '参考图/音频/视频生视频（MiniMax H3 ref2va）。images/audios/videos 可传 ComfyUI input 里的文件名，也可传本机绝对路径（会自动上传）。提示词里用 <Picture 1> / <Video 1> / <Audio 1> 按顺序指代素材。本机 16GB 显存跑 19.5GB 模型会极慢甚至 OOM，长任务建议 background。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '提示词，用 <Picture N>/<Video N>/<Audio N> 引用参考素材' },
        images: { type: 'array', items: { type: 'string' }, description: '参考图，最多 9 个' },
        videos: { type: 'array', items: { type: 'string' }, description: '参考视频，最多 3 个' },
        audios: { type: 'array', items: { type: 'string' }, description: '独立参考音频，最多 3 个' },
        aspectRatio: { type: 'string', description: '比例，如 "16:9 (Widescreen)" / "9:16 (Portrait)"' },
        megapixels: { type: 'number', description: '总像素（百万），0.2–1.0，默认 0.4' },
        durationSeconds: { type: 'number', description: '时长秒数，5–15，默认 5' },
        seed: { type: 'number', description: '种子；不传则随机' },
        lightning: { type: 'boolean', description: 'true=LoRA 4 步加速（默认），false=20 步全量' },
        refImageSize: { type: 'string', description: 'match（默认，快）或 max（更保身份，更慢）' },
        host: { type: 'string', description: 'ComfyUI 地址，默认 http://127.0.0.1:8188' },
        background: { type: 'boolean', description: 'true = 立刻返回任务 id，用 ref2v_status 查进度' },
      },
      required: ['prompt'],
    },
    output: OUTPUT,
    timeoutMs: 3600000,
    async execute(args) {
      const client = new ComfyClient(args.host || DEFAULT_HOST);
      const alive = await client.alive();
      if (alive === null) throw new Error('连不上 ComfyUI（默认 127.0.0.1:8188），请先启动它');

      const params = {
        ...args,
        images: await materialize(client, args.images),
        videos: await materialize(client, args.videos),
        audios: await materialize(client, args.audios),
      };

      if (args.background === true) {
        const job = jobs.create(params);
        startJob(job, params);
        return text([
          `已排入后台任务 ${job.id}`,
          `ComfyUI ${alive.version} · ${alive.device} · 空闲 ${alive.vramFreeGB} GB`,
          '用 ref2v_status 查进度。',
        ]);
      }

      const warning = alive.vramFreeGB < 22
        ? `注意：空闲显存 ${alive.vramFreeGB} GB < 模型所需 ~22 GB，会走内存卸载，可能非常慢甚至失败`
        : '';
      const startedAt = Date.now();
      let buffer;
      let promptId;
      let summary;
      try {
        const built = await buildPrompt(params);
        summary = built.summary;
        promptId = await client.submit(built.prompt);
        const entry = await client.wait(promptId, 3600000);
        ({ buffer } = await client.fetchOutput(entry));
      } catch (error) {
        throw new Error(friendlyError(error));
      }

      const job = jobs.create(params);
      const file = await saveMedia(DATA_DIR, job.id, buffer);
      await jobs.patch(job.id, {
        status: 'done', promptId, file, summary, bytes: buffer.length,
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        mediaUrl: `/api/comfyui-refvideo/media?id=${job.id}`,
      });

      return text([
        warning,
        `已生成：${summary.durationSeconds}s · ${summary.aspectRatio} · ${summary.megapixels}MP · ${summary.images}图/${summary.videos}视频/${summary.audios}音频`,
        `文件：${file}（${(buffer.length / 1024 / 1024).toFixed(1)} MB）`,
        `种子 ${summary.seed} · ${summary.lightning ? '4 步加速' : '20 步全量'} · ref_image_size=${summary.refImageSize}`,
      ]);
    },
  }));

  disposers.push(tools.register({
    name: 'ref2v_status',
    description: '查看参考生视频任务的状态，或列出最近的任务。',
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
          job.file ? `文件：${job.file}` : '',
        ]);
      }
      const list = jobs.list(10);
      if (list.length === 0) return text(['还没有参考生视频任务']);
      return text(list.map((job) => `· ${job.id} ${job.status}${job.elapsedSeconds ? ` ${job.elapsedSeconds}s` : ''}${job.error ? ' — ' + job.error : ''}`));
    },
  }));

  // 路由必须挂在 webServer 的子 fiber 上：apply 阶段该服务可能还没就绪，
  // 直接 ctx.get('webServer') 会拿到 undefined，导致一条路由都挂不上。
  disposers.push(tools.register({
    name: 'ref2v_llm_probe',
    description: '诊断用：直接调一次宿主的 LLM 服务，返回模型选择、收到的 chunk 类型、推理/正文字符数。用于排查「AI 润化」拿不到正文的问题。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要发给模型的测试文本，默认一句简单指令' },
        system: { type: 'string', description: '可选的 system 提示，用于验证「system + user」两条消息的路径' },
        effort: { type: 'string', description: 'reasoningEffort：off / low / medium / high / none（none = 完全不传该参数），默认 off' },
        maxTokens: { type: 'number', description: 'maxTokens，默认 200；传 0 = 不传该参数' },
      },
    },
    output: OUTPUT,
    async execute(args) {
      const raw = String(args.text || '只回复两个字：收到');
      const systemText = args.system ? String(args.system) : '';
      const effort = String(args.effort || 'off');
      const maxTokens = Number.isFinite(Number(args.maxTokens)) ? Number(args.maxTokens) : 200;
      const lines = [];

      let llm;
      try { llm = ctx.get('llm'); } catch (error) { lines.push('ctx.get("llm") 抛错：' + String((error && error.message) || error)); }
      lines.push('llm 服务：' + (llm ? '有，stream=' + typeof llm.stream : '无'));
      if (!llm || typeof llm.stream !== 'function') return text(lines);

      let selection;
      try {
        const service = ctx.get('agentDefaultModel');
        const current = service && typeof service.currentSelection === 'function' ? service.currentSelection() : undefined;
        if (current) selection = current;
      } catch (error) {
        lines.push('agentDefaultModel 抛错：' + String((error && error.message) || error));
      }
      lines.push('当前模型：' + (selection ? `${selection.provider} / ${selection.model}${selection.reasoningEffort ? ' / effort=' + selection.reasoningEffort : ''}` : '（拿不到，走宿主默认）'));

      const types = new Set();
      let textChars = 0;
      let reasoningChars = 0;
      let body = '';
      const options = {
        messages: hostMessages(systemText, raw),
      };
      if (maxTokens > 0) options.maxTokens = maxTokens;
      if (effort !== 'none') options.reasoningEffort = effort;
      if (selection && selection.provider && selection.model) {
        options.provider = selection.provider;
        options.model = selection.model;
      }
      lines.push('请求参数：' + JSON.stringify({ ...options, messages: undefined }));

      try {
        const dumped = [];
        for await (const chunk of llm.stream(options)) {
          if (!chunk) continue;
          if (dumped.length < 6) {
            try { dumped.push(JSON.stringify(chunk).slice(0, 300)); } catch { dumped.push(String(chunk)); }
          }
          if (typeof chunk.type === 'string') types.add(chunk.type);
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') { textChars += chunk.text.length; body += chunk.text; }
          if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoningChars += chunk.text.length;
          if (chunk.type === 'block-end' && chunk.block) {
            if (chunk.block.type === 'text' && typeof chunk.block.text === 'string') { textChars += chunk.block.text.length; body += chunk.block.text; }
            if (chunk.block.type === 'reasoning' && typeof chunk.block.text === 'string') reasoningChars += chunk.block.text.length;
          }
        }
        lines.push('chunk 类型：' + ([...types].join(', ') || '（一个都没有）'));
        lines.push(`推理 ${reasoningChars} 字 / 正文 ${textChars} 字`);
        lines.push('正文预览：' + (body.trim().slice(0, 200) || '（空）'));
        lines.push('原始 chunk：');
        for (const d of dumped) lines.push('  ' + d);
      } catch (error) {
        lines.push('stream 抛错：' + String((error && error.message) || error));
        lines.push('chunk 类型（出错前）：' + ([...types].join(', ') || '（无）'));
      }
      return text(lines);
    },
  }));

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer');
    if (webServer === undefined) return;

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-refvideo/meta',
      handler: async (_request, response) => {
        const spec = await loadSpec();
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
          knobs: spec.slots.knobs,
          refSlots: spec.slots.refSlots,
          comfyui: probe.ok
            ? { online: true, version: probe.version, device: probe.device, vramFreeGB: probe.vramFreeGB }
            : { online: false, probe },
        });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-refvideo/upload',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        try {
          const client = new ComfyClient();
          const files = await readUploads(request);
          if (!files.length) { sendJson(response, 400, { error: 'no_file', message: '没有收到文件（需要 multipart/form-data）' }); return; }
          const uploaded = [];
          for (const file of files) {
            const name = String(file.filename || 'upload.bin').replace(/^.*[\\/]/, '').replace(/[^\w.\-]+/g, '_');
            const kind = kindOf(name);
            const stored = await client.upload(file.data, name, file.mime || mimeOf(name, kind));
            uploaded.push({ name: stored, kind, bytes: file.data.length });
          }
          sendJson(response, 200, { files: uploaded });
        } catch (error) {
          sendJson(response, 500, { error: 'upload_failed', message: friendlyError(error) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-refvideo/run',
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
      path: '/api/comfyui-refvideo/job',
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
      path: '/api/comfyui-refvideo/jobs',
      handler: async (_request, response) => {
        sendJson(response, 200, { jobs: jobs.list(20) });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-refvideo/polish',
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

        // 用会话当前选的模型；拿不到就让宿主自己选默认
        let selection;
        try {
          const service = ctx.get('agentDefaultModel');
          const current = service && typeof service.currentSelection === 'function' ? service.currentSelection() : undefined;
          if (current && typeof current.provider === 'string' && typeof current.model === 'string') selection = current;
        } catch { /* 走默认 */ }

        const counts = (body && body.counts) || {};
        const slotsLine = [
          `${Number(counts.images) || 0} 张参考图`,
          `${Number(counts.videos) || 0} 段参考视频`,
          `${Number(counts.audios) || 0} 段参考音频`,
        ].join(' · ');

        const system = [
          '你是视频生成提示词的改写助手，服务 MiniMax H3 参考生视频（ref2va）模型。',
          '任务：把用户给的提示词改写成更有效的一版，只输出改写后的提示词本身。',
          '',
          '硬性要求：',
          '1. 只输出提示词正文，不要解释、不要加标题、不要用代码块包裹。',
          '2. 保持原文语言（中文就中文，英文就英文）。',
          '3. 不要提到不存在的素材：不要新增用户没提到的元素。',
          '4. 保留原文中所有 <Picture N> / <Video N> / <Audio N> 标签，编号和指向含义都不能变。',
          '5. 用户给了参考图但没写标签时，按顺序补上 <Picture 1>…<Picture N>，保证每张图都被引用；这是模型识别素材的唯一方式。',
          '',
          '改写方向：',
          '- 主体与身份特征写清楚（谁、长什么样、穿什么）。',
          '- 动作与表演要具体，避免“很好看”“有氛围”这类空话。',
          '- 补足镜头语言：景别、机位、镜头运动。',
          '- 按时间顺序组织（CUT 1 / CUT 2 或先…再…），一镜一动作。',
          '- 需要声音时描述环境音/动作音，不要凭空写对白。',
          '- 补足光线、色调、风格。',
          '- 长度控制在原文的 1–2 倍，不要无限扩写。',
        ].join('\n');

        const user = `可用参考素材：${slotsLine}\n\n原始提示词：\n${raw}`;

        // 把参考图取回来交给能看图的模型（视频/音频无法作为视觉输入，只发图）
        const comfy = new ComfyClient();
        const imageNames = Array.isArray(body && body.images)
          ? body.images.map((x) => String(x || '')).filter((x) => x.trim() !== '')
          : [];
        const picParts = [];
        const attachErrors = [];
        const attachments = (() => {
          try { return ctx.get('attachments'); } catch { return undefined; }
        })();
        if (attachments && typeof attachments.saveImage === 'function') {
          for (let i = 0; i < Math.min(imageNames.length, 6); i += 1) {
            try {
              const url = comfy.host + '/view?filename=' + encodeURIComponent(imageNames[i]) + '&type=input';
              const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
              if (!res.ok) { attachErrors.push({ index: i + 1, error: 'HTTP ' + res.status }); continue; }
              const buf = Buffer.from(await res.arrayBuffer());
              const ref = await attachments.saveImage({ data: buf, mediaType: 'image/png', name: imageNames[i] });
              picParts.push({ type: 'text', text: `<Picture ${i + 1}> = ` });
              picParts.push({ type: 'image', attachment: ref });
            } catch (error) {
              attachErrors.push({ index: i + 1, error: String((error && error.message) || error) });
            }
          }
        } else {
          attachErrors.push({ error: 'attachments 服务不可用' });
        }

        const textParts = [{ type: 'text', text: user }];
        const visionParts = picParts.length
          ? [{ type: 'text', text: user + '\n\n下面按顺序附上参考图，标签编号与图片顺序一致。' }, ...picParts]
          : null;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 120000);
        const seen = new Set();
        const debug = {
          at: new Date().toISOString(),
          selection: selection || null,
          types: [],
          reasoningChars: 0,
          textChars: 0,
          error: null,
          sample: '',
          images: imageNames.length,
          attached: picParts.length / 2,
          attachErrors,
          attempts: [],
        };
        const flushDebug = async () => {
          debug.types = [...seen];
          try {
            await fs.mkdir(DATA_DIR, { recursive: true });
            await fs.writeFile(path.join(DATA_DIR, 'polish-debug.json'), JSON.stringify(debug, null, 2), 'utf8');
          } catch { /* 诊断写不进去不影响主流程 */ }
        };
        try {
          const buildOptions = (parts, stripEffort) => {
            const opts = {
              messages: hostMessagesWithParts(system, parts),
              maxTokens: 2400,
              signal: controller.signal,
            };
            if (!stripEffort) opts.reasoningEffort = 'off';
            if (selection) {
              opts.provider = selection.provider;
              opts.model = selection.model;
            }
            return opts;
          };

          const consume = async (opts) => {
            let text = '';
            const streamed = new Set(); // 已通过 text-delta 增量给出的 block 下标
            for await (const chunk of llm.stream(opts)) {
              if (!chunk) continue;
              if (typeof chunk.type === 'string') seen.add(chunk.type);
              if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
                text += chunk.text;
                debug.textChars += chunk.text.length;
                streamed.add(chunk.index);
              } else if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
                debug.reasoningChars += chunk.text.length;
              } else if (chunk.type === 'block-end' && chunk.block) {
                if (chunk.block.type === 'text' && typeof chunk.block.text === 'string') {
                  if (!streamed.has(chunk.index)) {
                    text += chunk.block.text;
                    debug.textChars += chunk.block.text.length;
                  }
                  if (debug.sample === '') debug.sample = chunk.block.text.slice(0, 200);
                } else if (chunk.block.type === 'reasoning' && typeof chunk.block.text === 'string') {
                  debug.reasoningChars += chunk.block.text.length;
                }
              }
            }
            return text;
          };

          const plan = [];
          if (visionParts) {
            plan.push({ parts: visionParts, vision: true, stripEffort: false });
            plan.push({ parts: visionParts, vision: true, stripEffort: true });
          }
          plan.push({ parts: textParts, vision: false, stripEffort: false });
          plan.push({ parts: textParts, vision: false, stripEffort: true });

          let out = '';
          let vision = false;
          let lastError = null;
          for (const attempt of plan) {
            const label = (attempt.vision ? 'vision' : 'text') + (attempt.stripEffort ? '-' : '+');
            try {
              out = (await consume(buildOptions(attempt.parts, attempt.stripEffort))).trim();
              debug.attempts.push({ attempt: label, ok: out !== '', chars: out.length });
            } catch (error) {
              lastError = error;
              debug.attempts.push({ attempt: label, ok: false, error: String((error && error.message) || error) });
              out = '';
            }
            if (out) { vision = attempt.vision; break; }
          }
          debug.mode = vision ? 'vision' : 'text-only';
          debug.error = debug.error || (lastError ? String((lastError && lastError.message) || lastError) : null);

          // 标签覆盖检查：传了几张图，就应该用到 <Picture 1..N>
          const usedPictures = new Set([...out.matchAll(/<Picture\s*(\d+)>/g)].map((m) => Number(m[1])));
          const expectedImages = Number(counts.images) || 0;
          const missing = [];
          for (let i = 1; i <= expectedImages; i += 1) if (!usedPictures.has(i)) missing.push(i);
          debug.coverage = { expectedImages, used: [...usedPictures], missing };

          await flushDebug();

          if (!out) {
            sendJson(response, 502, {
              error: 'empty_completion',
              message: '模型没有返回正文（多半是推理占满了额度）',
              saw: debug.types,
              reasoningChars: debug.reasoningChars,
              textChars: debug.textChars,
              attempts: debug.attempts,
            });
            return;
          }
          sendJson(response, 200, {
            text: out,
            model: selection ? selection.model : 'default',
            vision,
            imagesAttached: picParts.length / 2,
            coverage: { expected: expectedImages, missing },
          });
        } catch (error) {
          debug.error = String((error && error.message) || error);
          await flushDebug();
          sendJson(response, 502, { error: 'llm_failed', message: debug.error, saw: debug.types });
        } finally {
          clearTimeout(timer);
        }
      },
    }));

    
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-refvideo/outputs',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const limit = Number(url.searchParams.get('limit') || 200) || 200;
        try {
          const result = await listOutputs(Math.min(500, Math.max(1, limit)));
          sendJson(response, 200, result);
        } catch (error) {
          sendJson(response, 500, { error: 'list_failed', message: String((error && error.message) || error) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-refvideo/import',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        let body = null;
        try { body = await readJsonBody(request); } catch { body = null; }
        const name = String((body && body.name) || '');
        const subfolder = String((body && body.subfolder) || '');
        if (!name) { sendJson(response, 400, { error: 'name_required' }); return; }
        try {
          const client = new ComfyClient();
          const result = await importFromOutput(client, name, subfolder);
          sendJson(response, 200, result);
        } catch (error) {
          sendJson(response, 404, { error: 'import_failed', message: String((error && error.message) || error) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-refvideo/preview',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const filename = String(url.searchParams.get('filename') || '');
        if (!filename) { sendJson(response, 400, { error: 'filename_required' }); return; }
        const subfolder = String(url.searchParams.get('subfolder') || '');
        const type = String(url.searchParams.get('type') || 'input');
        const target = new ComfyClient().host + '/view?filename=' + encodeURIComponent(filename)
          + '&subfolder=' + encodeURIComponent(subfolder) + '&type=' + encodeURIComponent(type);
        try {
          const res = await fetch(target, { signal: AbortSignal.timeout(20000) });
          if (!res.ok) { sendJson(response, 404, { error: 'not_found', status: res.status }); return; }
          const buf = Buffer.from(await res.arrayBuffer());
          response.writeHead(200, {
            'content-type': res.headers.get('content-type') || 'application/octet-stream',
            'cache-control': 'private, max-age=600',
            'content-length': String(buf.length),
          });
          response.end(buf);
        } catch (error) {
          sendJson(response, 502, { error: 'upstream_failed', message: String((error && error.message) || error) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-refvideo/media',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const id = String(url.searchParams.get('id') || '');
        const job = jobs.get(id);
        if (!job || !job.file) { sendJson(response, 404, { error: 'not_found', id }); return; }
        let buffer;
        try {
          buffer = await fs.readFile(job.file);
        } catch {
          sendJson(response, 404, { error: 'file_missing', id });
          return;
        }
        const size = buffer.length;
        const base = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' };
        const range = request.headers && request.headers.range;
        const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
        if (match) {
          const start = match[1] ? Number(match[1]) : 0;
          const end = match[2] ? Number(match[2]) : size - 1;
          if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < size) {
            const stop = Math.min(end, size - 1);
            const chunk = buffer.subarray(start, stop + 1);
            response.writeHead(206, { ...base, 'content-range': `bytes ${start}-${stop}/${size}`, 'content-length': String(chunk.length) });
            response.end(chunk);
            return;
          }
          response.writeHead(416, { 'content-range': `bytes */${size}` });
          response.end();
          return;
        }
        response.writeHead(200, { ...base, 'content-length': String(size) });
        response.end(buffer);
      },
    }));
  });

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose();
  }, 'ref2v tools');
}

