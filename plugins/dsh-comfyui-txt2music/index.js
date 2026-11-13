/**
 * dsh-comfyui-txt2music —— 文生音乐插件（YuE2 3B）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { ComfyClient } from './lib/comfy.js';
import {
  loadSpec,
  run as runMusic,
  saveAudio,
  mimeOf,
  JobStore,
  listOutputs,
  friendlyError,
} from './lib/music.js';

const DATA_DIR = process.env.DSH_TXT2MUSIC_DATA || path.join(path.dirname(fileURLToPath(import.meta.url)), '.data');
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

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const buf = Buffer.concat(chunks);
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
  list.push({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user' } });
  return list;
}

export const inject = ['tools'];

export function apply(ctx) {
  const tools = ctx.tools;
  const disposers = [];
  const jobs = new JobStore(DATA_DIR);
  const records = [];

  function startJob(job, params) {
    const client = new ComfyClient(params.host || DEFAULT_HOST);
    (async () => {
      try {
        await jobs.patch(job.id, { status: 'running' });
        const alive = await client.alive();
        if (alive === null) throw new Error('连不上 ComfyUI（默认 127.0.0.1:8188），请先启动它');
        const out = await runMusic(client, params, {
          onSubmit: (promptId, summary) => { jobs.patch(job.id, { promptId, summary }); },
          onTick: (seconds) => {
            const live = jobs.get(job.id);
            if (live) { live.elapsedSeconds = seconds; live.updatedAt = Date.now(); }
          },
        });
        const file = await saveAudio(DATA_DIR, job.id, out.audio);
        await jobs.patch(job.id, {
          status: 'done',
          file,
          bytes: out.audio.buffer.length,
          elapsedSeconds: Math.round((Date.now() - job.createdAt) / 1000),
          mediaUrl: '/api/comfyui-txt2music/media?id=' + job.id,
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
    name: 'txt2music_generate',
    description: '文生音乐（YuE2 3B）。style 描述曲风（流派/乐器/人声/情绪），lyrics 用 [Verse]/[Chorus] 段落标记分行写；duration 是最长秒数。',
    parameters: {
      type: 'object',
      properties: {
        style: { type: 'string', description: '曲风描述，例如「Upbeat indie pop, warm female vocals, bright electric guitars, punchy drums」' },
        lyrics: { type: 'string', description: '歌词，用 [Verse] / [Chorus] 段落标记分行' },
        duration: { type: 'number', description: '最长时长（秒），默认 120，最大 600' },
        useAbc: { type: 'boolean', description: '是否先由 ABC 生成器写出曲式再合成，默认 true；关掉更快但结构弱' },
        mode: { type: 'string', enum: ['full', 'melody'], description: 'full=旋律+和弦（默认）；melody=仅旋律，用于翻唱' },
        steps: { type: 'number', description: '采样步数，默认 32' },
        cfg: { type: 'number', description: 'CFG，默认 1' },
        seed: { type: 'number', description: '种子；不传则随机' },
        format: { type: 'string', enum: ['flac', 'mp3', 'opus'], description: '输出格式，默认 flac' },
        quality: { type: 'string', description: 'mp3/opus 码率，如 V0 / 128k / 320k；flac 忽略' },
        host: { type: 'string', description: 'ComfyUI 地址，默认 http://127.0.0.1:8188' },
        background: { type: 'boolean', description: 'true = 立刻返回任务 id，用 txt2music_status 查进度' },
      },
      required: ['style', 'lyrics'],
    },
    output: OUTPUT,
    timeoutMs: 3600000,
    async execute(args) {
      const client = new ComfyClient(args.host || DEFAULT_HOST);
      const alive = await client.alive();
      if (alive === null) throw new Error('连不上 ComfyUI（默认 127.0.0.1:8188），请先启动它');

      if (args.background === true) {
        const job = jobs.create({ ...args });
        startJob(job, { ...args });
        return text([
          `已排入后台任务 ${job.id}`,
          `ComfyUI ${alive.version} · ${alive.device} · 空闲 ${alive.vramFreeGB} GB`,
          '用 txt2music_status 查进度。',
        ]);
      }

      const startedAt = Date.now();
      let result;
      try {
        result = await runMusic(client, args);
      } catch (error) {
        throw new Error(friendlyError(error));
      }
      const job = jobs.create({ ...args });
      const file = await saveAudio(DATA_DIR, job.id, result.audio);
      await jobs.patch(job.id, {
        status: 'done',
        promptId: result.promptId,
        file,
        summary: result.summary,
        bytes: result.audio.buffer.length,
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        mediaUrl: '/api/comfyui-txt2music/media?id=' + job.id,
      });

      return text([
        `已生成音乐：${result.summary.style}`,
        `${Math.round(result.summary.duration)} 秒上限 · ${result.summary.steps} 步 · 种子 ${result.summary.seed} · ${result.summary.format}`,
        `文件：${file}`,
      ]);
    },
  }));

  disposers.push(tools.register({
    name: 'txt2music_status',
    description: '查看文生音乐任务状态，或列出最近的任务。',
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
      if (list.length === 0) return text(['还没有文生音乐任务']);
      return text(list.map((job) => `· ${job.id} ${job.status}${job.elapsedSeconds ? ` ${job.elapsedSeconds}s` : ''}${job.error ? ' — ' + job.error : ''}`));
    },
  }));

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer');
    if (webServer === undefined) return;

    // ---------- meta ----------
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-txt2music/meta',
      handler: async (_request, response) => {
        const spec = await loadSpec();
        const client = new ComfyClient();
        const probe = { host: client.host, ok: false };
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
        const outputs = await listOutputs(120);
        sendJson(response, 200, {
          knobs: spec.slots.knobs,
          outputs: outputs.files,
          comfyui: probe.ok
            ? { online: true, version: probe.version, device: probe.device, vramFreeGB: probe.vramFreeGB }
            : { online: false, probe },
        });
      },
    }));

    // ---------- polish（只改曲风描述） ----------
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-txt2music/polish',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }

        const body = await readJsonBody(request);
        const raw = String((body && body.style) || '').trim();
        if (!raw) { sendJson(response, 400, { error: 'style_required', message: '先写一点曲风描述，再润化' }); return; }

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
          '你是音乐生成提示词的改写助手，服务的是 YuE2 文生音乐模型。',
          '任务：把用户给的曲风描述改写成更有效的一版，只输出曲风描述本身。',
          '',
          '硬性要求：',
          '1. 只输出曲风描述，不要解释、不要加标题、不要用代码块包裹。',
          '2. 保持原文语言（中文就中文，英文就英文）。',
          '3. 不要提到歌词内容或时长。',
          '',
          '改写方向：',
          '- 写清流派与子流派、速度（BPM 感）、调性。',
          '- 写清主奏乐器与音色特征（吉他、合成器、鼓组、弦乐等）。',
          '- 写清人声类型与唱法（男/女声、低沉/清亮、和声）。',
          '- 写清情绪与制作质感（lo-fi、干声近场、宽混响等）。',
          '- 控制在 1–2 句、原文的 1–2 倍长度。',
        ].join('\n');

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 90000);
        try {
          const options = {
            messages: hostMessages(system, `曲风描述：\n${raw}`),
            maxTokens: 500,
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

          if (!out) { sendJson(response, 502, { error: 'empty_completion', message: '模型没有返回正文，换个模型再试' }); return; }
          sendJson(response, 200, { text: out, model: selection ? selection.model : 'default' });
        } catch (error) {
          sendJson(response, 502, { error: 'llm_failed', message: String((error && error.message) || error) });
        } finally {
          clearTimeout(timer);
        }
      },
    }));

    // ---------- lyrics（按主题写词） ----------
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-txt2music/lyrics',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }

        const body = await readJsonBody(request);
        const mode = String((body && body.mode) || 'write');
        const original = String((body && body.lyrics) || '').trim();
        const theme = String((body && body.theme) || '').trim();
        if ((mode === 'polish' || mode === 'rewrite') && !original) {
          sendJson(response, 400, { error: 'lyrics_required', message: '先把歌词填进去，再点润化或改写' });
          return;
        }
        if (mode === 'write' && !theme) {
          sendJson(response, 400, { error: 'theme_required', message: '写一句主题或故事，再点写词' });
          return;
        }
        const style = String((body && body.style) || '').trim();
        const language = String((body && body.language) || '中文').trim();

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

        const writeSystem = [
          '你是写词的人，为歌曲写完整歌词。',
          '任务：根据用户给的主题写一首歌词，只输出歌词本身。',
          '',
          '硬性要求：',
          '1. 用 [Verse] / [Chorus] / [Bridge] / [Outro] 标记段落，副歌出现两次以上时内容保持一致。',
          '2. 一行一句，短句为主；不要押韵玩文字游戏，先把话说清楚。',
          '3. 用具体画面、动作、物件代替形容词和情绪词（例如写「门关上的声音」而不是「我很伤心」）。',
          '4. 副歌要有一句能被记住的句子，反复出现。',
          '5. 只输出歌词，不要标题、不要解释、不要代码块。',
        ].join('\n');

        const polishSystem = [
          '你是歌词润色的人。',
          '任务：把用户给的歌词改写得更好，只输出改写后的歌词本身。',
          '',
          '硬性要求：',
          '1. 保留原有的故事、人物、结构与段落标记，不要换题材。',
          '2. 把抽象的情绪词换成具体画面、动作、物件（「我很想你」→ 具体的一个动作或一样东西）。',
          '3. 收紧句子：能删的字删掉，一行一句，不要堆形容词。',
          '4. 副歌保留那句记忆点，措辞可以更利落，但意思不能变。',
          '5. 长度控制在原文的 0.8–1.2 倍。',
          '6. 只输出歌词，不要标题、不要解释、不要代码块。',
        ].join('\n');

        const rewriteSystem = [
          '你是歌词改写的人。',
          '任务：把用户给的歌词换一种写法重写一遍，只输出改写后的歌词本身。',
          '',
          '硬性要求：',
          '1. 保留原来的主题、人物与情感，但换一套意象和场景细节，不要照抄原句。',
          '2. 保留段落标记与整体结构（[Verse] / [Chorus] / [Bridge] / [Outro]）。',
          '3. 一行一句，短句为主；用具体画面代替情绪词。',
          '4. 副歌要重新写一句记忆点，比原来更利落。',
          '5. 长度控制在原文的 0.8–1.3 倍。',
          '6. 只输出歌词，不要标题、不要解释、不要代码块。',
        ].join('\n');

        const system = mode === 'polish'
          ? polishSystem
          : mode === 'rewrite'
            ? rewriteSystem
            : writeSystem;
        const user = mode === 'write'
          ? `主题：${theme}\n曲风：${style || '（未指定）'}\n语言：${language}`
          : `曲风：${style || '（未指定）'}\n语言：${language}\n\n原歌词：\n${original}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 180000);
        try {
          const options = {
            messages: hostMessages(system, user),
            maxTokens: 2400,
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

          if (!out) { sendJson(response, 502, { error: 'empty_completion', message: '模型没有返回歌词，换个模型再试' }); return; }
          sendJson(response, 200, { text: out, model: selection ? selection.model : 'default' });
        } catch (error) {
          sendJson(response, 502, { error: 'llm_failed', message: String((error && error.message) || error) });
        } finally {
          clearTimeout(timer);
        }
      },
    }));

    // ---------- outputs ----------
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-txt2music/outputs',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const limit = Number(url.searchParams.get('limit') || 120) || 120;
        try {
          sendJson(response, 200, await listOutputs(Math.min(500, Math.max(1, limit))));
        } catch (error) {
          sendJson(response, 500, { error: 'list_failed', message: String((error && error.message) || error) });
        }
      },
    }));

    // ---------- run ----------
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-txt2music/run',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        const body = await readJsonBody(request);
        if (!body || !String(body.style || '').trim()) {
          sendJson(response, 400, { error: 'style_required', message: '写一段曲风描述' });
          return;
        }
        if (!String(body.lyrics || '').trim()) {
          sendJson(response, 400, { error: 'lyrics_required', message: '歌词不能为空' });
          return;
        }
        const job = jobs.create(body);
        startJob(job, body);
        sendJson(response, 202, { job: { id: job.id, status: job.status } });
      },
    }));

    // ---------- job / jobs ----------
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-txt2music/job',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const job = jobs.get(String(url.searchParams.get('id') || ''));
        if (!job) { sendJson(response, 404, { error: 'not_found' }); return; }
        sendJson(response, 200, job);
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-txt2music/jobs',
      handler: async (_request, response) => {
        sendJson(response, 200, { jobs: jobs.list(20) });
      },
    }));

    // ---------- media（支持 Range，音频才能拖进度） ----------
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-txt2music/media',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const job = jobs.get(String(url.searchParams.get('id') || ''));
        if (!job || !job.file) { sendJson(response, 404, { error: 'not_found' }); return; }

        let buffer;
        try {
          buffer = await fs.readFile(job.file);
        } catch {
          sendJson(response, 404, { error: 'file_missing' });
          return;
        }
        const total = buffer.length;
        const type = mimeOf(job.file);
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
              'cache-control': 'private, max-age=3600',
            });
            response.end(buffer.subarray(start, end + 1));
            return;
          }
        }
        response.writeHead(200, {
          'content-type': type,
          'content-length': String(total),
          'accept-ranges': 'bytes',
          'cache-control': 'private, max-age=3600',
        });
        response.end(buffer);
      },
    }));
  });

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose();
    records.length = 0;
  }, 'txt2music tools');
}
