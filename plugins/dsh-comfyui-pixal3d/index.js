/**
 * dsh-comfyui-pixal3d —— 四视图转 3D 插件（Pixal3D + Trellis2）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ComfyClient } from './lib/comfy.js';
import { scanModels } from './lib/models.js';
import {
  loadSpec,
  run as runP3d,
  saveModel,
  mimeOf,
  JobStore,
  listOutputs,
  listImages,
  fetchImageSize,
  friendlyError,
} from './lib/p3d.js';

const DATA_DIR = process.env.DSH_PIXAL3D_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '.data');
const DEFAULT_HOST = 'http://127.0.0.1:8188';
const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

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
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readRawBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readJsonBody(request) {
  const buf = await readRawBody(request);
  if (buf.length === 0) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
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
        const out = await runP3d(client, params, {
          onSubmit: (promptId, summary) => { jobs.patch(job.id, { promptId, summary }); },
          onTick: (seconds) => {
            const live = jobs.get(job.id);
            if (live) { live.elapsedSeconds = seconds; live.updatedAt = Date.now(); }
          },
        });
        const file = await saveModel(DATA_DIR, job.id, out.model);
        await jobs.patch(job.id, {
          status: 'done',
          file,
          filename: out.model.filename,
          bytes: out.model.buffer.length,
          elapsedSeconds: Math.round((Date.now() - job.createdAt) / 1000),
          mediaUrl: '/api/comfyui-pixal3d/media?id=' + job.id,
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
    name: 'p3d_generate',
    description: '四视图转 3D（Pixal3D + Trellis2）。image 是一张四视图转盘图（前/左/后/右），可传 ComfyUI input 文件名或本机绝对路径；产出 GLB。',
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: '角色图（单图模式）或四视图转盘图（sheet 模式）：input 里的文件名或本机绝对路径' },
        mode: { type: 'string', enum: ['single', 'sheet'], description: 'single=一张图直接出 3D（默认推荐）；sheet=四视图转盘图' },
        layout: { type: 'string', enum: ['quarters', 'template'], description: 'sheet 模式下的切分方式：quarters 四等分 / template 模板坐标' },
        fov: { type: 'number', description: 'single 模式的相机水平 FOV，默认 20' },
        shapeSteps: { type: 'number', description: '形状采样步数，默认 20' },
        textureSteps: { type: 'number', description: '贴图采样步数，默认 12' },
        seed: { type: 'number', description: '种子；不传则随机（四个采样器共用）' },
        resolution: { type: 'number', description: '上采样分辨率，默认 1536' },
        remesh: { type: 'number', description: '重网格分辨率，默认 768' },
        textureSize: { type: 'number', description: '贴图尺寸，默认 4096' },
        host: { type: 'string', description: 'ComfyUI 地址，默认 http://127.0.0.1:8188' },
        background: { type: 'boolean', description: 'true = 立刻返回任务 id，用 p3d_status 查进度' },
      },
      required: ['image'],
    },
    output: OUTPUT,
    timeoutMs: 3600000,
    async execute(args) {
      const client = new ComfyClient(args.host || DEFAULT_HOST);
      const alive = await client.alive();
      if (alive === null) throw new Error('连不上 ComfyUI（默认 127.0.0.1:8188），请先启动它');

      const params = { ...args, image: await materialize(client, args.image) };

      if (args.background === true) {
        const job = jobs.create(params);
        startJob(job, params);
        return text([`已排入后台任务 ${job.id}`, `ComfyUI ${alive.version} · 空闲 ${alive.vramFreeGB} GB`, '用 p3d_status 查进度。']);
      }

      const startedAt = Date.now();
      let result;
      try {
        result = await runP3d(client, params);
      } catch (error) {
        throw new Error(friendlyError(error));
      }
      const job = jobs.create(params);
      const file = await saveModel(DATA_DIR, job.id, result.model);
      await jobs.patch(job.id, {
        status: 'done', promptId: result.promptId, file, summary: result.summary,
        filename: result.model.filename,
        bytes: result.model.buffer.length,
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        mediaUrl: '/api/comfyui-pixal3d/media?id=' + job.id,
      });
      return text([
        `已生成 3D：${result.model.filename}`,
        `${result.summary.shapeSteps} 步形状 · ${result.summary.textureSteps} 步贴图 · 种子 ${result.summary.seed}`,
        `文件：${file}`,
      ]);
    },
  }));

  disposers.push(tools.register({
    name: 'p3d_status',
    description: '查看 3D 生成任务状态，或列出最近的任务。',
    parameters: { type: 'object', properties: { id: { type: 'string', description: '任务 id；不传则列出最近的' } } },
    output: OUTPUT,
    async execute(args) {
      const id = String(args.id || '');
      if (id) {
        const job = jobs.get(id);
        if (!job) throw new Error('没有这个任务：' + id);
        return text([`${job.id} · ${job.status}${job.elapsedSeconds ? ` · ${job.elapsedSeconds}s` : ''}`, job.error ? `失败：${job.error}` : '', job.file ? `文件：${job.file}` : '']);
      }
      const list = jobs.list(10);
      if (list.length === 0) return text(['还没有 3D 生成任务']);
      return text(list.map((job) => `· ${job.id} ${job.status}${job.elapsedSeconds ? ` ${job.elapsedSeconds}s` : ''}${job.error ? ' — ' + job.error : ''}`));
    },
  }));

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer');
    if (webServer === undefined) return;

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-pixal3d/meta',
      handler: async (_request, response) => {
        const spec = await loadSpec();
        const client = new ComfyClient();
        const probe = { ok: false };
        try {
          const res = await fetch(client.host + '/system_stats', { signal: AbortSignal.timeout(5000) });
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
        const models = await scanModels(spec.template, client.host);
        const outputs = await listOutputs(80);
        const images = await listImages(80);
        sendJson(response, 200, {
          knobs: spec.slots.knobs,
          models,
          outputs: outputs.files,
          images: images.files,
          comfyui: probe.ok
            ? { online: true, version: probe.version, device: probe.device, vramFreeGB: probe.vramFreeGB }
            : { online: false, probe },
        });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-pixal3d/upload',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        try {
          const client = new ComfyClient();
          const files = parseMultipart(await readRawBody(request), request.headers['content-type']);
          if (!files.length) { sendJson(response, 400, { error: 'no_file', message: '没有收到文件' }); return; }
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
      path: '/api/comfyui-pixal3d/preview',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const filename = String(url.searchParams.get('filename') || '');
        if (!filename) { sendJson(response, 400, { error: 'filename_required' }); return; }
        const target = new ComfyClient().host + '/view?filename=' + encodeURIComponent(filename)
          + '&subfolder=' + encodeURIComponent(String(url.searchParams.get('subfolder') || ''))
          + '&type=' + encodeURIComponent(String(url.searchParams.get('type') || 'input'));
        try {
          const res = await fetch(target, { signal: AbortSignal.timeout(20000) });
          if (!res.ok) { sendJson(response, 404, { error: 'not_found' }); return; }
          const buf = Buffer.from(await res.arrayBuffer());
          response.writeHead(200, {
            'content-type': res.headers.get('content-type') || 'image/png',
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
      path: '/api/comfyui-pixal3d/inspect',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const filename = String(url.searchParams.get('filename') || '');
        if (!filename) { sendJson(response, 400, { error: 'filename_required' }); return; }
        const size = await fetchImageSize(new ComfyClient(), filename);
        sendJson(response, 200, size || { width: 0, height: 0 });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-pixal3d/outputs',
      handler: async (_request, response) => {
        try { sendJson(response, 200, await listOutputs(120)); } catch (error) {
          sendJson(response, 500, { error: 'list_failed', message: String((error && error.message) || error) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-pixal3d/run',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        const body = await readJsonBody(request);
        if (!body || !String(body.image || '').trim()) {
          sendJson(response, 400, { error: 'image_required', message: '先选一张四视图转盘图' });
          return;
        }
        const job = jobs.create(body);
        startJob(job, body);
        sendJson(response, 202, { job: { id: job.id, status: job.status } });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-pixal3d/job',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const job = jobs.get(String(url.searchParams.get('id') || ''));
        if (!job) { sendJson(response, 404, { error: 'not_found' }); return; }
        sendJson(response, 200, job);
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-pixal3d/jobs',
      handler: async (_request, response) => { sendJson(response, 200, { jobs: jobs.list(20) }); },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-pixal3d/media',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const job = jobs.get(String(url.searchParams.get('id') || ''));
        if (!job || !job.file) { sendJson(response, 404, { error: 'not_found' }); return; }
        let buffer;
        try { buffer = await fs.readFile(job.file); } catch { sendJson(response, 404, { error: 'file_missing' }); return; }
        const total = buffer.length;
        const type = mimeOf(job.file);
        const name = job.filename || path.basename(job.file);
        const range = request.headers.range;
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          if (m) {
            const start = m[1] ? Number(m[1]) : 0;
            const end = m[2] ? Number(m[2]) : total - 1;
            if (start >= total || end >= total || start > end) {
              response.writeHead(416, { 'content-range': `bytes */${total}` });
              response.end();
              return;
            }
            response.writeHead(206, {
              'content-type': type,
              'content-length': String(end - start + 1),
              'content-range': `bytes ${start}-${end}/${total}`,
              'accept-ranges': 'bytes',
              'content-disposition': `attachment; filename="${encodeURIComponent(name)}"`,
            });
            response.end(buffer.subarray(start, end + 1));
            return;
          }
        }
        response.writeHead(200, {
          'content-type': type,
          'content-length': String(total),
          'accept-ranges': 'bytes',
          'content-disposition': `attachment; filename="${encodeURIComponent(name)}"`,
        });
        response.end(buffer);
      },
    }));
  });

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose();
  }, 'pixal3d tools');
}
