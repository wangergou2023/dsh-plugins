/**
 * dsh-comfyui-upscale —— 独立的「图片放大」插件（SeedVR2 7B int8）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ComfyClient } from './lib/comfy.js';
import { buildPrompt, run as runUpscale, saveImage, JobStore, loadSpec, availableInputImages, listOutputs, importFromOutput, friendlyError } from './lib/upscale.js';

const DATA_DIR = process.env.DSH_UPSCALE_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '.data');
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

/** 极简 multipart 解析（本插件自己的上传）。 */
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

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

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
        const out = await runUpscale(client, params, {
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
          mediaUrl: '/api/comfyui-upscale/media?id=' + job.id,
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
    name: 'upscale_image',
    description: '图片放大（SeedVR2 7B int8）。image 可传 ComfyUI input 里的文件名，也可传本机绝对路径（会自动上传）。显存紧张时调小 tileSize。注意：需要先下载 seedvr2 的两个模型文件。',
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: '输入图片：ComfyUI input 里的文件名，或本机绝对路径' },
        scale: { type: 'number', description: '放大倍数，1–8，默认 4' },
        tileSize: { type: 'number', description: '分块大小，256–1024，默认 512；显存不够就调小' },
        overlap: { type: 'number', description: '块间重叠，默认 128' },
        seed: { type: 'number', description: '种子；不传则随机' },
        colorCorrection: { type: 'string', description: '颜色校正：none / lab / adain' },
        host: { type: 'string', description: 'ComfyUI 地址，默认 http://127.0.0.1:8188' },
        background: { type: 'boolean', description: 'true = 立刻返回任务 id，用 upscale_status 查进度' },
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
        return text([
          `已排入后台任务 ${job.id}`,
          `ComfyUI ${alive.version} · ${alive.device} · 空闲 ${alive.vramFreeGB} GB`,
          '用 upscale_status 查进度。',
        ]);
      }

      const startedAt = Date.now();
      let result;
      try {
        result = await runUpscale(client, params);
      } catch (error) {
        throw new Error(friendlyError(error));
      }
      const job = jobs.create(params);
      const file = await saveImage(DATA_DIR, job.id, result.images[0]);
      await jobs.patch(job.id, {
        status: 'done', promptId: result.promptId, file, summary: result.summary,
        bytes: result.images[0].buffer.length,
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        mediaUrl: '/api/comfyui-upscale/media?id=' + job.id,
      });

      return text([
        `已放大 ${result.summary.scale}×：${result.summary.image}`,
        `分块 ${result.summary.tileSize} / 重叠 ${result.summary.overlap} · 种子 ${result.summary.seed}`,
        `文件：${file}`,
      ]);
    },
  }));

  disposers.push(tools.register({
    name: 'upscale_status',
    description: '查看放大任务状态，或列出最近的任务。',
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
      if (list.length === 0) return text(['还没有放大任务']);
      return text(list.map((job) => `· ${job.id} ${job.status}${job.elapsedSeconds ? ` ${job.elapsedSeconds}s` : ''}${job.error ? ' — ' + job.error : ''}`));
    },
  }));

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer');
    if (webServer === undefined) return;

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-upscale/meta',
      handler: async (_request, response) => {
        const spec = await loadSpec();
        const client = new ComfyClient();
        const probe = { host: client.host, ok: false, missingModels: [] };
        try {
          const res = await fetch(client.host + '/system_stats', { signal: AbortSignal.timeout(5000) });
          probe.status = res.status;
          if (res.ok) {
            const data = await res.json();
            probe.ok = true;
            probe.version = data.system?.comfyui_version;
            probe.device = data.devices?.[0]?.name;
            probe.vramFreeGB = Math.round(((data.devices?.[0]?.vram_free || 0) / 1024 ** 3) * 10) / 10;

            // 检查 SeedVR2 的两个模型在不在
            const need = [
              { cls: 'UNETLoader', field: 'unet_name', want: ['seedvr2_7b_int8_convrot.safetensors'], dir: 'diffusion_models' },
              { cls: 'VAELoader', field: 'vae_name', want: ['seedvr2_ema_vae_fp16.safetensors'], dir: 'vae' },
            ];
            for (const item of need) {
              try {
                const info = await fetch(client.host + '/object_info/' + item.cls, { signal: AbortSignal.timeout(8000) });
                const data = await info.json();
                const opts = data?.[item.cls]?.input?.required?.[item.field]?.[0] || [];
                for (const name of item.want) {
                  if (!opts.includes(name)) probe.missingModels.push({ name, dir: item.dir });
                }
              } catch { /* 忽略 */ }
            }
          }
        } catch (error) {
          probe.error = String((error && error.message) || error);
        }
        sendJson(response, 200, {
          knobs: spec.slots.knobs,
          inputImages: await availableInputImages(client.host),
          comfyui: probe.ok
            ? { online: true, version: probe.version, device: probe.device, vramFreeGB: probe.vramFreeGB, missingModels: probe.missingModels }
            : { online: false, probe },
        });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-upscale/upload',
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
      path: '/api/comfyui-upscale/preview',
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
      path: '/api/comfyui-upscale/run',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        let params = null;
        try { params = await readJsonBody(request); } catch { params = null; }
        if (!params || !String(params.image || '').trim()) {
          sendJson(response, 400, { error: 'image_required', message: '先选一张要放大的图片' });
          return;
        }
        const job = jobs.create(params);
        startJob(job, params);
        sendJson(response, 202, { job: { id: job.id, status: job.status } });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-upscale/job',
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
      path: '/api/comfyui-upscale/jobs',
      handler: async (_request, response) => {
        sendJson(response, 200, { jobs: jobs.list(20) });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-upscale/outputs',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const limit = Number(url.searchParams.get('limit') || 120) || 120;
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
      path: '/api/comfyui-upscale/import',
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
          const stored = await importFromOutput(client, name, subfolder);
          sendJson(response, 200, { name: stored });
        } catch (error) {
          sendJson(response, 404, { error: 'import_failed', message: String((error && error.message) || error) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-upscale/media',
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
  }, 'upscale tools');
}
