/**
 * dsh-comfyui-imgedit —— 独立的「图片编辑」插件（Qwen-Image 2.1）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { ComfyClient } from './lib/comfy.js';
import { buildPrompt, run as runEdit, saveImage, JobStore, loadSpec, listOutputs, importFromOutput, friendlyError } from './lib/edit.js';
import { scanModels } from './lib/models.js';

const DATA_DIR = process.env.DSH_IMAGE_EDIT_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '.data');
const DEFAULT_HOST = 'http://127.0.0.1:8188';

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

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
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
        files.push({ filename: nameMatch[1], mime: typeMatch ? typeMatch[1].trim() : 'application/octet-stream', data: body });
      }
    }
    from = next;
  }
  return files;
}

const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.bmp': 'image/bmp' };

export const inject = ['tools'];

export function apply(ctx) {
  const tools = ctx.tools;
  const disposers = [];
  const jobs = new JobStore(DATA_DIR);

  async function materialize(client, value) {
    const item = String(value || '').trim();
    if (!item) return '';
    if (!path.isAbsolute(item)) return item;
    const buffer = await fs.readFile(item);
    const ext = path.extname(item).toLowerCase();
    return client.upload(buffer, path.basename(item), MIME_BY_EXT[ext] || 'image/png');
  }

  function startJob(job, params) {
    const client = new ComfyClient(params.host || DEFAULT_HOST);
    (async () => {
      try {
        await jobs.patch(job.id, { status: 'running' });
        const alive = await client.alive();
        if (alive === null) throw new Error('连不上 ComfyUI（默认 127.0.0.1:8188），请先启动它');
        const out = await runEdit(client, params, {
          onSubmit: (promptId, summary) => { jobs.patch(job.id, { promptId, summary }); },
          onTick: (seconds) => {
            const live = jobs.get(job.id);
            if (live) { live.elapsedSeconds = seconds; live.updatedAt = Date.now(); }
          },
        });
        const file = await saveImage(DATA_DIR, job.id, out.images[0]);
        await jobs.patch(job.id, {
          status: 'done',
          file,
          bytes: out.images[0].buffer.length,
          elapsedSeconds: Math.round((Date.now() - job.createdAt) / 1000),
          mediaUrl: '/api/comfyui-imgedit/media?id=' + job.id,
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
    name: 'image_edit',
    description: '图片编辑（Qwen-Image 2.1）。image 是主体图，image2 是可选的参考图（服饰/风格）；两者都可传 ComfyUI input 里的文件名或本机绝对路径。prompt 说清楚要改什么。',
    parameters: {
      type: 'object',
      properties: {
        images: { type: 'array', items: { type: 'string' }, description: '图片列表，1–10 张，全部是参考（按顺序编号），例如人物、衣服、背景、风格参考各一张' },
        image: { type: 'string', description: '单图写法（旧参数）：等同于 images[0]' },
        refs: { type: 'array', items: { type: 'string' }, description: '旧参数：额外的参考图，等同于 images[1..]' },
        image2: { type: 'string', description: '旧参数：单张参考图' },
        prompt: { type: 'string', description: '编辑指令，例如「把第 2 张的衣服换给第 1 张的人物」' },
        negative: { type: 'string', description: '负向提示词，默认空' },
        enhance: { type: 'boolean', description: '是否让工作流内的 TextGenerate 先扩写编辑指令，默认 false' },
        steps: { type: 'number', description: '步数，默认 25' },
        cfg: { type: 'number', description: 'CFG，默认 1' },
        seed: { type: 'number', description: '种子；不传则随机' },
        fixedSize: { type: 'boolean', description: '是否固定出图尺寸；默认跟随输入图' },
        width: { type: 'number', description: 'fixedSize 时的宽，默认 1024' },
        height: { type: 'number', description: 'fixedSize 时的高，默认 1024' },
        host: { type: 'string', description: 'ComfyUI 地址，默认 http://127.0.0.1:8188' },
        background: { type: 'boolean', description: 'true = 立刻返回任务 id，用 image_edit_status 查进度' },
      },
      required: ['image', 'prompt'],
    },
    output: OUTPUT,
    timeoutMs: 3600000,
    async execute(args) {
      const client = new ComfyClient(args.host || DEFAULT_HOST);
      const alive = await client.alive();
      if (alive === null) throw new Error('连不上 ComfyUI（默认 127.0.0.1:8188），请先启动它');

      const list = [];
      if (Array.isArray(args.images)) args.images.forEach((v) => { if (String(v || '').trim()) list.push(v); });
      if (list.length === 0 && args.image) list.push(args.image);
      if (Array.isArray(args.refs)) args.refs.forEach((v) => { if (String(v || '').trim()) list.push(v); });
      if (list.length === 0 && args.image2) list.push(args.image2);
      if (list.length === 0) throw new Error('至少给一张参考图');
      if (list.length > 10) throw new Error(`最多 10 张图，收到 ${list.length} 张`);

      const params = {
        ...args,
        image: await materialize(client, list[0]),
        refs: await Promise.all(list.slice(1).map((v) => materialize(client, v))),
      };

      if (args.background === true) {
        const job = jobs.create(params);
        startJob(job, params);
        return text([
          `已排入后台任务 ${job.id}`,
          `ComfyUI ${alive.version} · ${alive.device} · 空闲 ${alive.vramFreeGB} GB`,
          '用 image_edit_status 查进度。',
        ]);
      }

      const startedAt = Date.now();
      let result;
      try {
        result = await runEdit(client, params);
      } catch (error) {
        throw new Error(friendlyError(error));
      }
      const job = jobs.create(params);
      const file = await saveImage(DATA_DIR, job.id, result.images[0]);
      await jobs.patch(job.id, {
        status: 'done', promptId: result.promptId, file, summary: result.summary,
        bytes: result.images[0].buffer.length,
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        mediaUrl: '/api/comfyui-imgedit/media?id=' + job.id,
      });

      return text([
        `已编辑：${result.summary.prompt}`,
        `${result.summary.steps} 步 · 种子 ${result.summary.seed}${result.summary.enhance ? ' · 已增强提示词' : ''}${result.summary.refs.length ? ' · 参考图 ' + result.summary.refs.length + ' 张' : ''}`,
        `文件：${file}`,
      ]);
    },
  }));

  disposers.push(tools.register({
    name: 'image_edit_status',
    description: '查看图片编辑任务状态，或列出最近的任务。',
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
      if (list.length === 0) return text(['还没有图片编辑任务']);
      return text(list.map((job) => `· ${job.id} ${job.status}${job.elapsedSeconds ? ` ${job.elapsedSeconds}s` : ''}${job.error ? ' — ' + job.error : ''}`));
    },
  }));

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer');
    if (webServer === undefined) return;

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-imgedit/meta',
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
          outputs: (await listOutputs(150)).files,
          comfyui: probe.ok
            ? { online: true, version: probe.version, device: probe.device, vramFreeGB: probe.vramFreeGB }
            : { online: false, probe },
        });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-imgedit/upload',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        try {
          const client = new ComfyClient();
          const files = parseMultipart(await readRawBody(request), request.headers['content-type']);
          if (!files.length) { sendJson(response, 400, { error: 'no_file', message: '没有收到文件（需要 multipart/form-data）' }); return; }
          const uploaded = [];
          for (const file of files) {
            const name = String(file.filename || 'upload.png').replace(/^.*[\\/]/, '').replace(/[^\w.\-]+/g, '_');
            const ext = path.extname(name).toLowerCase();
            const stored = await client.upload(file.data, name, MIME_BY_EXT[ext] || 'image/png');
            uploaded.push({ name: stored, bytes: file.data.length });
          }
          sendJson(response, 200, { files: uploaded });
        } catch (error) {
          sendJson(response, 500, { error: 'upload_failed', message: friendlyError(error) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-imgedit/outputs',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const limit = Number(url.searchParams.get('limit') || 150) || 150;
        try {
          sendJson(response, 200, await listOutputs(Math.min(500, Math.max(1, limit))));
        } catch (error) {
          sendJson(response, 500, { error: 'list_failed', message: String((error && error.message) || error) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-imgedit/import',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        let body = null;
        try { body = await readJsonBody(request); } catch { body = null; }
        const name = String((body && body.name) || '');
        if (!name) { sendJson(response, 400, { error: 'name_required' }); return; }
        try {
          const stored = await importFromOutput(new ComfyClient(), name, String((body && body.subfolder) || ''));
          sendJson(response, 200, { name: stored });
        } catch (error) {
          sendJson(response, 404, { error: 'import_failed', message: String((error && error.message) || error) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-imgedit/preview',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const filename = String(url.searchParams.get('filename') || '');
        if (!filename) { sendJson(response, 400, { error: 'filename_required' }); return; }
        const type = String(url.searchParams.get('type') || 'input');
        const target = new ComfyClient().host + '/view?filename=' + encodeURIComponent(filename)
          + '&subfolder=' + encodeURIComponent(String(url.searchParams.get('subfolder') || '')) + '&type=' + encodeURIComponent(type);
        try {
          const res = await fetch(target, { signal: AbortSignal.timeout(20000) });
          if (!res.ok) { sendJson(response, 404, { error: 'not_found', status: res.status }); return; }
          const buf = Buffer.from(await res.arrayBuffer());
          response.writeHead(200, {
            'content-type': res.headers.get('content-type') || 'application/octet-stream',
            'cache-control': 'private, max-age=300',
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
      path: '/api/comfyui-imgedit/polish',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }

        let body = null;
        try { body = await readJsonBody(request); } catch { body = null; }
        const raw = String((body && body.prompt) || '').trim();
        if (!raw) { sendJson(response, 400, { error: 'prompt_required', message: '先写一点编辑要求，再润化' }); return; }

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


        const system = [
          '你是图片合成提示词的改写助手，服务 Qwen-Image 2.1 的多图合成能力。',
          '任务：把用户给的提示词改写成更有效的一版，只输出改写后的提示词本身。',
          '',
          '硬性要求：',
          '1. 只输出提示词正文，不要解释、不要加标题、不要用代码块包裹。',
          '2. 保持原文语言（中文就中文，英文就英文）。',
          '3. 不要提到不存在的素材：不要新增用户没提到的元素。',
          '4. 指代图片只用「第 N 张」，序号与上传顺序一致；不要用 <Picture N> 这类标签。',
          '5. 用户提到的每一张图都要保留在改写结果里，不要把某一张漏掉。',
          '',
          '改写方向：',
          '- 写清每张图分别提供什么（谁、长什么样、穿什么）。',
          '- 讲清最终画面：构图、主体之间的位置关系、动作与姿态。',
          '- 补足光线、色调、画风、材质质感。',
          '- 长度控制在原文的 1–2 倍，不要无限扩写。',
        ].join('\n');

        const images = Array.isArray(body && body.images)
          ? body.images.map((x) => String(x || '')).filter((x) => x.trim() !== '')
          : [];
        const count = images.length;
        const MAX_VIEW = 6; // 只把前 6 张发给润化模型，避免请求过大

        // 把参考图取回来，交给能看图的模型（失败就退回纯文字）
        const comfy = new ComfyClient();
        const imageBlocks = [];
        for (let i = 0; i < Math.min(images.length, MAX_VIEW); i += 1) {
          try {
            const url = comfy.host + '/view?filename=' + encodeURIComponent(images[i]) + '&type=input';
            const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
            if (!res.ok) continue;
            const buf = Buffer.from(await res.arrayBuffer());
            const mimeType = MIME_BY_EXT[path.extname(images[i]).toLowerCase()] || 'image/png';
            imageBlocks.push({ index: i + 1, buffer: buf, mimeType, name: images[i] });
          } catch { /* 单张失败跳过 */ }
        }

        // 图片必须先存进附件仓库，消息里用 { type:'image', attachment: ref } 引用
        const attachments = (() => {
          try { return ctx.get('attachments'); } catch { return undefined; }
        })();
        const visionParts = [];
        const attachErrors = [];
        if (attachments && typeof attachments.saveImage === 'function') {
          for (const item of imageBlocks) {
            try {
              const ref = await attachments.saveImage({ data: item.buffer, mediaType: item.mimeType, name: item.name });
              visionParts.push({ type: 'text', text: `第 ${item.index} 张：` });
              visionParts.push({ type: 'image', attachment: ref });
            } catch (error) {
              attachErrors.push({ index: item.index, error: String((error && error.message) || error) });
            }
          }
        } else {
          attachErrors.push({ error: 'attachments 服务不可用', hasAttachments: Boolean(attachments) });
        }

        const baseText = `可用图片：${count || 1} 张（按上传顺序，用「第 1 张」「第 2 张」…指代）\n`
          + (visionParts.length ? '图片附在后面，先看清每张是什么再改写。\n' : '')
          + `\n原始提示词：\n${raw}`;

        const textContent = [{ type: 'text', text: baseText }];
        const visionContent = [{ type: 'text', text: baseText }, ...visionParts];

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 120000);
        try {
          const build = (content, stripEffort) => {
            const opts = {
              messages: [
                { id: randomUUID(), role: 'system', content: [{ type: 'text', text: system }], source: { kind: 'system-prompt' } },
                { id: randomUUID(), role: 'user', content, source: { kind: 'user' } },
              ],
              maxTokens: 1200,
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

          const attempts = [];
          if (imageBlocks.length > 0) {
            attempts.push({ vision: true, content: visionContent, stripEffort: false });
            attempts.push({ vision: true, content: visionContent, stripEffort: true });
          }
          attempts.push({ vision: false, content: textContent, stripEffort: false });
          attempts.push({ vision: false, content: textContent, stripEffort: true });

          let out = '';
          let sawImages = false;
          let lastError = null;
          const tried = [];
          const log = [];
          for (const attempt of attempts) {
            const label = (attempt.vision ? 'vision' : 'text') + (attempt.stripEffort ? '-' : '+');
            tried.push(label);
            try {
              out = (await consume(build(attempt.content, attempt.stripEffort))).trim();
              log.push({ attempt: label, ok: out !== '', chars: out.length });
            } catch (error) {
              lastError = error;
              out = '';
              log.push({ attempt: label, ok: false, error: String((error && error.message) || error) });
            }
            if (out) { sawImages = attempt.vision; break; }
          }

          try {
            await fs.mkdir(DATA_DIR, { recursive: true });
            await fs.writeFile(
              path.join(DATA_DIR, 'polish-debug.json'),
              JSON.stringify({
                when: new Date().toISOString(),
                selection: selection || null,
                images,
                imagesAttached: imageBlocks.length,
                visionParts: visionParts.length,
                attachErrors,
                totalBytes: imageBlocks.reduce((sum, b) => sum + b.buffer.length, 0),
                attempts: log,
                vision: sawImages,
                promptChars: raw.length,
                outChars: out.length,
              }, null, 2),
              'utf8',
            );
          } catch { /* 写日志失败不影响结果 */ }

          // 覆盖检查：传了 N 张，就应该用到 第 1..N 张
          const usedIdx = new Set([...out.matchAll(/第\s*(\d+)\s*张/g)].map((m) => Number(m[1])));
          const missing = [];
          for (let i = 1; i <= count; i += 1) if (!usedIdx.has(i)) missing.push(i);

          if (!out) {
            sendJson(response, 502, {
              error: 'empty_completion',
              message: '模型没有返回正文' + (lastError ? '：' + String(lastError.message || lastError) : ''),
              tried,
            });
            return;
          }
          sendJson(response, 200, {
            text: out,
            model: selection ? selection.model : 'default',
            vision: sawImages,
            imagesAttached: visionParts.length ? imageBlocks.length : 0,
            coverage: { expected: count, missing },
            tried,
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
      path: '/api/comfyui-imgedit/run',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        let images = null;
        try { images = await readJsonBody(request); } catch { images = null; }
        if (!images) { sendJson(response, 400, { error: 'bad_body' }); return; }

        const list = [];
        if (Array.isArray(images.images)) images.images.forEach((v) => { if (String(v || '').trim()) list.push(String(v)); });
        if (list.length === 0 && String(images.image || '').trim()) list.push(String(images.image));
        if (list.length === 0) {
          sendJson(response, 400, { error: 'images_required', message: '至少传一张参考图' });
          return;
        }
        if (!String(images.prompt || '').trim()) {
          sendJson(response, 400, { error: 'prompt_required', message: '写一句编辑指令，说明要改什么' });
          return;
        }
        const params = { ...images, image: list[0], refs: list.slice(1) };
        const job = jobs.create(params);
        startJob(job, params);
        sendJson(response, 202, { job: { id: job.id, status: job.status } });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-imgedit/job',
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
      path: '/api/comfyui-imgedit/jobs',
      handler: async (_request, response) => {
        sendJson(response, 200, { jobs: jobs.list(20) });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-imgedit/media',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const id = String(url.searchParams.get('id') || '');
        const job = jobs.get(id);
        if (!job || !job.file) { sendJson(response, 404, { error: 'not_found', id }); return; }
        try {
          const buffer = await fs.readFile(job.file);
          const ext = path.extname(job.file).toLowerCase();
          response.writeHead(200, {
            'content-type': MIME_BY_EXT[ext] || 'image/png',
            'content-length': String(buffer.length),
            'cache-control': 'private, max-age=3600',
          });
          response.end(buffer);
        } catch {
          sendJson(response, 404, { error: 'file_missing', id });
        }
      },
    }));
  });

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose();
  }, 'image-edit tools');
}
