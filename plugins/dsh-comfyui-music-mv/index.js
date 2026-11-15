/**
 * dsh-comfyui-music-mv —— 音乐 MV 生成插件。
 *
 * 一条链：出歌（YuE2）→ 主角定妆图（Krea2）→ 每镜头 5–15s 视频（MiniMax H3）
 *        → ConcatenateVideo 拼起来 + complete_audio 压原曲 → 成品 mp4。
 *
 * 为什么这么设计：H3 单段最多 15 秒，所以 MV 必然是 N 个镜头拼；
 * 镜头自带的音轨一律丢掉，整首歌只在拼接时压一次，音画不会串。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { ComfyClient } from './lib/comfy.js';
import { applyModelOverrides } from './lib/models.js';
import { buildPrompt as buildSongPrompt, fetchAudio as fetchSongAudio, saveAudio } from './lib/music.js';
import { buildPrompt as buildT2iPrompt } from './lib/t2i.js';
import {
  LIMITS, audioDuration, buildFramePrompt, buildShotVideoPrompt, buildTailFramePrompt,
  buildStitchPrompt, fetchVideo, fetchComfyImage, firstOutputImage, saveVideo, saveFrame,
  normalizePlan, parsePlanJson, suggestShotCount,
} from './lib/mv.js';
import { vocab, cameraSummary } from './lib/shotlang.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DSH_MUSIC_MV_DATA || path.join(HERE, '.data');
const DEFAULT_HOST = 'http://127.0.0.1:8188';

const ASPECTS = ['16:9 (Widescreen)', '9:16 (Portrait)', '1:1 (Square)', '4:3 (Standard)', '3:4 (Portrait)', '21:9 (Cinematic)'];

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv']);
const AUDIO_EXT = new Set(['.flac', '.mp3', '.wav', '.ogg', '.opus', '.m4a']);

/* ---------------------------- 工具函数 ---------------------------- */

function text(lines) {
  return { lines: (lines || []).filter((l) => l !== '' && l !== undefined && l !== null) };
}

const OUTPUT = {
  schema: { type: 'object' },
  render(_args, value) {
    const lines = value && Array.isArray(value.lines) ? value.lines : [];
    return [{ type: 'text', text: lines.join('\n') }];
  },
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
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

async function readUploads(request) {
  const buf = await readRawBody(request);
  return parseMultipart(buf, (request.headers && request.headers['content-type']) || '');
}

function mimeOfName(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (VIDEO_EXT.has(ext)) return ext === '.webm' ? 'video/webm' : ext === '.mov' ? 'video/quicktime' : 'video/mp4';
  if (AUDIO_EXT.has(ext)) return ext === '.flac' ? 'audio/flac' : ext === '.mp3' ? 'audio/mpeg' : ext === '.wav' ? 'audio/wav' : 'audio/ogg';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

/** 宿主 llm 要富消息：content 必须是 parts 数组，每条带 id 与 source。 */
function hostMessages(systemText, userText) {
  const list = [];
  if (systemText) {
    list.push({ id: randomUUID(), role: 'system', content: [{ type: 'text', text: systemText }], source: { kind: 'system-prompt' } });
  }
  list.push({ id: randomUUID(), role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user' } });
  return list;
}

/** 一口气取回 LLM 正文（兼容 text-delta 与 block-end 两种下发方式）。 */
async function llmText(ctx, system, user, options = {}) {
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

function friendlyError(error) {
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

const MAX_JOBS = 30;

class JobStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'mv-jobs.json');
    this.jobs = new Map();
    this.mtime = 0;
    this.ready = this.load();
  }

  async load(clear = false) {
    try {
      const list = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!Array.isArray(list)) return;
      if (clear) this.jobs = new Map();
      for (const job of list) this.jobs.set(job.id, job);
    } catch { /* 首次运行 */ }
  }

  /**
   * 磁盘上有更新就重读。
   * 插件重载后可能同时存在两个实例，共用一个 jobs.json：跑任务的那个在写，
   * 显示状态的那个如果不重读，就会一直报旧阶段（曾显示卡在"定妆图"而实际已在渲染）。
   */
  async refresh() {
    try {
      const stat = await fs.stat(this.file);
      if (stat.mtimeMs === this.mtime) return;
      this.mtime = stat.mtimeMs;
      await this.load(true);
    } catch { /* 文件还没写出来 */ }
  }

  async persist() {
    const list = [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_JOBS);
    this.jobs = new Map(list.map((job) => [job.id, job]));
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(list, null, 2), 'utf8');
    try { this.mtime = (await fs.stat(this.file)).mtimeMs; } catch { /* 忽略 */ }
  }

  create(params) {
    const id = 'mv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const job = { id, status: 'queued', stage: 'queued', createdAt: Date.now(), updatedAt: Date.now(), params, shots: [] };
    this.jobs.set(id, job);
    return job;
  }

  get(id) { return this.jobs.get(id) || null; }

  list(limit = 20) {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  async patch(id, patch) {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: Date.now() });
    await this.persist();
    return job;
  }

  async patchShot(id, index, patch) {
    const job = this.jobs.get(id);
    if (!job) return null;
    const shot = job.shots.find((s) => s.index === index);
    if (shot) Object.assign(shot, patch);
    job.updatedAt = Date.now();
    await this.persist();
    return job;
  }
}

/* ---------------------------- 分镜表生成 ---------------------------- */

function planSystemPrompt(shotCount, duration) {
  return [
    '你是音乐 MV 的导演兼作词。用户给一个主题，你要产出一支 MV 的完整方案：故事、歌词、分镜。',
    '只输出一个 JSON 对象，不要解释，不要代码块。',
    '',
    'JSON 结构：',
    '{',
    '  "title": "歌名（中文，短）",',
    '  "logline": "一句话故事：谁、想要什么、被什么拦住",',
    '  "arc": "情绪曲线：起…（前奏）承…（主歌）转…（副歌爆发）合…（尾声）",',
    '  "ending": "结尾画面：最后一个镜头怎么收",',
    '  "notes": "导演阐述一两句：视觉基调、调色、为什么这么拍",',
    '  "style": "曲风（英文更稳）：流派、乐器、人声、情绪、速度",',
    '  "character": "主角外形一句话，全片同一个人：年龄性别、发型发色、五官特征、服装",',
    '  "lyrics": "完整歌词，用 [Verse] [Chorus] [Bridge] 标记段落，每句一行",',
    '  "shots": [{',
    '    "label": "镜头标题（两句内）",',
    '    "section": "对应哪段歌词，例如 [Chorus] 第1句",',
    '    "beat": "这一镜的情绪，两三个词",',
    '    "scene": "地点与环境，写具体：什么样的地方、有什么东西",',
    '    "time": "时间与天气，例如 深夜暴雨 / 清晨微光",',
    '    "size": "景别：extreme_wide|wide|medium|close|extreme_close",',
    '    "horizontal": "机位方向：front|front_left|left|back_left|back|back_right|right|front_right",',
    '    "elevation": "俯仰：worm|low|eye|high",',
    '    "move": "运镜：static|push|pull|pan|tilt|tracking|crane_up|crane_down|orbit|handheld",',
    '    "light": "灯光：natural|front|side|backlit|top|under|soft|dramatic|golden|blue|night|neon",',
    '    "dof": "景深：extreme_shallow|shallow|medium|deep",',
    '    "transition": "怎么接下一镜：cut|dissolve|match|whip|fade",',
    '    "action": "人物在这一镜做什么，具体到身体动作与表情；不写歌词、不写镜头参数",',
    '    "dialogue": "这一镜要对口型唱的那一句歌词（可留空）"',
    '  }]',
    '}',
    '',
    '硬性规则：',
    `1. shots 必须正好 ${shotCount} 个，一个不多一个不少。`,
    `2. 整首歌约 ${duration} 秒，所以每个镜头约 ${Math.round(duration / shotCount)} 秒。`,
    '3. 分镜必须服务故事：镜头顺序就是情绪推进顺序；主角从开头到结尾要有变化。',
    '4. 景别必须有节奏地变化，不要连着三镜都是中景；运镜一镜只用一种。',
    '5. action 只写画面：人物动作、表情、与环境的关系。绝对不能写歌词、字幕、文字、水印。',
    '6. 主角始终是同一个人（脸、发型、服装不变），可以换环境、换景别、换机位。',
    '7. 不要出现「四视图」「多视角」「分屏」「拼图」这类排版词。',
    '8. 歌词要能唱：副歌重复、句子短、押韵。',
  ].join('\n');
}

async function generatePlan(ctx, params) {
  const duration = Math.min(LIMITS.songMaxSeconds, Math.max(LIMITS.songMinSeconds, Number(params.duration) || 60));
  const shotCount = Math.max(1, Math.min(LIMITS.maxShots, Number(params.shotCount) || suggestShotCount(duration)));
  const theme = String(params.theme || '').trim();
  if (!theme) throw new Error('先给一个主题（一句话就行）');

  const userLines = [
    `主题：${theme}`,
    `时长：${duration} 秒`,
    `镜头数：${shotCount}`,
  ];
  if (String(params.style || '').trim()) userLines.push(`曲风必须贴近：${String(params.style).trim()}`);
  if (String(params.lyrics || '').trim()) userLines.push(`歌词用我给的这版（只补段落标记，不要重写）：\n${String(params.lyrics).trim()}`);

  const { text: raw, model } = await llmText(ctx, planSystemPrompt(shotCount, duration), userLines.join('\n'), { maxTokens: 4000 });
  const data = parsePlanJson(raw);
  const plan = normalizePlan(data, { duration, shotCount });
  return { plan, model, raw };
}

/* ---------------------------- 主流程 ---------------------------- */

async function ensureComfyFile(client, value, kind) {
  const item = String(value || '').trim();
  if (!item) return null;
  if (!path.isAbsolute(item)) return item; // 已经是 ComfyUI input 里的文件名
  const buffer = await fs.readFile(item);
  const name = await client.upload(buffer, path.basename(item), mimeOfName(item));
  return name;
}

async function readLocalFile(value) {
  const item = String(value || '').trim();
  if (!item || !path.isAbsolute(item)) return null;
  const buffer = await fs.readFile(item);
  return { buffer, name: path.basename(item) };
}

/* ---------- 单镜头的两步：静帧 / 视频 ---------- */

/** 出这一镜的静帧（Krea2）。产物落盘 + 传进 ComfyUI input，返回文件名。 */
async function renderFrame(client, job, plan, shot, params) {
  const built = await buildFramePrompt(plan, shot, {
    aspectRatio: params.aspectRatio || '16:9 (Widescreen)',
    megapixels: params.frameMegapixels || 1.0,
    steps: params.frameSteps || 8,
    seed: params.frameSeed,
    filenamePrefix: `mv_frame/${job.id}_${shot.index + 1}`,
  });
  applyModelOverrides(built.prompt, params.models);
  const promptId = await client.submit(built.prompt);
  const entry = await client.wait(promptId, 1200000);
  const item = firstOutputImage(entry, '29');
  if (!item) throw new Error('静帧没有产出');
  const buffer = await fetchComfyImage(client, item);
  const stamp = Date.now().toString(36);
  const fileName = `frame_${String(shot.index + 1).padStart(2, '0')}_${stamp}.png`;
  const file = await saveFrame(path.join(DATA_DIR, job.id), fileName, buffer);
  const name = await client.upload(buffer, `mvf_${job.id}_${shot.index + 1}_${stamp}.png`, 'image/png');
  return { name, file, seed: built.summary.seed, promptText: built.promptText };
}

/** 用静帧当首帧、定妆图当身份，出这一镜的视频（H3 ref2va）。 */
async function renderShotVideo(client, job, plan, shot, options) {
  const built = await buildShotVideoPrompt(plan, shot, {
    frameImage: options.frameImage,
    heroImage: job.hero && job.hero.name,
    aspectRatio: options.aspectRatio,
    megapixels: options.megapixels || 0.4,
    seed: options.seed,
    lightning: options.lightning !== false,
    refImageSize: options.refImageSize || 'match',
  });
  applyModelOverrides(built.prompt, options.models);
  const promptId = await client.submit(built.prompt);
  const entry = await client.wait(promptId, options.timeoutMs || 3600000);
  const { buffer, duration } = await fetchVideo(client, entry, { nodeId: '92' });
  const fileName = `shot_${String(shot.index + 1).padStart(2, '0')}.mp4`;
  const file = await saveVideo(path.join(DATA_DIR, job.id), fileName, buffer);
  const comfy = await client.upload(buffer, `mv_${job.id}_${shot.index + 1}.mp4`, 'video/mp4');
  return { file, comfy, bytes: buffer.length, duration, seed: built.summary.seed, promptText: built.promptText };
}

/** 抽上一镜的最后一帧，当下一镜的首帧（末帧接龙）。抽不到返回 null。 */
async function extractTail(client, job, prevShot) {
  const dur = Number(prevShot.videoDuration) || 0;
  const graph = buildTailFramePrompt({
    video: prevShot.comfyVideo,
    startTime: Math.max(0, dur - 0.15),
    filenamePrefix: `mv_tail/${job.id}_${prevShot.index + 1}`,
  });
  const promptId = await client.submit(graph);
  const entry = await client.wait(promptId, 600000);
  const item = firstOutputImage(entry, '4');
  if (!item) return null;
  const buffer = await fetchComfyImage(client, item);
  const stamp = Date.now().toString(36);
  const name = await client.upload(buffer, `mvt_${job.id}_${prevShot.index + 1}_${stamp}.png`, 'image/png');
  // 落盘一份：面板显示的首帧也要换成这张，否则用户看到的还是原来那张静帧
  const file = await saveFrame(
    path.join(DATA_DIR, job.id),
    `tail_${String(prevShot.index + 1).padStart(2, '0')}_${stamp}.png`,
    buffer,
  );
  return { name, file };
}

async function execute(job, params) {
  const client = new ComfyClient(params.host || DEFAULT_HOST);
  const alive = await client.alive();
  if (alive === null) throw new Error('连不上 ComfyUI（默认 127.0.0.1:8188），请先启动它');

  const total = () => (job.shots || []).length;

  /* 1. 歌 */
  /* 1. 剧本（先有曲风和歌词，才能出歌） */
  await jobPatch(job.id, { stage: 'plan', stageLabel: '写剧本', error: null });
  let plan;
  if (params.plan && typeof params.plan === 'object') {
    plan = normalizePlan(params.plan, { duration: params.duration, shotCount: params.shotCount });
  } else {
    // 注意：ctx 不能塞进 params —— 任务会被写成 json，ctx 是循环引用。
    const generated = await generatePlan(hostCtx, {
      theme: params.theme,
      style: params.style,
      lyrics: params.lyrics,
      duration: params.duration,
      shotCount: params.shotCount,
    });
    plan = generated.plan;
  }
  await jobPatch(job.id, { plan });

  /* 2. 歌 */
  await jobPatch(job.id, { stage: 'song', stageLabel: '生成歌曲' });
  let songName;
  let songBuffer;
  let songFileName;
  let songInfo;

  const existingSong = String(params.song || '').trim();
  if (existingSong) {
    const local = await readLocalFile(existingSong);
    if (local) {
      songBuffer = local.buffer;
      songFileName = local.name;
      songName = await client.upload(songBuffer, songFileName, mimeOfName(songFileName));
    } else {
      songName = existingSong;
      const res = await fetch(client.host + '/view?filename=' + encodeURIComponent(existingSong) + '&type=input', { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error('取不到指定的音频：' + existingSong);
      songBuffer = Buffer.from(await res.arrayBuffer());
      songFileName = existingSong;
    }
    songInfo = audioDuration(songBuffer, songFileName);
  } else {
    const built = await buildSongPrompt({
      style: plan.style || params.style,
      lyrics: plan.lyrics || params.lyrics,
      duration: plan.duration || params.duration,
      format: 'flac',
      steps: params.songSteps,
      seed: params.songSeed,
      filenamePrefix: 'mv/' + job.id,
    });
    applyModelOverrides(built.prompt, params.models);
    const promptId = await client.submit(built.prompt);
    const entry = await client.wait(promptId, 3600000);
    const audio = await fetchSongAudio(client, entry);
    songBuffer = audio.buffer;
    songFileName = audio.filename;
    songInfo = audioDuration(songBuffer, songFileName);
    songName = await client.upload(songBuffer, 'mv_' + job.id + path.extname(songFileName || '.flac'), mimeOfName(songFileName));
  }
  if (!songInfo || !songInfo.duration) {
    throw new Error('读不出音频时长（只支持 flac/mp3）：请用 flac 格式出歌，或手动指定 songSeconds');
  }
  const songDuration = Number(params.songSeconds) || songInfo.duration;
  const savedSong = await saveAudio(DATA_DIR, job.id, { buffer: songBuffer, filename: songFileName || 'song.flac' });
  await jobPatch(job.id, {
    song: { file: savedSong, name: songName, duration: songDuration, estimated: !!songInfo.estimated },
  });

  /* 3. 按真实歌长重排时间轴：歌是 YuE2 生成的，实际长度和请求值不一定一样 */
  plan = normalizePlan(plan, { duration: songDuration, shotCount: params.shotCount });
  // 续跑时不能把已经出好的静帧/视频冲掉：按 index 把运行时产物接回来
  const existing = new Map((job.shots || []).map((s) => [s.index, s]));
  const shots = plan.shots.map((shot) => {
    const prev = existing.get(shot.index) || {};
    return {
      ...shot,
      frame: prev.frame || null,
      frameFile: prev.frameFile || null,
      frameVersions: prev.frameVersions || [],
      frameStatus: prev.frame ? 'done' : 'pending',
      frameFromTail: prev.frameFromTail || false,
      video: prev.video || null,
      comfyVideo: prev.comfyVideo || null,
      videoStatus: prev.video ? 'done' : 'pending',
      videoDuration: prev.videoDuration || null,
      error: null,
      elapsedSeconds: prev.elapsedSeconds || 0,
    };
  });
  await jobPatch(job.id, { plan, shots, total: shots.length });

  /* 4. 主角定妆图 */
  await jobPatch(job.id, { stage: 'hero', stageLabel: '生成主角定妆图' });
  let heroImage = null;
  if (job.hero && job.hero.name && params.resume !== false) {
    heroImage = job.hero.name;
  } else if (params.heroImage) {
    heroImage = await ensureComfyFile(client, params.heroImage, 'image');
  } else if (params.autoHero !== false) {
    const heroPrompt = [
      plan.character || '一位年轻的主角',
      '单人半身肖像，正面看镜头，五官清晰，光线均匀',
      plan.style ? `风格：${plan.style}` : '',
      '电影感写真，纯色浅背景，不要文字',
    ].filter(Boolean).join('，');
    const built = await buildT2iPrompt({
      prompt: heroPrompt,
      aspectRatio: params.heroAspect || '1:1 (Square)',
      megapixels: 1.0,
      steps: params.heroSteps || 8,
      filenamePrefix: 'mv_hero/' + job.id,
    });
    applyModelOverrides(built.prompt, params.models);
    const promptId = await client.submit(built.prompt);
    const entry = await client.wait(promptId, 1800000);
    const item = Object.values(entry.outputs || {}).flatMap((o) => o.images || [])[0];
    if (!item) throw new Error('定妆图没有产出');
    const url = client.host + '/view?filename=' + encodeURIComponent(item.filename)
      + '&subfolder=' + encodeURIComponent(item.subfolder || '') + '&type=' + encodeURIComponent(item.type || 'output');
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    const buffer = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(path.join(DATA_DIR, job.id), { recursive: true });
    const heroFile = path.join(DATA_DIR, job.id, 'hero.png');
    await fs.writeFile(heroFile, buffer);
    heroImage = await client.upload(buffer, 'mv_hero_' + job.id + '.png', 'image/png');
    await jobPatch(job.id, { hero: { file: heroFile, name: heroImage } });
  }

  /* 5. 静帧：每镜一张，先给人看，不满意可以单张重 roll */
  const phase = String(params.phase || 'all');
  const wantFrames = phase === 'all' || phase === 'frames';
  const wantVideos = phase === 'all' || phase === 'videos';
  const opt = {
    aspectRatio: params.aspectRatio || '16:9 (Widescreen)',
    megapixels: params.megapixels || 0.4,
    seed: params.seed,
    lightning: params.lightning !== false,
    refImageSize: params.refImageSize || 'match',
    models: params.models,
    timeoutMs: params.shotTimeoutMs,
  };

  if (wantFrames) {
    await jobPatch(job.id, { stage: 'frames', stageLabel: '生成分镜静帧' });
    for (const shot of job.shots) {
      if (shot.frame && params.resume !== false) continue;
      await jobPatch(job.id, { currentShot: shot.index });
      await jobPatchShot(job.id, shot.index, { frameStatus: 'running', error: null, frameStartedAt: Date.now() });
      try {
        const still = await renderFrame(client, job, plan, shot, params);
        await jobPatchShot(job.id, shot.index, {
          frame: still.name,
          frameFile: still.file,
          frameStatus: 'done',
          framePromptText: still.promptText,
          frameSeed: still.seed,
          frameAt: Date.now(),
          frameVersions: [...(shot.frameVersions || []), { name: still.name, file: still.file, at: Date.now() }].slice(-6),
        });
      } catch (error) {
        await jobPatchShot(job.id, shot.index, { frameStatus: 'failed', error: friendlyError(error) });
        throw new Error(`第 ${shot.index + 1} 镜的静帧失败：${friendlyError(error)}`);
      }
    }
    await jobPatch(job.id, { framesDone: true });
  }

  if (phase === 'frames') {
    await jobPatch(job.id, { status: 'paused', stage: 'frames', stageLabel: '静帧就绪，等你审' });
    return;
  }

  /* 6. 视频：首帧 = 本镜静帧；开了接龙就用上一镜末帧覆盖 */
  if (wantVideos) {
    await jobPatch(job.id, { stage: 'videos', stageLabel: '逐镜生成视频' });
    const tailLink = params.tailLink !== false;
    for (const shot of job.shots) {
      if (shot.video && shot.comfyVideo && params.resume !== false) continue;
      if (!shot.frame) throw new Error(`第 ${shot.index + 1} 镜还没有静帧，先出静帧`);
      let frameName = shot.frame;
      if (tailLink && shot.index > 0) {
        const prev = job.shots[shot.index - 1];
        if (prev && prev.comfyVideo) {
          try {
            const tail = await extractTail(client, job, prev);
            if (tail) {
              frameName = tail.name;
              await jobPatchShot(job.id, shot.index, { frame: tail.name, frameFile: tail.file, frameFromTail: true });
            }
          } catch { /* 抽不到就用本镜自己的静帧，不阻断 */ }
        }
      }
      await jobPatch(job.id, { currentShot: shot.index });
      await jobPatchShot(job.id, shot.index, { videoStatus: 'running', error: null, videoStartedAt: Date.now() });
      try {
        const live = job.shots.find((s) => s.index === shot.index) || shot;
        const made = await renderShotVideo(client, job, plan, live, { ...opt, frameImage: frameName });
        await jobPatchShot(job.id, shot.index, {
          frame: frameName,
          video: made.file,
          comfyVideo: made.comfy,
          videoStatus: 'done',
          bytes: made.bytes,
          videoPromptText: made.promptText,
          videoSeed: made.seed,
          videoDuration: made.duration,
          videoAt: Date.now(),
          elapsedSeconds: Math.round((Date.now() - (shot.videoStartedAt || Date.now())) / 1000),
        });
        await jobPatch(job.id, { done: job.shots.filter((s) => s.videoStatus === 'done').length });
      } catch (error) {
        await jobPatchShot(job.id, shot.index, { videoStatus: 'failed', error: friendlyError(error) });
        throw new Error(`第 ${shot.index + 1} 个镜头失败：${friendlyError(error)}`);
      }
    }
  }

  /* 7. 拼接 + 压曲 */
  await jobPatch(job.id, { stage: 'stitch', stageLabel: '拼接并压上原曲' });
  const clips = job.shots.map((s) => s.comfyVideo).filter(Boolean);
  if (clips.length === 0) throw new Error('没有可拼接的镜头视频');
  const graph = buildStitchPrompt({
    clips,
    audio: songName,
    filenamePrefix: 'video/MV_' + job.id,
    trimSeconds: songDuration,
  });
  const promptId = await client.submit(graph);
  const entry = await client.wait(promptId, 1800000);
  const { buffer: finalBuffer } = await fetchVideo(client, entry, { nodeId: '2002' });
  const finalFile = await saveVideo(DATA_DIR, job.id + '.mp4', finalBuffer);

  await jobPatch(job.id, {
    status: 'done',
    stage: 'done',
    stageLabel: '完成',
    file: finalFile,
    bytes: finalBuffer.length,
    mediaUrl: '/api/comfyui-music-mv/media?id=' + job.id,
    elapsedSeconds: Math.round((Date.now() - job.createdAt) / 1000),
  });
}

let jobStore;
let hostCtx = null;

async function jobPatch(id, patch) {
  return jobStore ? jobStore.patch(id, patch) : null;
}

async function jobPatchShot(id, index, patch) {
  return jobStore ? jobStore.patchShot(id, index, patch) : null;
}

function startJob(job, params) {
  (async () => {
    try {
      await jobStore.patch(job.id, { status: 'running' });
      await execute(job, params);
    } catch (error) {
      await jobStore.patch(job.id, {
        status: 'failed',
        stage: 'failed',
        error: friendlyError(error),
        elapsedSeconds: Math.round((Date.now() - job.createdAt) / 1000),
      });
    }
  })();
  return job;
}

/* ---------------------------- 插件 ---------------------------- */

export const inject = ['tools'];

export function apply(ctx) {
  const tools = ctx.tools;
  const disposers = [];
  jobStore = new JobStore(DATA_DIR);
  hostCtx = ctx;

  async function meta() {
    const client = new ComfyClient();
    const probe = { host: client.host, online: false };
    try {
      const res = await fetch(client.host + '/system_stats', { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        probe.online = true;
        probe.version = data.system?.comfyui_version;
        probe.device = data.devices?.[0]?.name;
        probe.vramFreeGB = Math.round(((data.devices?.[0]?.vram_free || 0) / 1024 ** 3) * 10) / 10;
      }
    } catch (error) {
      probe.error = String((error && error.message) || error);
    }
    return {
      limits: LIMITS,
      aspects: ASPECTS,
      defaults: { duration: 60, aspectRatio: '16:9 (Widescreen)', megapixels: 0.4, shotSeconds: 8, songFormat: 'flac' },
      stages: [
        { key: 'plan', label: '写剧本' },
        { key: 'song', label: '生成歌曲' },
        { key: 'hero', label: '定妆图' },
        { key: 'frames', label: '分镜静帧' },
        { key: 'videos', label: '镜头视频' },
        { key: 'stitch', label: '拼接压曲' },
      ],
      vocab: vocab(),
      comfyui: probe,
    };
  }

  /* ------------------- 工具 ------------------- */

  tools.register({
    name: 'mv_plan',
    description: '音乐 MV 第一步：给一个主题，产出歌名、曲风、歌词、主角外形和分镜表（不占 GPU）。返回可直接看的 JSON。',
    parameters: {
      type: 'object',
      properties: {
        theme: { type: 'string', description: '主题，一句话，例如「失恋后在雨夜街头走了很久」' },
        duration: { type: 'number', description: '歌曲时长秒数，15–600，默认 60' },
        shotCount: { type: 'number', description: '镜头数；不填按每镜约 10 秒自动算' },
        style: { type: 'string', description: '指定曲风（可选）' },
        lyrics: { type: 'string', description: '自带歌词（可选），那就只补段落标记不重写' },
      },
      required: ['theme'],
    },
    output: OUTPUT,
    timeoutMs: 240000,
    async execute(args) {
      const { plan, model } = await generatePlan(ctx, args);
      const story = plan.story || {};
      const lines = [
        `《${plan.title}》 · ${plan.duration}s · ${plan.shotCount} 个镜头 · ${model}`,
        story.logline ? `故事：${story.logline}` : '',
        story.arc ? `情绪：${story.arc}` : '',
        story.ending ? `结尾：${story.ending}` : '',
        story.notes ? `阐述：${story.notes}` : '',
        `曲风：${plan.style}`,
        `主角：${plan.character}`,
        '',
        '剧本 / 分镜：',
        ...plan.shots.map((s) => [
          `${s.index + 1}. [${s.start}s-${s.end}s] ${s.label}${s.section ? ` · 对位 ${s.section}` : ''}${s.beat ? ` · ${s.beat}` : ''}`,
          `   镜头：${cameraSummary(s)} ｜ 转场：${s.transition || '—'}`,
          `   场景：${s.scene || '—'}${s.time ? `（${s.time}）` : ''}`,
          `   动作：${s.action || '—'}`,
        ].join('\n')),
        '',
        '歌词：',
        ...plan.lyrics.split('\n'),
        '',
        'JSON（可直接喂给 mv_render 的 plan）：',
        JSON.stringify(plan),
      ];
      return text(lines);
    },
  });

  tools.register({
    name: 'mv_render',
    description: '音乐 MV 全流程：出歌 → 定妆图 → 逐镜头渲染（每镜 5–15 秒，MiniMax H3）→ 拼接并压上原曲，后台跑。用 mv_status 查进度。',
    parameters: {
      type: 'object',
      properties: {
        theme: { type: 'string', description: '主题；给了 plan 时可省' },
        plan: { type: 'object', description: 'mv_plan 产出的 JSON；不传就现生成' },
        duration: { type: 'number', description: '歌曲时长秒数，默认 60' },
        shotCount: { type: 'number', description: '镜头数' },
        style: { type: 'string', description: '曲风（英文更稳）' },
        lyrics: { type: 'string', description: '歌词（带 [Verse]/[Chorus]）' },
        song: { type: 'string', description: '用现成的歌：本机绝对路径或 ComfyUI input 里的文件名' },
        heroImage: { type: 'string', description: '主角定妆图：本机绝对路径或 ComfyUI input 文件名；不给就自动生成' },
        aspectRatio: { type: 'string', description: '画面比例，默认 16:9 (Widescreen)' },
        megapixels: { type: 'number', description: '每镜像素（百万），默认 0.4；显存紧张就降' },
        phase: { type: 'string', description: "all（默认，全流程）| frames（只出静帧，停下等人审）| videos（用已有静帧出视频并合成）" },
        tailLink: { type: 'boolean', description: '末帧接龙：用上一镜最后一帧当下一镜首帧，默认开' },
        seed: { type: 'number', description: '镜头种子基准' },
        host: { type: 'string', description: 'ComfyUI 地址' },
      },
      required: [],
    },
    output: OUTPUT,
    timeoutMs: 7200000,
    async execute(args) {
      const client = new ComfyClient(args.host || DEFAULT_HOST);
      const alive = await client.alive();
      if (alive === null) throw new Error('连不上 ComfyUI（默认 127.0.0.1:8188），请先启动它');
      const params = { ...args };
      const job = jobStore.create(params);
      startJob(job, params);
      return text([
        `已排入后台任务 ${job.id}（整支 MV 要跑很久，务必用 mv_status 查）`,
        `ComfyUI ${alive.version} · ${alive.device} · 空闲 ${alive.vramFreeGB} GB`,
        args.song ? `用现成的歌：${args.song}` : '先出歌，再排分镜',
        args.heroImage ? `定妆图：${args.heroImage}` : '定妆图自动生成',
      ]);
    },
  });

  tools.register({
    name: 'mv_status',
    description: '查看音乐 MV 任务进度（哪个阶段、第几个镜头、每镜用时、成品路径），或列出最近的任务。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '任务 id；不传则列出最近的' } },
    },
    output: OUTPUT,
    async execute(args) {
      await jobStore.refresh();
      const id = String(args.id || '');
      if (id) {
        const job = jobStore.get(id);
        if (!job) throw new Error('没有这个任务：' + id);
        const frames = (job.shots || []).filter((s) => s.frame).length;
        const videos = (job.shots || []).filter((s) => s.video).length;
        return text([
          `${job.id} · ${job.status} · ${job.stageLabel || job.stage}${job.elapsedSeconds ? ` · ${job.elapsedSeconds}s` : ''}`,
          job.plan ? `《${job.plan.title}》 ${job.plan.duration}s · ${job.plan.shotCount} 镜` : '',
          job.total ? `静帧 ${frames}/${job.total} · 视频 ${videos}/${job.total}${job.currentShot != null ? `（正在处理第 ${job.currentShot + 1} 镜）` : ''}` : '',
          ...(job.shots || []).map((s) => {
            const mark = s.videoStatus === 'done' ? '🎬' : s.frameStatus === 'done' ? '🖼' : '·';
            const state = s.videoStatus === 'running' ? '出视频中' : s.frameStatus === 'running' ? '出静帧中' : (s.videoStatus === 'done' ? '视频完成' : s.frameStatus === 'done' ? '静帧完成' : '待生成');
            return `  ${s.index + 1}. ${mark} ${state}${s.elapsedSeconds ? ` ${s.elapsedSeconds}s` : ''}${s.error ? ' — ' + s.error : ''}`;
          }),
          job.error ? `失败：${job.error}` : '',
          job.file ? `成品：${job.file}` : '',
        ]);
      }
      const list = jobStore.list(10);
      if (list.length === 0) return text(['还没有 MV 任务']);
      return text(list.map((job) => `· ${job.id} ${job.status} ${job.stageLabel || ''}${job.plan ? ` 《${job.plan.title}》` : ''}${job.error ? ' — ' + job.error : ''}`));
    },
  });

  tools.register({
    name: 'mv_stitch',
    description: '只做拼接：把若干段视频按顺序接起来，音轨换成给的整首歌（覆盖各段自带音频），输出 mp4。',
    parameters: {
      type: 'object',
      properties: {
        clips: { type: 'array', items: { type: 'string' }, description: '视频片段：ComfyUI input 里的文件名或本机绝对路径' },
        audio: { type: 'string', description: '整首歌：ComfyUI input 里的文件名或本机绝对路径' },
        filenamePrefix: { type: 'string', description: '输出文件名前缀，默认 video/MV' },
        trimSeconds: { type: 'number', description: '把成片裁到这个秒数（通常等于歌长）；不填就不裁' },
        host: { type: 'string', description: 'ComfyUI 地址' },
      },
      required: ['clips', 'audio'],
    },
    output: OUTPUT,
    timeoutMs: 1800000,
    async execute(args) {
      const client = new ComfyClient(args.host || DEFAULT_HOST);
      const clips = [];
      for (const raw of args.clips || []) {
        const name = await ensureComfyFile(client, raw, 'video');
        if (name) clips.push(name);
      }
      const audio = await ensureComfyFile(client, args.audio, 'audio');
      if (clips.length === 0 || !audio) throw new Error('clips 和 audio 都不能为空');
      const graph = buildStitchPrompt({ clips, audio, filenamePrefix: args.filenamePrefix || 'video/MV', trimSeconds: args.trimSeconds });
      const promptId = await client.submit(graph);
      const entry = await client.wait(promptId, 1800000);
      const { buffer } = await fetchVideo(client, entry);
      const file = await saveVideo(DATA_DIR, 'stitch_' + Date.now().toString(36) + '.mp4', buffer);
      return text([
        `拼好了：${clips.length} 段 + 1 条音轨`,
        `文件：${file}（${(buffer.length / 1024 / 1024).toFixed(1)} MB）`,
      ]);
    },
  });

  /* ------------------- 路由 ------------------- */

  ctx.inject(['webServer'], (webCtx) => {
    const webServer = webCtx.get('webServer');
    if (webServer === undefined) return;

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/meta',
      handler: async (_request, response) => {
        try {
          sendJson(response, 200, await meta());
        } catch (error) {
          sendJson(response, 500, { error: 'meta_failed', message: String((error && error.message) || error) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/plan',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        let body = null;
        try { body = await readJsonBody(request); } catch { body = null; }
        if (!body || !String(body.theme || '').trim()) {
          sendJson(response, 400, { error: 'theme_required', message: '先写一个主题' });
          return;
        }
        try {
          const { plan, model } = await generatePlan(ctx, body);
          sendJson(response, 200, { plan, model });
        } catch (error) {
          sendJson(response, 502, { error: 'plan_failed', message: friendlyError(error) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/run',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        let body = null;
        try { body = await readJsonBody(request); } catch { body = null; }
        if (!body) { sendJson(response, 400, { error: 'bad_body' }); return; }
        const hasPlan = body.plan && typeof body.plan === 'object';
        if (!hasPlan && !String(body.theme || '').trim()) {
          sendJson(response, 400, { error: 'theme_or_plan_required', message: '要么给主题，要么给分镜表' });
          return;
        }
        if (!body.song && !String(body.lyrics || '').trim() && !String((body.plan && body.plan.lyrics) || '').trim()) {
          sendJson(response, 400, { error: 'lyrics_required', message: '要现出歌就必须有歌词：先点「生成剧本」拿到歌词' });
          return;
        }
        const params = { ...body };
        const job = jobStore.create(params);
        startJob(job, params);
        sendJson(response, 202, { job: { id: job.id, status: job.status } });
      },
    }));

    /** 在已有任务上继续：出静帧 / 出视频 / 重拼。已经出过的阶段不会重跑。 */
    async function resumeJob(job, phase) {
      const params = {
        ...job.params,
        plan: job.plan,
        song: job.song && job.song.file ? job.song.file : job.params.song,
        heroImage: job.hero && job.hero.name ? job.hero.name : job.params.heroImage,
        phase,
      };
      await jobStore.patch(job.id, { status: 'running', stage: phase === 'videos' ? 'videos' : 'frames', error: null });
      (async () => {
        try {
          await execute(job, params);
        } catch (error) {
          await jobStore.patch(job.id, {
            status: 'failed',
            stage: 'failed',
            error: friendlyError(error),
            elapsedSeconds: Math.round((Date.now() - job.createdAt) / 1000),
          });
        }
      })();
    }

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/continue',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        let body = null;
        try { body = await readJsonBody(request); } catch { body = null; }
        const id = String((body && body.id) || '');
        const phase = String((body && body.phase) || 'videos');
        await jobStore.refresh();
        const job = jobStore.get(id);
        if (!job) { sendJson(response, 404, { error: 'not_found', id }); return; }
        if (job.status === 'running') { sendJson(response, 409, { error: 'busy', message: '这个任务还在跑' }); return; }
        if (phase === 'videos' && !job.shots.some((s) => s.frame)) {
          sendJson(response, 400, { error: 'no_frames', message: '还没有静帧，先出静帧' });
          return;
        }
        await resumeJob(job, phase);
        sendJson(response, 202, { job: { id: job.id, status: 'running', phase } });
      },
    }));

    /** 单镜重 roll 静帧：同步返回（Krea2 一张几十秒）。 */
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/frame',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        let body = null;
        try { body = await readJsonBody(request); } catch { body = null; }
        const id = String((body && body.id) || '');
        const index = Number(body && body.index);
        await jobStore.refresh();
        const job = jobStore.get(id);
        const shot = job && Array.isArray(job.shots) ? job.shots.find((s) => s.index === index) : null;
        if (!shot) { sendJson(response, 404, { error: 'not_found', id, index }); return; }
        try {
          const client = new ComfyClient();
          const alive = await client.alive();
          if (!alive) throw new Error('连不上 ComfyUI');
          await jobStore.patchShot(id, index, { frameStatus: 'running', error: null });
          const still = await renderFrame(client, job, job.plan, shot, job.params);
          await jobStore.patchShot(id, index, {
            frame: still.name, frameFile: still.file, frameStatus: 'done', frameFromTail: false,
            framePromptText: still.promptText, frameSeed: still.seed, frameAt: Date.now(),
            frameVersions: [...(shot.frameVersions || []), { name: still.name, file: still.file, at: Date.now() }].slice(-6),
          });
          sendJson(response, 200, { ok: true, frame: still.name, file: still.file });
        } catch (error) {
          await jobStore.patchShot(id, index, { frameStatus: 'failed', error: friendlyError(error) });
          sendJson(response, 500, { error: 'frame_failed', message: friendlyError(error) });
        }
      },
    }));

    /** 改单镜参数 / 换首帧。 */
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/shot',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        let body = null;
        try { body = await readJsonBody(request); } catch { body = null; }
        const id = String((body && body.id) || '');
        const index = Number(body && body.index);
        const patch = (body && body.patch) || {};
        const allowed = ['label', 'section', 'beat', 'scene', 'time', 'size', 'horizontal', 'elevation',
          'move', 'light', 'dof', 'transition', 'action', 'dialogue', 'seed', 'seconds'];
        await jobStore.refresh();
        const job = jobStore.get(id);
        const shot = job && Array.isArray(job.shots) ? job.shots.find((s) => s.index === index) : null;
        if (!shot) { sendJson(response, 404, { error: 'not_found', id, index }); return; }
        const clean = {};
        for (const key of allowed) if (patch[key] !== undefined) clean[key] = patch[key];
        await jobStore.patchShot(id, index, clean);
        sendJson(response, 200, { ok: true, shot: (jobStore.get(id).shots || []).find((s) => s.index === index) });
      },
    }));

    /** 只用现有镜头重新拼接（换了素材/裁切长度时用）。 */
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/stitch',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        let body = null;
        try { body = await readJsonBody(request); } catch { body = null; }
        const id = String((body && body.id) || '');
        await jobStore.refresh();
        const job = jobStore.get(id);
        if (!job) { sendJson(response, 404, { error: 'not_found', id }); return; }
        const clips = (job.shots || []).map((s) => s.comfyVideo).filter(Boolean);
        if (clips.length === 0) { sendJson(response, 400, { error: 'no_clips' }); return; }
        try {
          const client = new ComfyClient();
          const graph = buildStitchPrompt({
            clips,
            audio: job.song && job.song.name,
            filenamePrefix: 'video/MV_' + job.id + '_' + Date.now().toString(36),
            trimSeconds: job.song && job.song.duration,
          });
          const promptId = await client.submit(graph);
          const entry = await client.wait(promptId, 1800000);
          const { buffer } = await fetchVideo(client, entry, { nodeId: '2002' });
          const file = await saveVideo(DATA_DIR, job.id + '.mp4', buffer);
          await jobStore.patch(id, { status: 'done', stage: 'done', stageLabel: '完成', file, bytes: buffer.length });
          sendJson(response, 200, { ok: true, file });
        } catch (error) {
          sendJson(response, 500, { error: 'stitch_failed', message: friendlyError(error) });
        }
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/job',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const id = String(url.searchParams.get('id') || '');
        await jobStore.refresh();
        const job = jobStore.get(id);
        if (!job) { sendJson(response, 404, { error: 'not_found', id }); return; }
        sendJson(response, 200, job);
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/jobs',
      handler: async (_request, response) => {
        await jobStore.refresh();
        sendJson(response, 200, { jobs: jobStore.list(20) });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/upload',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        try {
          const client = new ComfyClient();
          const files = await readUploads(request);
          if (!files.length) { sendJson(response, 400, { error: 'no_file', message: '没有收到文件' }); return; }
          const uploaded = [];
          for (const file of files) {
            const name = String(file.filename || 'upload.bin').replace(/^.*[\\/]/, '').replace(/[^\w.\-]+/g, '_');
            const stored = await client.upload(file.data, name, file.mime || mimeOfName(name));
            uploaded.push({ name: stored, bytes: file.data.length });
          }
          sendJson(response, 200, { files: uploaded });
        } catch (error) {
          sendJson(response, 500, { error: 'upload_failed', message: friendlyError(error) });
        }
      },
    }));

    /** 成品 / 单镜头 / 歌曲 统一走这里，支持 Range（视频要拖进度条）。 */
    async function streamFile(request, response, file, mime) {
      let buffer;
      try { buffer = await fs.readFile(file); } catch { sendJson(response, 404, { error: 'file_missing' }); return; }
      const size = buffer.length;
      const base = { 'content-type': mime, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' };
      const match = request.headers && request.headers.range ? /bytes=(\d*)-(\d*)/.exec(request.headers.range) : null;
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
    }

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/media',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const id = String(url.searchParams.get('id') || '');
        await jobStore.refresh();
        const job = jobStore.get(id);
        if (!job || !job.file) { sendJson(response, 404, { error: 'not_found', id }); return; }
        await streamFile(request, response, job.file, 'video/mp4');
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/frame-img',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const id = String(url.searchParams.get('id') || '');
        const index = Number(url.searchParams.get('index') || 0);
        await jobStore.refresh();
        const job = jobStore.get(id);
        const shot = job && Array.isArray(job.shots) ? job.shots.find((s) => s.index === index) : null;
        if (!shot || !shot.frameFile) { sendJson(response, 404, { error: 'not_found', id, index }); return; }
        await streamFile(request, response, shot.frameFile, 'image/png');
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/clip',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const id = String(url.searchParams.get('id') || '');
        const index = Number(url.searchParams.get('index') || 0);
        await jobStore.refresh();
        const job = jobStore.get(id);
        const shot = job && Array.isArray(job.shots) ? job.shots.find((s) => s.index === index) : null;
        if (!shot || !shot.video) { sendJson(response, 404, { error: 'not_found', id, index }); return; }
        await streamFile(request, response, shot.video, 'video/mp4');
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/song',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const id = String(url.searchParams.get('id') || '');
        await jobStore.refresh();
        const job = jobStore.get(id);
        if (!job || !job.song || !job.song.file) { sendJson(response, 404, { error: 'not_found', id }); return; }
        const ext = path.extname(job.song.file).toLowerCase();
        const mime = ext === '.flac' ? 'audio/flac' : ext === '.mp3' ? 'audio/mpeg' : 'audio/wav';
        await streamFile(request, response, job.song.file, mime);
      },
    }));
  });

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose();
  }, 'music-mv tools');
}
