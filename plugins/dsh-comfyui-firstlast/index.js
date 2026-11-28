/**
 * dsh-comfyui-firstlast —— 首尾帧生视频（MiniMax H3 i2v）
 *
 * 一条路：给首帧（必填）+ 尾帧（可选），描述中间发生了什么，模型补出中间过程。
 * 工作流来自用户导入的 `video_minimax_h3_i2v.json`，只补了一个 last_frame 槽位。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { ComfyClient } from './lib/comfy.js';
import { buildPrompt, run as runFirstLast, framesForSeconds } from './lib/firstlast.js';
import { scanModels } from './lib/models.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DSH_FIRSTLAST_DATA || path.join(HERE, '.data');
const DEFAULT_HOST = 'http://127.0.0.1:8188';
const MAX_BYTES = 200 * 1024 * 1024;

const OUTPUT = {
  schema: { type: 'object' },
  render(_args, value) {
    const lines = value && Array.isArray(value.lines) ? value.lines : [];
    return [{ type: 'text', text: lines.join('\n') }];
  },
};

/** 工具的返回值统一成 { lines }，由 OUTPUT.render 渲染成文本。 */
function result(lines) {
  return { lines: lines.filter(Boolean) };
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

async function readBody(request, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体太大');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/** multipart 上传：只取第一个文件字段（字段名随意）。 */
function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) throw new Error('缺少 multipart boundary');
  const boundary = Buffer.from('--' + (match[1] || match[2]).trim());
  const parts = [];
  let index = buffer.indexOf(boundary);
  while (index !== -1) {
    const start = index + boundary.length;
    if (buffer.slice(start, start + 2).toString() === '--') break;
    const next = buffer.indexOf(boundary, start);
    if (next === -1) break;
    parts.push(buffer.slice(start + 2, next - 2));
    index = next;
  }
  for (const part of parts) {
    const sep = part.indexOf('\r\n\r\n');
    if (sep === -1) continue;
    const head = part.slice(0, sep).toString('utf8');
    if (!/filename=/i.test(head)) continue;
    const nameMatch = /filename="([^"]*)"/i.exec(head);
    return { filename: (nameMatch && nameMatch[1]) || 'upload.bin', data: part.slice(sep + 4) };
  }
  throw new Error('multipart 里没有文件');
}

const EXT_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};

function mimeOf(name) {
  return EXT_MIME[path.extname(String(name)).toLowerCase()] || 'application/octet-stream';
}

function friendlyError(error) {
  const msg = String((error && error.message) || error || '未知错误');
  if (/ECONNREFUSED|fetch failed/i.test(msg)) return '连不上 ComfyUI（默认 127.0.0.1:8188），请先启动它';
  if (/out of memory|OOM|CUDA error/i.test(msg)) return '显存不足：把「像素」调小，或先关掉别的占着显存的程序';
  return msg;
}

/** 任务存储：一个 JSON 文件，进程内串行写。 */
class JobStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'jobs.json');
    this.jobs = [];
    this.ready = this.load();
  }

  async load() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.jobs = Array.isArray(parsed) ? parsed : [];
    } catch {
      this.jobs = [];
    }
  }

  async persist() {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(this.jobs.slice(0, 200), null, 2), 'utf8');
  }

  async create(params) {
    await this.ready;
    const job = {
      id: 'fl_' + randomUUID().replace(/-/g, '').slice(0, 12),
      status: 'queued',
      stage: '排队',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      params,
      elapsedSeconds: 0,
    };
    this.jobs.unshift(job);
    await this.persist();
    return job;
  }

  async patch(id, patch) {
    await this.ready;
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: Date.now() });
    await this.persist();
    return job;
  }

  get(id) {
    return this.jobs.find((j) => j.id === id) || null;
  }

  list(limit = 20) {
    return this.jobs.slice(0, limit);
  }
}

async function saveMedia(dir, jobId, buffer) {
  const target = path.join(dir, 'videos');
  await fs.mkdir(target, { recursive: true });
  const file = path.join(target, jobId + '.mp4');
  await fs.writeFile(file, buffer);
  return file;
}

export const inject = ['tools'];

export function apply(ctx) {
  const tools = ctx.tools;
  const disposers = [];
  const jobs = new JobStore(DATA_DIR);

  /** 绝对路径自动上传到 ComfyUI input，返回可写进工作流的文件名。 */
  async function materialize(client, value) {
    const item = String(value || '').trim();
    if (!item) return '';
    if (!path.isAbsolute(item)) return item;
    const buffer = await fs.readFile(item);
    return client.upload(buffer, path.basename(item), mimeOf(item));
  }

  function startJob(job, params) {
    const client = new ComfyClient(params.host || DEFAULT_HOST);
    (async () => {
      try {
        await jobs.patch(job.id, { status: 'running', stage: '生成中' });
        const alive = await client.alive();
        if (alive === null) throw new Error('连不上 ComfyUI（默认 127.0.0.1:8188），请先启动它');
        if (alive.vramFreeGB < 22) {
          await jobs.patch(job.id, { warning: `空闲显存 ${alive.vramFreeGB} GB < 模型所需 ~22 GB，会走内存卸载，可能很慢` });
        }
        const out = await runFirstLast(client, params, {
          onSubmit: (promptId, summary) => jobs.patch(job.id, { promptId, summary }),
          onTick: (seconds) => {
            const live = jobs.get(job.id);
            if (live) { live.elapsedSeconds = seconds; live.updatedAt = Date.now(); }
          },
        });
        const file = await saveMedia(DATA_DIR, job.id, out.buffer);
        await jobs.patch(job.id, {
          status: 'done',
          stage: '完成',
          file,
          bytes: out.buffer.length,
          summary: out.summary,
          elapsedSeconds: Math.round((Date.now() - job.createdAt) / 1000),
          mediaUrl: `/api/comfyui-firstlast/media?id=${job.id}`,
        });
      } catch (error) {
        await jobs.patch(job.id, {
          status: 'failed',
          stage: '失败',
          error: friendlyError(error),
          elapsedSeconds: Math.round((Date.now() - job.createdAt) / 1000),
        });
      }
    })();
    return job;
  }

  disposers.push(tools.register({
    name: 'firstlast_generate',
    description:
      '首尾帧生视频（MiniMax H3 i2v）：给一张首帧（必填）和一张尾帧（可选），模型补出中间过程。两张图都可以是本机绝对路径（会自动上传），也可以是 ComfyUI input 里的文件名。16GB 显存跑这个模型很慢，建议 background。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '描述从首帧到尾帧之间发生了什么（动作、镜头、光线变化）' },
        firstFrame: { type: 'string', description: '首帧图片：绝对路径或 ComfyUI input 文件名（必填）' },
        lastFrame: { type: 'string', description: '尾帧图片：绝对路径或 ComfyUI input 文件名（可选）' },
        aspectRatio: { type: 'string', description: '比例，如 "16:9 (Widescreen)" / "9:16 (Portrait Widescreen)"' },
        megapixels: { type: 'number', description: '总像素（百万），0.2–1.0，默认 0.4' },
        inputMegapixels: { type: 'number', description: '输入图放大到的总像素，默认 0.9' },
        durationSeconds: { type: 'number', description: '时长秒数，2–15，默认 5（内部按 17n+5 帧对齐）' },
        seed: { type: 'number', description: '种子；不传则随机' },
        lightning: { type: 'boolean', description: 'true=LoRA 加速（默认），false=全量步数' },
        host: { type: 'string', description: 'ComfyUI 地址，默认 http://127.0.0.1:8188' },
        background: { type: 'boolean', description: 'true = 立刻返回任务 id，用 firstlast_status 查进度' },
      },
      required: ['prompt', 'firstFrame'],
    },
    output: OUTPUT,
    timeoutMs: 3600000,
    async execute(args) {
      const client = new ComfyClient(args.host || DEFAULT_HOST);
      const alive = await client.alive();
      if (alive === null) throw new Error('连不上 ComfyUI（默认 127.0.0.1:8188），请先启动它');

      const params = {
        ...args,
        firstFrame: await materialize(client, args.firstFrame),
        lastFrame: await materialize(client, args.lastFrame),
      };

      if (args.background === true) {
        const job = await jobs.create(params);
        startJob(job, params);
        return result([`已排入后台：${job.id}`, '用 firstlast_status 传这个 id 查进度']);

      }

      const startedAt = Date.now();
      const out = await runFirstLast(client, params);
      const job = await jobs.create(params);
      const file = await saveMedia(DATA_DIR, job.id, out.buffer);
      await jobs.patch(job.id, {
        status: 'done', stage: '完成', file, promptId: out.promptId, summary: out.summary,
        bytes: out.buffer.length, elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        mediaUrl: `/api/comfyui-firstlast/media?id=${job.id}`,
      });
      return result([
        `完成：${job.id}`,
        `文件：${file}`,
        `体积：${(out.buffer.length / 1024 / 1024).toFixed(1)} MB · 耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`,
        out.summary ? `参数：${out.summary.frames} 帧 / ${out.summary.durationSeconds}s / 种子 ${out.summary.seed}` : '',
        `预览：/api/comfyui-firstlast/media?id=${job.id}`,
      ]);

    },
  }));

  disposers.push(tools.register({
    name: 'firstlast_status',
    description: '查首尾帧生视频任务进度，或列出最近的任务。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '任务 id；不传则列出最近的' } },
    },
    output: OUTPUT,
    timeoutMs: 30000,
    async execute(args) {
      if (args.id) {
        const job = jobs.get(String(args.id));
        if (!job) throw new Error(`没有这个任务：${args.id}`);
        return result([
          `${job.id} · ${job.status} · ${job.stage}`,
          job.error ? `错误：${job.error}` : '',
          job.warning ? `提醒：${job.warning}` : '',
          job.file ? `文件：${job.file}` : '',
          job.elapsedSeconds ? `耗时：${job.elapsedSeconds}s` : '',
        ]);

      }
      const list = jobs.list(10).map((j) => ({
        id: j.id, status: j.status, stage: j.stage,
        createdAt: new Date(j.createdAt).toISOString(),
        seconds: j.elapsedSeconds || 0, error: j.error || '',
      }));
      return result(list.length
        ? list.map((j) => `${j.createdAt} · ${j.id} · ${j.status}${j.error ? ' · ' + j.error : ''} · ${j.seconds}s`)
        : ['还没有任务']);

    },
  }));

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.webServer;
    const base = '/api/comfyui-firstlast';

    disposers.push(webServer.register({
      kind: 'exact',
      path: base + '/meta',
      handler: async (request, response) => {
        if (request.method !== 'GET') return sendJson(response, 405, { error: 'GET only' });
        const client = new ComfyClient(DEFAULT_HOST);
        const alive = await client.alive();
        const models = alive ? await scanModels(client).catch(() => []) : [];
        sendJson(response, 200, {
          plugin: 'dsh-comfyui-firstlast',
          alive,
          models,
          limits: { minSeconds: 2, maxSeconds: 15, megapixels: [0.2, 1.0] },
        });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: base + '/run',
      handler: async (request, response) => {
        if (request.method !== 'POST') return sendJson(response, 405, { error: 'POST only' });
        try {
          const body = await readBody(request);
          const client = new ComfyClient(body.host || DEFAULT_HOST);
          const params = {
            ...body,
            firstFrame: await materialize(client, body.firstFrame),
            lastFrame: await materialize(client, body.lastFrame),
          };
          const job = await jobs.create(params);
          startJob(job, params);
          sendJson(response, 202, { job });
        } catch (error) {
          sendJson(response, 400, { error: friendlyError(error) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: base + '/job',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://x');
        const job = jobs.get(url.searchParams.get('id') || '');
        if (!job) return sendJson(response, 404, { error: '没有这个任务' });
        sendJson(response, 200, { job });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: base + '/jobs',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://x');
        const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 12));
        sendJson(response, 200, { jobs: jobs.list(limit) });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: base + '/upload',
      handler: async (request, response) => {
        if (request.method !== 'POST') return sendJson(response, 405, { error: 'POST only' });
        try {
          const chunks = [];
          let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > MAX_BYTES) throw new Error('文件超过 200MB');
            chunks.push(chunk);
          }
          const file = parseMultipart(Buffer.concat(chunks), request.headers['content-type']);
          const client = new ComfyClient(DEFAULT_HOST);
          const name = await client.upload(file.data, file.filename, mimeOf(file.filename));
          sendJson(response, 200, { name });
        } catch (error) {
          sendJson(response, 400, { error: friendlyError(error) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: base + '/media',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://x');
        const job = jobs.get(url.searchParams.get('id') || '');
        if (!job || !job.file) return sendJson(response, 404, { error: '还没有产物' });
        const stat = await fs.stat(job.file).catch(() => null);
        if (!stat) return sendJson(response, 404, { error: '文件已不在磁盘上' });
        const range = request.headers.range;
        const head = {
          'content-type': 'video/mp4',
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
        };
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          const start = m && m[1] ? Number(m[1]) : 0;
          const end = m && m[2] ? Number(m[2]) : stat.size - 1;
          response.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
          const stream = (await import('node:fs')).createReadStream(job.file, { start, end });
          stream.pipe(response);
          return;
        }
        response.writeHead(200, { ...head, 'content-length': stat.size });
        (await import('node:fs')).createReadStream(job.file).pipe(response);
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: base + '/frames',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://x');
        const name = url.searchParams.get('name') || '';
        if (!name) return sendJson(response, 400, { error: '缺少 name' });
        const client = new ComfyClient(DEFAULT_HOST);
        try {
          const buffer = await client.view(name);
          response.writeHead(200, { 'content-type': mimeOf(name), 'content-length': buffer.length, 'cache-control': 'no-store' });
          response.end(buffer);
        } catch (error) {
          sendJson(response, 404, { error: friendlyError(error) });
        }
      },
    }));
  });

  ctx.on('dispose', () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* ignore */ }
    }
  });
}

export { framesForSeconds };
