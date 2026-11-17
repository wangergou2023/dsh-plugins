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
  buildSliceAudioPrompt, buildStitchPrompt, fetchVideo, fetchComfyImage, fetchComfyAudio,
  firstOutputImage, saveVideo, saveFrame, normalizePlan, parsePlanJson, suggestShotCount,
  charactersOf, castOf, lintPlan, segmentLyrics, composeFramePrompt, splitLook, extendSilentBeat, breakLyricDup, heroFormSpecs, trimLongActions, mergeScenes, cleanLogline, expandDialogueBeats,
  enforceReversePair,
  fixSizeRuns,
  linkWarmProp, dedupePerformance, dedupeLabels,
} from './lib/mv.js';
import { vocab, cameraSummary } from './lib/shotlang.js';
import { probeFfmpeg, stitchWithTransitions, concatAudio, composeTransHero } from './lib/ffmpeg.js';
import { loadRefEditTemplate, buildRefEditGraph, refsForShot, refInstruction, shotForm } from './lib/refedit.js';
import { cinematicPass } from './lib/grade.js';
import { buildBookHtml } from './lib/book.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = HERE;
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

  /**
   * 插件重载/进程退出后，旧任务还挂着 running，其实早就死了
   * （ComfyUI 队列是空的，却一直显示"正在跑"，还把续跑挡在 409 门外）。
   * 载入时统一标成 interrupted，面板给"续跑"。
   */
  async reapOrphans() {
    await this.refresh();
    const victims = [...this.jobs.values()].filter((job) => job.status === 'running' || job.status === 'queued');
    if (!victims.length) return 0;
    for (const job of victims) {
      job.status = 'interrupted';
      job.error = '进程重启，任务中断（可以续跑）';
      job.updatedAt = Date.now();
    }
    await this.persist();
    return victims.length;
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
    '  "twist": { "what": "一句话说清揭示：前半段以为 A，第 N 镜发现其实是 B（具体到动作或物件）", "atIndex": "揭示发生在第几镜（1 开始），必须落在全片 60%–85%", "sign": "这一镜里看得见的那一个物理细节：不等台词、不靠解释，观众看见就懂。例：香烧到第三指节时他鬓角白了一缕" },',
    '  "scenes": [{',
    '    "no": "场号，例如 1",',
    '    "heading": "场次标题：内景/外景 · 地点 · 时间（例如 外景 忘川渡口 夜 雨）",',
    '    "action": "这一场发生什么：环境 + 人物的物理动作，写看得见的东西",',
    '    "performance": "表演节拍：他的表层动作 → 中途的停顿/破绽 → 最后做的决定，三段用逗号连起来",',
    '    "sound": "这场的声音：水声/风/电话铃/布料摩擦/心跳，写具体",',
    '    "lyric": "这场落在哪句歌词（原样摘一句，没有就留空）"',
    '  }],',
    '  "style": "曲风（英文更稳）：流派、乐器、人声、情绪、速度",',
    '  "look": "视觉基调一句话，只写画面：胶片感/数字感、调色、镜头类型、光线基调",',
    '  "characters": [{ "name": "角色名（短，2-4 字）", "look": "人形外形一句话：年龄性别、发型发色、五官特征、服装/铠甲/配饰", "beast": "原形外形一句话（不是人形的角色可留空）：例如一条黑背中华田园犬，立耳，尾尖白" }],',
    '  "props": [{ "name": "物件名（2-4 字）", "meaning": "它在这一支片子里怎么变意思：开场是…，中间变成…，最后一镜成了…" }],',
    '  "lyrics": "完整歌词，用 [Verse] [Chorus] [Bridge] 标记段落，每句一行",',
    '  "shots": [{',
    '    "label": "镜头标题（两句内）",',
    '    "section": "段落标签，只能填 Verse|Pre-Chorus|Chorus|Bridge|Intro|Outro（副歌就填 Chorus，不要填歌词句子）",',
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
    '    "performance": "这一镜的表演细节：手/眼/呼吸怎么变，一个可以被拍到的微动作，不要形容词",',
    '    "objective": "这一镜人物想要什么（用动词：想挂断、想被听见、想藏起手）",',
    '    "prop": "这一镜的关键物件（从上面对 props 里选一个，必须出现）",',
    '    "dialogue": "这一镜要张口唱的那一句歌词（必须从歌词里原样摘一句）",',
    '    "cast": ["这一镜出场角色的名字，从上面对 characters 里选"]',
    '    "form": "这一镜观众该看见什么：beast（只看见本体：犬或骨架）/ human（只看见人形）/ trans（正在变的瞬间）/ mixed（本体与人形同框）",',
    '    "composition": "single（单人）/ two（两人并置）/ ots（过肩：只拍主角，对方只在画面边缘虚焦）",',
    '  }]',
    '}',
    '',
    '硬性规则：',
    `1. shots 必须正好 ${shotCount} 个，一个不多一个不少。`,
    `2. 整首歌约 ${duration} 秒，所以每个镜头约 ${Math.round(duration / shotCount)} 秒。`,
    '3. 分镜必须服务故事：镜头顺序就是情绪推进顺序；主角从开头到结尾要有变化。',
    '4. 景别必须有节奏地变化，不要连着三镜都是中景；运镜一镜只用一种。',
    '5. action 只写画面：人物动作、表情、与环境的关系。绝对不能写歌词、字幕、文字、水印。',
    '6. dialogue 必须填：从你写的 lyrics 里原样摘一句当这一镜对口型唱的词。但全片必须且只能有一镜留空（见规则 19）。',
    '7. characters 必须有 1–3 个角色，每个都要写清外形；cast 只填这一镜真正出镜的人，别漏也别多。',
    '7b. look 只写人形（年龄、发型、五官、服装）；如果这个角色的本体不是人（犬、兽、骨架、器物），必须把本体写进 beast 字段，一句话说清它长什么样。look 里绝不能出现本体形态——写进去会把人形和本体揉成一张图。',
    '7c. 每一镜都必须写 form，而且全片要在 beast / human 之间交替：只在人形时写 human，只在原形时写 beast，变形的那一镜写 trans，同一画面里人和本体都在写 mixed。全片 beast+trans+mixed 至少 2 镜、human 至少 2 镜，不许连着三镜同一种形态——否则观众从头到尾只看见两个人，根本不知道这是狗和骨头。',
    '8. 主角始终是同一个人（脸、发型、服装不变），可以换环境、换景别、换机位；多角色同框时各自外形不能混。',
    '9. 不要出现「四视图」「多视角」「分屏」「拼图」这类排版词。',
    '10. look 只写视觉（胶片、调色、镜头、光线），不要出现乐器、BPM、唱腔这类音乐词——那些归 style。',
    '11. 歌词要能唱：副歌重复、句子短、押韵。',
    '12. scenes 必须有 5–10 场，按时间顺序覆盖全片；每场都要有 action 和 performance，不许只写一句情绪。',
    '13. performance 只准写「先做什么 → 停在哪里 → 最后做什么」的可拍动作序列，例如「把硬币推进去，手指停在投币口，又抽回来」。禁止「他很悲伤」「内心挣扎」「若有所思」这类形容词。',
    '14. 每镜的 performance 必须是这一镜独有的微动作，不能 21 镜重复同一个「低头」。至少要有三镜是「手比脸更早说话」：先拍手、再拍脸。',
    '15. objective 用动词短语，并且每镜都要和上一镜不同或相反——人物在整支片子里必须有方向感。',
    '16. props 必须有 3–5 个，是有实体的东西（指骨、红绳、灯、硬币），不许写"回忆""命运"这类抽象词。',
    '17. 每个 prop 至少要被 2 个镜头真正用到（拿、放、藏、舔、递），最后一镜必须回到 props 里的第一个物件。',
    '18. 每镜的 prop 只能选一个，并且必须真的出现在 action 里。',
    '19. 全片必须且只能有一镜 dialogue 留空字符串（放在全片 60%–80% 的位置），那一镜只靠动作和声音说完，表演密度要最高。',
    '22. 每个 prop 必须三段式复现：前 30% 出现一次（建立）、中段出现一次（回声或变义）、后 30% 出现一次（兑现）；只出现两次、或全挤在前半段的，一律不算母题。',
    '23. 每镜的 label 不超过 12 个字，全片 21 镜不许有重复的 label——分镜表靠它定位镜头，重复了导演就找不到镜。',
    '24. 同一个物件出现三次，三次的场面和动作必须不同：不能每次都是"在同一张桌子上把它拿起来"——那就成了道具摆拍，不是母题。',
    '20. composition 决定构图：两个人同框且有人在说话，写 ots（过肩——只拍主角，对方只在画面边缘虚焦）；两个人要并排被看见才写 two；只有一个人写 single。全片 ots 至少 1 镜。',
    '21. 正反打：一段对话可以连排两镜 ots，第二镜把 cast 顺序反过来（谁在焦内就写在第一个），两镜的 scene 和 time 必须一模一样——观众看到的是同一时刻从两侧各拍一次。单段对话超过 6 秒时应该这么拆。',
    '',
    '故事规则（这条不过，画面再美也是垃圾）：',
    'A. 必须有一个「转折点」：观众在前半段以为是这件事，后半段发现是另一件事。用一句话能说清，不靠旁白解释。',
    'B. 歌要在故事里站得住：要么故事里的人真的在唱/在放这首歌（现场音乐），要么歌词本身就是剧情信息，副歌要承担揭示。',
    'C. 全片控制在「一个主场景 + 一个相邻空间」，不要东跑西跑。',
    'D. 每个镜头必须有「一个具体动作 + 一个具体物件」（纸页、耳机、纸箱、电话、酒瓶）。只有情绪没有物件的镜头一律删掉。',
    'E. 禁止：蒙太奇拼贴、无因果的唯美空镜、需要群演/特效/追车/打斗的大场面、靠字幕交代剧情。',
    'F. 主角真正出镜的人不超过 2 个，且尽量不同框（同框一致性最容易崩）。',
    'G. 最后一镜必须重新定义前面：同一个物件或同一个动作，看完最后一镜，前面的意思变了。',
    'H. 全片至少要有一镜「不说话、只有动作」的完整 10 秒，让表演自己说完；那一镜的表演密度要最高。',
    'I. 歌词不能复述画面。画面在做事，歌词在说别的事，两者错位才高级；只有副歌那句可以和画面对上。',
    'J. twist 必须是「动作级的揭示」，不是「原来是爱」这种概念。合格例子：她一直在等电话，最后发现电话线从没插上；她每天给他留半块糖，最后一镜她把糖自己吃了。不合格：他们其实深爱彼此。',
    'J2. twist.sign 必须是**看得见的一个瞬间**，不许写解释。合格：香烧到第三指节时他鬓角白了一缕、她把糖纸叠成很小一块塞回口袋、他吹灭蜡烛时手没有抖。不合格：观众这时才发现他其实早就知道、这象征着他们注定分离。',
    'K. 全片不能一直压着。中段（30%–60%）必须有一镜是真的放松：笑出来、松一口气、把肩膀放下来——压抑要有对比才成立。',
    'L2. lyrics 必须给全（带 [Verse]/[Chorus]/[Bridge] 段落标记，至少 4 行），这是出歌的唯一输入；场景里那句 lyric 不能代替整首歌词。',
    'L. logline 只写表层：谁想要什么、被什么拦住。不许在 logline 里剧透揭示（禁止出现「其实」「真相」「原来」「实际上」）——揭示只放在 twist 里。',
  ].join('\n');
}

/** 长片（>10 镜）第一步：只要剧本骨架，不要分镜——一次输出装不下 21 镜。 */
function planScriptPrompt(duration) {
  return [
    '你是音乐 MV 的导演兼作词。用户给一个主题，你要产出一支 MV 的剧本骨架（这一轮不要分镜）。',
    '只输出一个 JSON 对象，不要解释，不要代码块。',
    '',
    'JSON 结构：',
    '{',
    '  "title": "歌名（中文，短）",',
    '  "logline": "一句话故事：谁、想要什么、被什么拦住",',
    '  "arc": "情绪曲线：起（前奏）承（主歌）转（副歌）合（尾声）",',
    '  "ending": "最后一个镜头怎么收",',
    '  "notes": "导演阐述：视觉基调、调色、为什么这么拍",',
    '  "twist": { "what": "一句话说清揭示：前半段以为 A，第 N 镜发现其实是 B（具体到动作或物件）", "atIndex": "揭示发生在第几镜（1 开始），落在全片 60%–85%", "sign": "这一镜里看得见的那一个物理细节：不等台词、不靠解释，观众看见就懂" }',
    '  "style": "曲风（英文更稳）：流派、乐器、人声、情绪、速度",',
    '  "look": "视觉基调一句话，只写画面：胶片感/调色/镜头/光线",',
    '  "characters": [{ "name": "2-4 字", "look": "人形：年龄性别、发型发色、五官、服装配饰", "beast": "本体：只有非人角色（神兽/妖/骨架/器物）才填，一句话写清它长什么样；是普通人就留空字符串——乱填会让画面里凭空多出一条狗" }],',
    '  "props": [{ "name": "物件名（2-4 字）", "meaning": "它怎么变意思：开场是…，中间变成…，最后一镜成了…" }],',
    '  "lyrics": "完整歌词，[Verse] [Chorus] [Bridge] 分段，每句一行",',
    '  "scenes": [{',
    '    "no": "场号",',
    '    "heading": "内景/外景 · 地点 · 时间",',
    '    "action": "这一场发生什么：环境 + 看得见的物理动作",',
    '    "performance": "表演节拍：表层动作 → 中途停顿/破绽 → 最后做的决定",',
    '    "sound": "这场的声音，写具体",',
    '    "lyric": "落在哪句歌词，没有就留空"',
    '  }]',
    '}',
    '',
    '硬性规则：',
    `1. 全片约 ${duration} 秒，scenes 写 6–10 场，按时间顺序覆盖全片，不许只写一句情绪。`,
    '2. 每场都必须有 action 和 performance；performance 只准写可拍的动作序列，禁止「悲伤」「挣扎」「若有所思」。',
    '3. 必须有一个转折点：前半段以为是这件事，后半段发现是另一件事，不靠旁白。',
    '4. 最后一镜必须重新定义前面：同一个物件或动作，看完最后一镜前面的意思变了。',
    '5. 歌词要能唱（副歌重复、句子短、押韵），且不要复述画面——画面在做事，歌词在说别的事。',
    '6. characters 写 1–2 个，外形要能画出定妆图。',
    '7. props 写 3–5 个有实体的物件，每个都要说清它怎么变意思；最后一镜必须回到第一个物件。',
    '8. 这一轮不要输出 shots 字段。',
  ].join('\n');
}

/** 长片第二步：只补某一段时间窗内的分镜。 */
function shotsPrompt(count, from, to, part, total) {
  return [
    '你是音乐 MV 的分镜师。用户给你一份已经定稿的剧本，你只负责补分镜表。',
    '只输出一个 JSON 对象：{"shots":[{...}]}，不要解释，不要代码块。',
    `要输出正好 ${count} 个镜头，对应全片 ${from}–${to} 秒，也就是全片的第 ${part}/${total} 段。`,
    '这是接续拍摄：这一段必须承接上一段，绝对不许把故事从头再讲一遍，不许重复前面出现过的场景、动作、台词。',
    '这一段的人物处境要比上一段更晚、更进一层；如果剧本已经写到结局，就写结局。',
    '',
    '每个镜头字段：',
    '{ "label": "两字到六字的镜头标题", "section": "对应哪句歌词", "beat": "情绪词两三个",',
    '  "scene": "具体地点与环境", "time": "时间与天气",',
    '  "size": "extreme_wide|wide|medium|close|extreme_close",',
    '  "horizontal": "front|front_left|left|back_left|back|back_right|right|front_right",',
    '  "elevation": "worm|low|eye|high",',
    '  "move": "static|push|pull|pan|tilt|tracking|crane_up|crane_down|orbit|handheld",',
    '  "light": "natural|front|side|backlit|top|under|soft|dramatic|golden|blue|night|neon",',
    '  "dof": "extreme_shallow|shallow|medium|deep",',
    '  "transition": "cut|dissolve|match|whip|fade",',
    '  "action": "人物做什么：身体动作 + 表情 + 与环境的关系",',
    '  "performance": "这一镜独有的微动作：手/眼/呼吸怎么变",',
    '  "objective": "这一镜人物想要什么（动词短语）",',
    '  "prop": "这一镜的关键物件（从剧本 props 里选一个，必须出现在 action 里）",',
    '  "dialogue": "要张口唱的那一句（从歌词原样摘）",',
    '  "cast": ["出场角色名"] }',
    '  "form": "这一镜观众该看见什么：beast（只看见本体：犬或骨架）/ human（只看见人形）/ trans（正在变的瞬间）/ mixed（本体与人形同框）",',
  '  "composition": "single / two / ots（过肩：只拍主角，对方只在画面边缘虚焦）",',
    '',
    '硬规则：',
    '1. action 只写画面，不写歌词、不写镜头参数、不写字幕水印。',
    '2. performance 每镜都要不一样，至少三分之一是「手比脸更早说话」（先拍手再拍脸）。',
    '3. objective 用动词，且每镜与上一镜不同或相反，并且比上一段更急。',
    '4. 不要出现四视图、分屏、拼图这类排版词。',
    '5. form 必须写，而且要在 beast / human 之间交替：全片 beast+trans+mixed 至少 2 镜、human 至少 2 镜，不许连着三镜同一种形态——否则观众从头到尾只看见两个人。',
  ].join('\n');
}

/** 按段落比例切剧本场次，让每一批只写自己那一段。 */
function scenesForBatch(scenes, part, total) {
  const list = Array.isArray(scenes) ? scenes : [];
  if (!list.length) return [];
  const from = Math.floor((list.length * part) / total);
  const to = Math.max(from + 1, Math.floor((list.length * (part + 1)) / total));
  return list.slice(from, to);
}

/** 把 N 个镜头切成 3 批，各自带时间窗。 */
function shotBatches(shotCount, duration) {
  const parts = 3;
  const size = Math.ceil(shotCount / parts);
  const out = [];
  for (let start = 0; start < shotCount; start += size) {
    const end = Math.min(shotCount, start + size);
    out.push({
      count: end - start,
      from: Math.round((duration * start) / shotCount),
      to: Math.round((duration * end) / shotCount),
    });
  }
  return out;
}

/**
 * 体检里「末镜回扣开场物件」不过时，只重写最后一镜把它补上。
 * 这是结构硬伤里最容易自动修的一项，修完再体检一次。
 */
async function repairBookend(ctx, plan) {
  try {
    const before = lintPlan(plan);
    const check = before.checks.find((c) => c.id === 'bookend');
    const first = (plan.props || [])[0];
    if (!check || check.ok || !first || !plan.shots.length) return plan;

    const last = plan.shots[plan.shots.length - 1];
    const system = [
      '你是电影分镜师。只重写整部片的最后一镜，让它回扣开场物件，其余字段一律不动。',
      '只输出一个 JSON 对象，不要解释、不要 markdown。',
    ].join('\n');
    const user = [
      `全片：${plan.title}｜${plan.duration} 秒｜${plan.shots.length} 镜`,
      `物件母题：${(plan.props || []).map((p) => `${p.name}（${p.meaning}）`).join('；')}`,
      `最后一镜必须回到：${first.name}`,
      `当前最后一镜：${JSON.stringify(last)}`,
      '要求：index/start/end/section/beat/size/move/angle/light/depth/transition 全部保持不变；',
      `只改 label/action/performance/objective/prop/dialogue；action 里要出现「${first.name}」的实体动作；`,
      '表演仍要写成「先做→停在哪→最后做什么」，不要情绪形容词。',
      `输出：{"label":"…","action":"…","performance":"…","objective":"…","prop":"${first.name}","dialogue":"…"}`,
    ].join('\n');

    const { text: raw } = await llmText(ctx, system, user, { maxTokens: 900, timeoutMs: 90000 });
    const patch = parsePlanJson(raw);
    if (!patch || !patch.action) return plan;

    const merged = { ...last };
    for (const key of ['label', 'action', 'performance', 'objective', 'prop', 'dialogue']) {
      if (patch[key] && String(patch[key]).trim()) merged[key] = String(patch[key]).trim();
    }
    if (!String(merged.prop || '').includes(first.name) && !String(merged.action).includes(first.name)) {
      merged.prop = first.name;
    }
    const shots = plan.shots.slice(0, -1).concat(merged);
    return { ...plan, shots };
  } catch {
    return plan;
  }
}

/**
 * 体检里「有一镜不说话」不过时，把 60%–80% 位置最长的那一镜台词抽掉。
 * 抽台词不破坏结构，但能让表演自己说话——这是最便宜的一处硬修。
 */
function relieveSilence(plan) {
  try {
    const lint = lintPlan(plan);
    const check = lint.checks.find((c) => c.id === 'silence');
    if (!check || check.ok) return plan;
    const shots = plan.shots || [];
    if (shots.length < 3) return plan;
    const from = Math.floor(shots.length * 0.55);
    const to = Math.max(from + 1, Math.ceil(shots.length * 0.85));
    let best = null;
    for (let i = from; i < to; i += 1) {
      const s = shots[i];
      if (!String(s.dialogue || '').trim()) continue;
      if (s.end - s.start < 8) continue;
      if (!best || (s.end - s.start) > (best.end - best.start)) best = s;
    }
    if (!best) best = shots[Math.min(shots.length - 1, Math.floor(shots.length * 0.7))];
    return { ...plan, shots: shots.map((s) => (s === best ? { ...s, dialogue: '' } : s)) };
  } catch {
    return plan;
  }
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

  if (shotCount <= 10) {
    // 剧本是抽样的：同一套提示词跑两次，体检可能一次 100 分、一次 70 分
    // （实测《放水》第一版 8 项不过，《灯要熄了》同规则下 26/26 全过）。
    // 所以这里取 3 次里最好的一版——只花 LLM 时间，不占 GPU。
    let best = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const { text: raw, model } = await llmText(ctx, planSystemPrompt(shotCount, duration), userLines.join('\n'), { maxTokens: 6000 });
      let plan;
      try {
        plan = normalizePlan(parsePlanJson(raw), { duration, shotCount });
      } catch (error) {
        if (attempt === 3 && !best) throw error;
        continue;
      }
      plan = extendSilentBeat(plan);
      plan = breakLyricDup(plan);
      plan = relieveSilence(plan);
      plan = await addWarmBeat(ctx, plan);
      plan = await repairBookend(ctx, plan);
      plan = await focusSignShot(ctx, plan);
      plan = enforceReversePair(plan);
      plan = trimLongActions(plan);
      plan = mergeScenes(plan);
      plan = cleanLogline(plan);
      plan = dedupePerformance(plan);
      plan = dedupeLabels(plan);
      plan = linkWarmProp(plan);
      plan = fixSizeRuns(plan);
      const lint = lintPlan(plan);
      if (!best || lint.score > best.lint.score) best = { plan, model, raw, lint, attempt };
      if (lint.score >= 96) break;
    }
    return { plan: best.plan, model: best.model, raw: best.raw, lint: best.lint, attempts: best.attempt };
  }

  // 长片（>10 镜）：先出剧本骨架，再分批补分镜——一次输出 21 镜会被截断
  const { text: rawHead, model } = await llmText(ctx, planScriptPrompt(duration), userLines.join('\n'), { maxTokens: 5200 });
  const head = parsePlanJson(rawHead);
  const shots = [];
  const batches = shotBatches(shotCount, duration);
  for (let bi = 0; bi < batches.length; bi += 1) {
    const batch = batches[bi];
    const slice = scenesForBatch(head.scenes, bi, batches.length);
    const shotSoFar = shots
      .map((s, i) => `${i + 1}. ${s.label || ''}｜${String(s.action || '').slice(0, 40)}`)
      .join('\n');
    const context = [
      `这一段是第 ${bi + 1}/${batches.length} 段（${batch.from}–${batch.to} 秒）。`,
      slice.length ? '本段对应的剧本场次：\n' + JSON.stringify(slice, null, 1) : '',
      shotSoFar ? '前面已经拍过的镜头（不许重复这些场景与动作）：\n' + shotSoFar : '',
      '全片信息：\n' + JSON.stringify({
        title: head.title,
        logline: head.logline,
        arc: head.arc,
        ending: head.ending,
        characters: head.characters,
        props: head.props,
        lyrics: head.lyrics,
      }, null, 1),
    ].filter(Boolean).join('\n\n');
    const { text: rawShots } = await llmText(ctx, shotsPrompt(batch.count, batch.from, batch.to, bi + 1, batches.length), context, { maxTokens: 4000 });
    const part = parsePlanJson(rawShots);
    if (Array.isArray(part && part.shots)) shots.push(...part.shots);
  }
  if (!shots.length) throw new Error('分镜生成失败：模型返回里没有 shots');
    let plan = normalizePlan({ ...head, shots }, { duration, shotCount });
    plan = extendSilentBeat(plan);
    plan = breakLyricDup(plan);
    plan = relieveSilence(plan);
    plan = await addWarmBeat(ctx, plan);
    plan = await repairBookend(ctx, plan);
    plan = await focusSignShot(ctx, plan);
    plan = enforceReversePair(plan);
    plan = trimLongActions(plan);
    plan = mergeScenes(plan);
    plan = cleanLogline(plan);
    plan = dedupePerformance(plan);
    plan = dedupeLabels(plan);
  plan = linkWarmProp(plan);
  plan = fixSizeRuns(plan);
  return { plan, model, raw: rawHead, lint: lintPlan(plan) };
}

/* ---------------------------- 分镜体检（人眼标准） ---------------------------- */

const REVIEW_SYSTEM = `你是一位严格的分镜指导，只审"这一格能不能让人一眼看懂"，不夸不客气。

对每一镜打 4 项分（都是 1–5，允许打 2 分）：
- who：画面里主体是否唯一清楚（没有两个同等重量的动作/人物抢戏）
- want：objective（他想要什么）能不能直接拍成看得见的动作
- block：有没有障碍或阻力（没有阻力的镜头是废镜头）
- acting：表演是否具体到"肌肉/呼吸/手指"，且不是摆拍看镜头

再给一句 note（这一格一眼看到什么）和一句 fix（怎么改，具体到可执行，禁止"更有情绪"这种废话）。

判分尺度：5 = 一眼读懂且有回味；4 = 清楚但平；3 = 要读第二遍；2 = 读不懂；1 = 废。
整体 overall 用一句话说这部片现在最致命的 3 个问题。

只输出 JSON：
{"shots":[{"i":1,"who":4,"want":4,"block":3,"acting":4,"note":"…","fix":"…"}],"overall":"…"}`;

async function reviewPlan(ctx, plan) {
  const brief = (plan.shots || []).map((s) => ({
    i: s.index + 1,
    label: s.label,
    size: s.size,
    move: s.move,
    action: s.action,
    performance: s.performance,
    objective: s.objective,
    prop: s.prop,
    dialogue: s.dialogue || '（不说话）',
    seconds: Number(s.seconds.toFixed(1)),
    cast: s.cast,
  }));
  const user = [
    `片名：《${plan.title}》`,
    `一句话：${plan.story && plan.story.logline}`,
    `物件母题：${(plan.props || []).map((p) => p.name).join('、')}`,
    `分镜（${brief.length} 镜）：`,
    JSON.stringify(brief, null, 1),
  ].join('\n');
  const { text: raw, model } = await llmText(ctx, REVIEW_SYSTEM, user, { maxTokens: 6000 });
  const data = parsePlanJson(raw);
  const shots = (data && Array.isArray(data.shots) ? data.shots : []).map((s) => {
    const num = (v) => Math.max(1, Math.min(5, Number(v) || 3));
    const who = num(s.who); const want = num(s.want); const block = num(s.block); const acting = num(s.acting);
    return { i: Number(s.i) || 0, who, want, block, acting, total: who + want + block + acting, note: String(s.note || '').trim(), fix: String(s.fix || '').trim() };
  }).filter((s) => s.i > 0).sort((a, b) => a.i - b.i);
  const overall = String((data && data.overall) || '').trim();
  const weak = shots.filter((s) => s.total <= 14).map((s) => s.i);
  const avg = shots.length ? shots.reduce((a, s) => a + s.total, 0) / shots.length : 0;
  return { model, overall, shots, weak, avg: Number(avg.toFixed(2)) };
}

/* ---------------------------- 两版对比（A/B，比打分稳得多） ---------------------------- */

const COMPARE_SYSTEM = `你是分镜指导。给你同一部片的两个版本，逐镜比较：哪一版"一眼能看懂、有阻力、表演具体"。

绝对打分噪声很大，两版放在一起比要可靠得多——这一镜只能选一个赢家，不许平票，除非两版一字不差。
判定优先看：这一格里主体是否唯一、有没有一个卡住的瞬间、表演是否落到身体细节。

只输出 JSON：
{"wins":{"A":0,"B":0,"tie":0},"shots":[{"i":1,"winner":"A","why":"一句理由"}]}`;

async function comparePlans(ctx, planA, planB) {
  const brief = (plan) => (plan.shots || []).map((s) => ({
    i: s.index + 1,
    label: s.label,
    action: s.action,
    performance: s.performance,
    objective: s.objective,
    prop: s.prop,
  }));
  const user = [
    `片名：《${planA.title}》`,
    `A 版分镜：`, JSON.stringify(brief(planA), null, 1),
    `B 版分镜：`, JSON.stringify(brief(planB), null, 1),
    '逐镜判断 A 还是 B 更好。',
  ].join('\n');
  const { text: raw, model } = await llmText(ctx, COMPARE_SYSTEM, user, { maxTokens: 7000 });
  const data = parsePlanJson(raw);
  const shots = (data && Array.isArray(data.shots) ? data.shots : []).map((s) => ({
    i: Number(s.i) || 0,
    winner: String(s.winner || '').trim().toUpperCase() === 'B' ? 'B' : String(s.winner || '').trim().toUpperCase() === 'TIE' ? 'tie' : 'A',
    why: String(s.why || '').trim(),
  })).filter((s) => s.i > 0);
  const wins = { A: 0, B: 0, tie: 0 };
  for (const s of shots) wins[s.winner] = (wins[s.winner] || 0) + 1;
  return { model, wins, shots };
}

/* ---------------------------- 弱镜返修 ---------------------------- */

const REWRITE_SYSTEM = `你是分镜医生。给你几镜"一眼读不懂"的分镜和审片意见，你只改它们的 action / performance / objective 三个字段，其余一律不动。

改写规则（违反一条就算失败）：
1. action 只写看得见的物理事件，12–90 字，必须包含一个"卡住"的瞬间（够不到、被挡住、松手、被风吹走、来不及）。
2. performance 写成"先做→停在哪→最后做"的三段式，必须落到身体细节（指节、喉结、呼吸、脚趾、睫毛），禁止情绪形容词。
3. objective 是这一镜里角色想拿到的一个具体东西，用动词开头，同一场戏里不能和相邻镜头重复。
4. 视线必须落在具体物件或对方身上，不能看镜头。
5. 保留原有的物件（prop）与唱词，不许改剧情走向。

只输出 JSON：{"shots":[{"i":1,"action":"…","performance":"…","objective":"…"}]}`;

async function rewriteShots(ctx, plan, items) {
  if (!items.length) return plan;
  const ctxShots = (plan.shots || []).map((s) => ({
    i: s.index + 1, label: s.label, size: s.size, move: s.move, action: s.action,
    performance: s.performance, objective: s.objective, prop: s.prop,
    dialogue: s.dialogue || '（不说话）', cast: s.cast, seconds: Number(s.seconds.toFixed(1)),
  }));
  const weak = items.map((s) => ({ i: s.i, note: s.note, fix: s.fix, total: s.total }));
  const user = [
    `片名：《${plan.title}》　一句话：${plan.story && plan.story.logline}`,
    '全部镜头（保持前后连贯，不要重复相邻镜头的动作与目的）：',
    JSON.stringify(ctxShots, null, 1),
    '需要改的镜头：',
    JSON.stringify(weak, null, 1),
  ].join('\n');
  const { text: raw } = await llmText(ctx, REWRITE_SYSTEM, user, { maxTokens: 4000 });
  const data = parsePlanJson(raw);
  const fixes = new Map((data && Array.isArray(data.shots) ? data.shots : []).map((s) => [Number(s.i), s]));
  const next = JSON.parse(JSON.stringify(plan));
  for (const shot of next.shots) {
    const f = fixes.get(shot.index + 1);
    if (!f) continue;
    if (String(f.action || '').trim()) shot.action = String(f.action).trim();
    if (String(f.performance || '').trim()) shot.performance = String(f.performance).trim();
    if (String(f.objective || '').trim()) shot.objective = String(f.objective).trim();
  }
  next.shots = extendSilentBeat(next).shots;
  return next;
}

/* ---------------------------- 情绪对比返修 ---------------------------- */

const WARM_SYSTEM = `你是分镜医生。这支 MV 从头到尾都在压抑，观众会麻。你要挑中的那一镜，让里面的人真的松一次。

只改这一镜的 action 和 performance，其余字段一律不动。规则：
1. 这一镜必须有一个人真的放松：笑出来、把肩膀放下来、松一口气、忍不住笑出声、仰头笑。不是"微笑"这种静态表情，是一个发生的动作。
2. 保持与前后镜头的动作连续：这一镜开始时人物在什么姿势、什么位置，必须接得上上一镜的结尾。
3. performance 仍写成"先做→停在哪→最后做"，落到身体细节（嘴角、肩膀、呼吸、眼角）。
4. action 12–90 字，只写看得见的物理事件。
5. 不许改剧情走向、不许新增道具、不许改台词。

只输出 JSON：{"action":"…","performance":"…"}`;

async function addWarmBeat(ctx, plan) {
  const before = lintPlan(plan);
  const contrast = before.checks.find((c) => c.id === 'contrast');
  if (!contrast || contrast.ok) return plan;
  const shots = plan.shots || [];
  if (!shots.length) return plan;
  const span = Math.max(1, shots.length - 1);
  const inWindow = shots.filter((s) => {
    const p = s.index / span;
    return p >= 0.18 && p <= 0.68;
  });
  if (!inWindow.length) return plan;
  // 优先挑"两个人都在场、且不在流血/死亡"的一镜：那里放一个笑最自然
  const score = (s) => {
    let v = 0;
    if ((s.cast || []).length >= 2) v += 3;
    if (['medium', 'wide'].includes(s.size)) v += 2;
    if (/血|死|灭|哭|丧|碎|断/.test(`${s.action || ''}`)) v -= 3;
    return v;
  };
  const target = inWindow.slice().sort((a, b) => score(b) - score(a))[0];
  const prev = shots[target.index - 1];
  const next = shots[target.index + 1];
  const twist = plan.twist || {};
  const twistShot = shots[(Number(twist.atIndex) || 0) - 1];
  const keyProp = String((twistShot && twistShot.prop) || '').trim()
    || String((Array.isArray(plan.props) && plan.props[0] && plan.props[0].name) || '').trim();
  const user = [
    `片名：《${plan.title}》　一句话：${plan.story && plan.story.logline}`,
    `全片情绪曲线：${(plan.story && plan.story.arc) || '（未写）'}`,
    `要改的是第 ${target.index + 1} 镜（全片 ${shots.length} 镜，时长 ${Number(target.seconds.toFixed(1))} 秒）：`,
    JSON.stringify({
      label: target.label, size: target.size, move: target.move, prop: target.prop,
      action: target.action, performance: target.performance, objective: target.objective,
      cast: target.cast, dialogue: target.dialogue || '（不说话）',
    }, null, 1),
    `上一镜结尾：${prev ? String(prev.action || '').slice(-40) : '（无）'}`,
    `下一镜开始：${next ? String(next.action || '').slice(0, 40) : '（无）'}`,
    twist.what ? `全片在第 ${twist.atIndex} 镜揭示：${twist.what}` : '',
    keyProp
      ? `硬性要求：这一镜笑的时候，人物手里必须拿着「${keyProp}」——观众后来才知道这就是第 ${twist.atIndex} 镜揭示的东西。笑过它，再被它反咬。`
      : '',
  ].filter(Boolean).join('\n');
  const { text: raw } = await llmText(ctx, WARM_SYSTEM, user, { maxTokens: 500 });
  const data = parsePlanJson(raw);
  const action = String((data && data.action) || '').trim();
  const performance = String((data && data.performance) || '').trim();
  if (!action || !performance) return plan;
  const out = JSON.parse(JSON.stringify(plan));
  out.shots[target.index].action = action;
  out.shots[target.index].performance = performance;
  // 模型常常写"有笑没物件"。这里做一次确定性兜底：把揭示的那件东西塞进手里，
  // 保证"笑过它，再被它反咬"这条线真的接上了。
  if (keyProp) {
    const shot = out.shots[target.index];
    const has = `${shot.action}${shot.performance}${shot.prop}`.includes(keyProp);
    if (has) {
      shot.prop = keyProp;
    } else {
      shot.action = `${String(shot.action).replace(/[。]$/, '')}，${keyProp}还捏在指间没放下。`;
      shot.prop = keyProp;
    }
  }
  return out;
}

/* ---------------------------- 揭示镜收束 ---------------------------- */

const FOCUS_SYSTEM = `你是剪辑师。这一镜是全片的揭示镜，现在的动作里塞了太多活，观众来不及看那件东西。

只改这一镜的 action 和 performance，规则：
1. 整镜只拍一件事：给的那个"画面信号"。动作里除了它，最多再留一个人体的反应（呼吸、眨眼、手指松一下）。
2. 不许出现台词、不许解释、不许加新道具、不许写心理活动。
3. action 12–70 字，只写看得见的物理变化，从信号开始，到信号结束为止。
4. performance 写"先做→停在哪→最后做"，落到身体细节。
5. 保留角色原本的姿势与位置，接得上前后镜。

只输出 JSON：{"action":"…","performance":"…"}`;

async function focusSignShot(ctx, plan) {
  const before = lintPlan(plan);
  const check = before.checks.find((c) => c.id === 'sign-focus');
  if (!check || check.ok) return plan;
  const twist = plan.twist || {};
  const sign = String(twist.sign || '').trim();
  const idx = (Number(twist.atIndex) || 0) - 1;
  const shot = (plan.shots || [])[idx];
  if (!sign || !shot) return plan;
  const user = [
    `片名：《${plan.title}》`,
    `全片揭示：${twist.what}`,
    `这一镜的画面信号（只拍这个）：${sign}`,
    `现在第 ${shot.index + 1} 镜写成这样（太挤）：`,
    JSON.stringify({ label: shot.label, size: shot.size, action: shot.action, performance: shot.performance, prop: shot.prop }, null, 1),
  ].join('\n');
  const { text: raw } = await llmText(ctx, FOCUS_SYSTEM, user, { maxTokens: 420 });
  const data = parsePlanJson(raw);
  const action = String((data && data.action) || '').trim();
  const performance = String((data && data.performance) || '').trim();
  if (!action) return plan;
  const out = JSON.parse(JSON.stringify(plan));
  out.shots[idx].action = action.slice(0, 90);
  if (performance) out.shots[idx].performance = performance;
  return out;
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
/** 懒加载 Qwen 参考编辑模板（workflows/qwen_frame_edit.api.json）。 */
let refTemplateCache = null;
async function refTemplate() {
  if (!refTemplateCache) {
    refTemplateCache = await loadRefEditTemplate(path.join(HERE, 'workflows', 'qwen_frame_edit.api.json'));
  }
  return refTemplateCache;
}

/**
 * 给一个角色出定妆图。按形态拆成「原形」「人形」两张：
 * 以前把「犬…幻化人形时是少年…」整句喂进去，模型会揉成「长着狗耳朵的少年」。
 */
async function renderHero(client, job, plan, character, index, params) {
  // look 只写人形、beast 写本体；没有 beast 时才回落到从 look 里切（老 plan 兼容）。
  const beastText = String(character.beast || '').trim();
  const specs = (beastText
    ? [
      {
        form: 'beast',
        text: beastText,
        guard: '角色定妆照，只有这一个非人形态：动物或骨架本体，完整身形，画面里没有任何人类、没有人的脸、没有手臂、没有衣领、没有兽耳少年',
      },
      {
        form: 'human',
        text: character.look || beastText,
        guard: '角色定妆照，只有这一个人形：正常人类的头部与头发，画面里没有兽耳、没有尾巴、没有动物毛发、没有裸露的骨架；如果角色是骨架成人，骨相只能出现在露出的皮肤质感上，绝不能做成衣服上的骨头印花',
      },
      {
        form: 'trans',
        text: `画面从正中线竖着分开，同一具身体的两半：左半边是${beastText}，右半边是长着皮肤、头发的人形（${character.look || ''}）；两半在同一具身体上接着，接缝沿胸骨与鼻梁走，能看到骨茬和皮肉的过渡`,
        guard: '角色定妆照，半骨半人（或半兽半人）的过渡形态，画面从正中线分开：左半边解剖结构外露，右半边完整皮肤与头发，接缝清晰；不是两个人物，是同一具身体的两半；画面里没有印花服装',
      },
    ]
    : heroFormSpecs(character.look)).filter((s) => s.form !== 'trans').slice(0, 2);
  const entry = { label: character.name, look: character.look };
  for (const spec of specs) {
    const heroPrompt = [
      spec.text || character.name || '一位年轻人',
      spec.guard,
      plan.style ? `风格：${plan.style}` : '',
      '电影感写真，纯色深灰背景，不要文字，不要拼图',
    ].filter(Boolean).join('，');
    const built = await buildT2iPrompt({
      prompt: heroPrompt,
      aspectRatio: params.heroAspect || '1:1 (Square)',
      megapixels: 1.0,
      steps: params.heroSteps || 8,
      filenamePrefix: `mv_hero/${job.id}_${index + 1}_${spec.form}`,
    });
    applyModelOverrides(built.prompt, params.models);
    const promptId = await client.submit(built.prompt);
    const result = await client.wait(promptId, 1800000);
    const item = firstOutputImage(result, '29');
    if (!item) throw new Error(`${character.name} 的定妆图没有产出`);
    const buffer = await fetchComfyImage(client, item);
    await fs.mkdir(path.join(DATA_DIR, job.id), { recursive: true });
    const stamp = Date.now().toString(36);
    const hasBeast = specs.some((x) => x.form === 'beast');
    // 纯人类角色（没有本体形态）只出一张图，那张图就是人形——不标成"本体"。
    const isHuman = spec.form === 'human' || (!hasBeast && spec.form !== 'beast');
    const isTrans = spec.form === 'trans';
    const suffix = isHuman ? '_human' : isTrans ? '_trans' : '';
    const heroFile = path.join(DATA_DIR, job.id, `hero_${index + 1}${suffix}_${stamp}.png`);
    await fs.writeFile(heroFile, buffer);
    const comfy = await client.upload(buffer, `mv_hero${isHuman ? '_h' : isTrans ? '_trans' : ''}_${job.id}_${index + 1}_${stamp}.png`, 'image/png');
    if (isHuman) {
      entry.humanFile = heroFile;
      entry.humanComfy = comfy;
    } else if (isTrans) {
      entry.transFile = heroFile;
      entry.transComfy = comfy;
    } else {
      entry.file = heroFile;
      entry.comfy = comfy;
    }
    if (!entry.file) {
      entry.file = heroFile;
      entry.comfy = comfy;
    }
  }
  // 过渡形态不走生成：两次实测模型都把"另一半"画成第二个人。
  // 改成拿本体与人形两张定妆沿一条带抖动的竖线拼起来，结果是确定的。
  if (entry.file && entry.humanFile && !entry.transFile) {
    try {
      const stamp = Date.now().toString(36);
      const transFile = path.join(DATA_DIR, job.id, `hero_${index + 1}_trans_${stamp}.png`);
      await composeTransHero({
        pluginDir: __dirname,
        beastFile: entry.file,
        humanFile: entry.humanFile,
        outFile: transFile,
      });
      const buf = await fs.readFile(transFile);
      const transComfy = await client.upload(buf, `mv_hero_trans_${job.id}_${index + 1}_${stamp}.png`, 'image/png');
      entry.transFile = transFile;
      entry.transComfy = transComfy;
    } catch (error) {
      // 没有 ffmpeg 就跳过过渡形态，不影响定妆与静帧
    }
  }
  return entry;
}

async function renderFrame(client, job, plan, shot, params) {
  // 有定妆图就走"认人"链路：Qwen 参考编辑，角色长相全片锁死
  const sceneText = composeFramePrompt(plan, shot);
  // 过肩镜只给主角一张参考图。两张开给，模型会把两个人并排画出来（实测过），
  // 过肩就变成了两人合影——而这一镜的表演关键恰恰是"对方不在画面里"。
  const otsFocus = String(shot.composition || '') === 'ots' && (shot.cast || []).length >= 2
    ? { ...shot, cast: shot.cast.slice(0, 1) }
    : shot;
  const pick = params.frameMode === 't2i' ? { refs: [], labels: [] } : refsForShot(job, otsFocus, 2);
  if (pick.refs.length) {
    const graph = buildRefEditGraph(await refTemplate(), {
      refs: pick.refs,
      prompt: refInstruction(pick.labels, sceneText, shot.form === 'trans' ? 'trans' : shotForm(shot)),
      aspectRatio: params.aspectRatio || '16:9 (Widescreen)',
      megapixels: Math.min(1.6, Number(params.frameMegapixels) || 1.3),
      steps: Math.max(12, Number(params.frameRefSteps) || 25),
      seed: params.frameSeed,
      prefix: `mv_frame/${job.id}_${shot.index + 1}`,
    });
    applyModelOverrides(graph.prompt, params.models);
    const promptId = await client.submit(graph.prompt);
    const entry = await client.wait(promptId, 2400000);
    const item = firstOutputImage(entry, '461');
    if (!item) throw new Error('参考静帧没有产出');
    const buffer = await fetchComfyImage(client, item);
    const stamp = Date.now().toString(36);
    const fileName = `frame_${String(shot.index + 1).padStart(2, '0')}_${stamp}.png`;
    const file = await saveFrame(path.join(DATA_DIR, job.id), fileName, buffer);
    const name = await client.upload(buffer, `mvf_${job.id}_${shot.index + 1}_${stamp}.png`, 'image/png');
    return { name, file, seed: graph.seed, promptText: sceneText, engine: 'ref', width: graph.width, height: graph.height };
  }

  const built = await buildFramePrompt(plan, shot, {
    aspectRatio: params.aspectRatio || '16:9 (Widescreen)',
    megapixels: params.frameMegapixels || 8.0,
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
    heroes: options.heroes || [],
    audios: Array.isArray(options.audios) ? options.audios : [],
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

/** 把整首歌按这一镜的时间区间切一段，传进 input 当 <Audio 1>（对口型）。 */
async function sliceShotAudio(client, job, songName, shot) {
  const graph = buildSliceAudioPrompt({
    audio: songName,
    start: Math.max(0, Number(shot.start) || 0),
    duration: Math.max(1, Number(shot.seconds) || 8),
    filenamePrefix: `mv_slice/${job.id}_${shot.index + 1}`,
  });
  const promptId = await client.submit(graph);
  const entry = await client.wait(promptId, 300000);
  const { buffer } = await fetchComfyAudio(client, entry, '3');
  return client.upload(buffer, `mvs_${job.id}_${shot.index + 1}_${Date.now().toString(36)}.flac`, 'audio/flac');
}

/**
 * 出成品：能真转场就真转场（ffmpeg xfade），否则回退到 ComfyUI 硬切拼接。
 * 两种路都保证音轨是整首歌、时长按歌长裁齐。
 */
async function buildFinal(client, job, options = {}) {
  const ordered = (job.shots || []).filter((s) => s.comfyVideo && s.video);
  if (ordered.length === 0) throw new Error('没有可拼接的镜头视频');
  const cuts = ordered.slice(0, -1).map((s) => s.transition || 'cut');
  const songDur = Number(job.song && job.song.duration) || 0;
  const wantXfade = cuts.some((t) => t && t !== 'cut');
  const ff = wantXfade ? await probeFfmpeg(HERE) : { ok: false };

  let result;
  if (ff.ok) {
    const outFile = path.join(DATA_DIR, 'mv', job.id + '.mp4');
    const res = await stitchWithTransitions({
      pluginDir: HERE,
      clips: ordered.map((s) => ({ file: s.video, duration: Number(s.videoDuration) || Number(s.seconds) || 10 })),
      transitions: cuts,
      audioFile: job.song.file,
      totalSeconds: songDur,
      outFile,
    });
    result = { buffer: await fs.readFile(res.file), file: res.file, mode: 'ffmpeg · 真转场 xfade' };
  } else {
    const graph = buildStitchPrompt({
      clips: ordered.map((s) => s.comfyVideo),
      audio: job.song && job.song.name,
      filenamePrefix: 'video/MV_' + job.id,
      trimSeconds: songDur,
    });
    const promptId = await client.submit(graph);
    const entry = await client.wait(promptId, 1800000);
    const { buffer } = await fetchVideo(client, entry, { nodeId: '2002' });
    const file = await saveVideo(DATA_DIR, job.id + '.mp4', buffer);
    result = { buffer, file, mode: 'ComfyUI · 硬切拼接' };
  }

  // 电影质感后处理（调色 / 暗角 / 颗粒 / 遮幅 / 片名）——失败不影响交付
  const grading = options.grade !== false;
  const ff2 = grading ? await probeFfmpeg(HERE) : { ok: false };
  if (ff2.ok) {
    try {
      const gradedFile = path.join(DATA_DIR, 'mv', job.id + '_graded.mp4');
      const g = await cinematicPass({
        pluginDir: HERE,
        input: result.file,
        output: gradedFile,
        title: (job.plan && job.plan.title) || '',
        subtitle: 'AI Music Video',
        crop: options.crop !== false,
        grade: true,
        grain: true,
        duration: songDur,
      });
      result = { buffer: await fs.readFile(g.file), file: g.file, mode: result.mode + ' + 电影质感' };
    } catch (error) {
      result.mode += '（质感后处理失败，已交付原片）';
    }
  }
  return result;
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
    // 对话长的镜头先拆成正反打短镜，再排时间轴（拆完镜头数会变多，所以要在 normalizePlan 之前做）
  {
    const raw = Array.isArray(params.plan && params.plan.shots) ? params.plan.shots : [];
    const grown = expandDialogueBeats(raw);
    // 拆镜之后镜头数变多了，shotCount 必须跟着涨，否则 normalizePlan 会把拆出来的短镜又截掉
    params = { ...params, plan: { ...params.plan, shots: grown }, shotCount: grown.length };
  }
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
    // YuE2 单次生成大约只能出 130 秒（实测要 210 秒只给 130.6 秒）。
    // 要更长就分几段出、再用 ffmpeg 交叉淡化接起来。
    const SEG_MAX = 120;
    const SEG_FADE = 6;
    const wantDuration = Number(plan.duration || params.duration) || 60;
    const segments = wantDuration > SEG_MAX ? Math.ceil((wantDuration + SEG_FADE) / SEG_MAX) : 1;
    // 每段多要一点：交叉淡化会吃掉 (segments-1)*fade 秒，
    // 而且 YuE2 通常比请求值略短（108 要出 104），按 3% 余量补回来。
    const segDuration = segments > 1
      ? Math.round((wantDuration + (segments - 1) * SEG_FADE) / segments / 0.97)
      : Math.round(wantDuration);
    const pieces = [];
    for (let i = 0; i < segments; i += 1) {
      if (segments > 1) {
        await jobPatch(job.id, {
          stage: 'song',
          stageLabel: `生成歌曲（第 ${i + 1}/${segments} 段）`,
          songSegments: { total: segments, done: i, segDuration },
        });
      }
      const built = await buildSongPrompt({
        style: (plan.style || params.style || '') + (i > 0 ? ', continuing seamlessly from the previous section, same key, same tempo, same instrumentation' : ''),
        lyrics: segmentLyrics(plan.lyrics || params.lyrics, i, segments),
        duration: segDuration,
        format: 'flac',
        steps: params.songSteps,
        seed: params.songSeed,
        filenamePrefix: 'mv/' + job.id + '_s' + (i + 1),
      });
      applyModelOverrides(built.prompt, params.models);
      const promptId = await client.submit(built.prompt);
      const entry = await client.wait(promptId, 3600000);
      const audio = await fetchSongAudio(client, entry);
      const pieceFile = path.join(DATA_DIR, job.id, `song_s${i + 1}.flac`);
      await fs.mkdir(path.dirname(pieceFile), { recursive: true });
      await fs.writeFile(pieceFile, audio.buffer);
      pieces.push(pieceFile);
      songFileName = audio.filename;
    }
    // 生成完再量一次：YuE2 出多长完全不受控（要 111 秒可能只给 78 秒），
    // 差得多就补一段顶上，否则整片会按实际歌长被压缩（实测 210 秒的片子跑成 160 秒）。
    // 注意：此时还没 concat，不能读 song_full.flac——按每段实际时长减去淡化的重叠量估算。
    const pieceSeconds = [];
    for (const f of pieces) {
      const info = audioDuration(await fs.readFile(f), path.basename(f));
      pieceSeconds.push(Number((info && info.duration) || 0));
    }
    const estimated = pieceSeconds.reduce((a, b) => a + b, 0) - Math.max(0, pieces.length - 1) * SEG_FADE;
    const shortBy = wantDuration - estimated;
    if (segments > 1 && shortBy > wantDuration * 0.05) {
      const extraDuration = Math.round(Math.min(SEG_MAX, shortBy + SEG_FADE + 4));
      await jobPatch(job.id, {
        stage: 'song', stageLabel: `补一段（还差 ${Math.round(shortBy)} 秒）`,
        songSegments: { total: segments + 1, done: segments, segDuration: extraDuration },
      });
      const built = await buildSongPrompt({
        style: (plan.style || params.style || '') + ', continuing seamlessly from the previous section, same key, same tempo, same instrumentation',
        lyrics: segmentLyrics(plan.lyrics || params.lyrics, segments - 1, segments),
        duration: extraDuration,
        format: 'flac',
        steps: params.songSteps,
        seed: params.songSeed,
        filenamePrefix: 'mv/' + job.id + '_s' + (segments + 1),
      });
      applyModelOverrides(built.prompt, params.models);
      const promptId = await client.submit(built.prompt);
      const entry = await client.wait(promptId, 3600000);
      const audio = await fetchSongAudio(client, entry);
      const pieceFile = path.join(DATA_DIR, job.id, `song_s${segments + 1}.flac`);
      await fs.writeFile(pieceFile, audio.buffer);
      pieces.push(pieceFile);
    }
    if (pieces.length > 1) {
      const joined = await concatAudio({
        pluginDir: HERE, files: pieces, outFile: path.join(DATA_DIR, job.id, 'song_full.flac'),
        fade: SEG_FADE, maxSeconds: wantDuration,
      });
      songBuffer = await fs.readFile(joined.file);
      songFileName = 'song_full.flac';
      await jobPatch(job.id, { songSegments: { total: pieces.length, done: pieces.length, segDuration, fade: SEG_FADE } });
    } else {
      songBuffer = await fs.readFile(pieces[0]);
    }
    songInfo = audioDuration(songBuffer, songFileName);
    songName = await client.upload(songBuffer, 'mv_' + job.id + '.flac', 'audio/flac');
  }
  if (!songInfo || !songInfo.duration) {
    throw new Error('读不出音频时长（只支持 flac/mp3）：请用 flac 格式出歌，或手动指定 songSeconds');
  }
  const songDuration = Number(params.songSeconds) || songInfo.duration;
  const savedSong = await saveAudio(DATA_DIR, job.id, { buffer: songBuffer, filename: songFileName || 'song.flac' });
  await jobPatch(job.id, {
    song: { file: savedSong, name: songName, duration: songDuration, estimated: !!songInfo.estimated },
  });

  /* 3. 按真实歌长重排时间轴：歌是 YuE2 生成的，实际长度和请求值不一定一样。
     注意别把镜头数也交给 suggestShotCount 重算：歌短了会连带砍掉后面的镜头，
     结尾那一镜（回扣）会被悄悄扔掉。这里锁死原来的镜头数。 */
  const keepCount = Number(params.shotCount) || (plan.shots ? plan.shots.length : 0) || undefined;
  const wantedDuration = plan.duration;
  {
    const grown = expandDialogueBeats(plan.shots);
    plan = { ...plan, shots: grown };
  }
  plan = normalizePlan(plan, { duration: songDuration, shotCount: keepCount || plan.shots.length });
  const songShort = wantedDuration && songDuration < wantedDuration - 1;
  await jobPatch(job.id, songShort ? {
    songWarning: `歌只出了 ${songDuration.toFixed(1)}s（要 ${wantedDuration}s），时间轴已按真实歌长压缩成每镜 ${(songDuration / Math.max(1, plan.shots.length)).toFixed(1)}s`,
  } : { songWarning: null });
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

  /* 4. 角色定妆图：每个角色一张，全片复用 */
  await jobPatch(job.id, { stage: 'hero', stageLabel: '生成角色定妆图' });
  const castList = charactersOf(plan);
  let heroes = [];
  if (Array.isArray(job.heroes) && job.heroes.length && params.resume !== false) {
    // 续跑：已经有一整套就直接用
    heroes = job.heroes;
  } else if (params.heroImage && castList.length <= 1) {
    const comfy = await ensureComfyFile(client, params.heroImage, 'image');
    const c = castList[0] || { name: '主角', look: '' };
    heroes = [{ label: c.name, look: c.look, comfy, file: null }];
  } else if (params.autoHero !== false) {
    for (let i = 0; i < castList.length; i += 1) {
      const entry = await renderHero(client, job, plan, castList[i], i, params);
      heroes.push(entry);
      await jobPatch(job.id, { heroes });
    }
  }
  await jobPatch(job.id, {
    heroes,
    hero: heroes[0] ? { file: heroes[0].file, name: heroes[0].comfy } : null,
  });

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
        // 对口型：这一镜唱哪句歌词，就切哪一段歌喂给模型
        let audios = [];
        const wantSing = params.lipSync === true || (params.lipSync !== false && !!live.dialogue);
        if (wantSing && songName) {
          try {
            const slice = await sliceShotAudio(client, job, songName, live);
            if (slice) audios = [slice];
          } catch { /* 切片失败就当无声镜头处理，不阻断整支 */ }
        }
        const want = new Set(castOf(plan, live).map((c) => c.name));
        const heroRefs = (job.heroes || []).filter((h) => want.size === 0 || want.has(h.label));
        const made = await renderShotVideo(client, job, plan, live, { ...opt, frameImage: frameName, audios, heroes: heroRefs });
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
  const final = await buildFinal(client, job, { grade: params.grade, crop: params.crop });

  await jobPatch(job.id, {
    status: 'done',
    stage: 'done',
    stageLabel: '完成',
    file: final.file,
    bytes: final.buffer.length,
    stitchMode: final.mode,
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
  // 上一次进程留下的 running 任务清成 interrupted，否则永远显示"正在跑"还挡住续跑
  Promise.resolve()
    .then(function () { return jobStore.ready; })
    .then(function () { return jobStore.reapOrphans(); })
    .then(function (n) { if (n) ctx.logger?.info?.(`[mv] ${n} 个任务标为中断，可续跑`); })
    .catch(function () { /* 忽略 */ });

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
    const ff = await probeFfmpeg(HERE);
    return {
      limits: LIMITS,
      aspects: ASPECTS,
      ffmpeg: ff.ok ? { ok: true, version: ff.version } : { ok: false, error: ff.error },
      defaults: { duration: 60, aspectRatio: '16:9 (Widescreen)', megapixels: 0.4, frameMegapixels: 8, shotSeconds: 8, songFormat: 'flac' },
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
      const { plan, model, lint } = await generatePlan(ctx, args);
      const story = plan.story || {};
      const lines = [
        `《${plan.title}》 · ${plan.duration}s · ${plan.shotCount} 个镜头 · ${model}`,
        lint ? `剧本体检：${lint.score} 分（${lint.passed}/${lint.total}）` : '',
        ...(lint ? lint.checks.map((c) => `  ${c.ok ? '✓' : '✗'} ${c.label}：${c.detail}`) : []),
        '',
        story.logline ? `故事：${story.logline}` : '',
        story.arc ? `情绪：${story.arc}` : '',
        story.ending ? `结尾：${story.ending}` : '',
        story.notes ? `阐述：${story.notes}` : '',
        `曲风：${plan.style}`,
        `主角：${plan.character}`,
        '',
        (plan.props && plan.props.length) ? '物件母题：' : '',
        ...(plan.props || []).map((p) => `  ${p.name}：${p.meaning}`),
        '',
        '剧本（场次体）：',
        ...(plan.scenes || []).map((s) => [
          `场${s.no}　${s.heading || ''}`,
          s.action ? `  动作：${s.action}` : '',
          s.performance ? `  表演：${s.performance}` : '',
          s.sound ? `  声音：${s.sound}` : '',
          s.lyric ? `  唱词：${s.lyric}` : '',
        ].filter(Boolean).join('\n')),
        '',
        '剧本 / 分镜：',
        ...plan.shots.map((s) => [
          `${s.index + 1}. [${s.start}s-${s.end}s] ${s.label}${s.section ? ` · 对位 ${s.section}` : ''}${s.beat ? ` · ${s.beat}` : ''}`,
          `   镜头：${cameraSummary(s)} ｜ 转场：${s.transition || '—'}`,
          `   场景：${s.scene || '—'}${s.time ? `（${s.time}）` : ''}`,
          `   动作：${s.action || '—'}`,
          s.prop ? `   物件：${s.prop}` : '',
          s.performance ? `   表演：${s.performance}` : '',
          s.objective ? `   他要：${s.objective}` : '',
        ].filter(Boolean).join('\n')),
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

  ctx.tools.register({
    name: 'mv_book',
    description: '把某个已完成的任务导成「导演本」：单文件 HTML（A4 打印样式，定妆/节奏/剧本/分镜板/分镜表，图片内嵌），双击可看，Ctrl+P 出 PDF。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id（不填就用最近一个）' },
        outFile: { type: 'string', description: '输出 html 路径；不填写到插件 .data/<任务id>/导演本.html' },
      },
    },
    output: OUTPUT,
    timeoutMs: 180000,
    async execute(args) {
      await jobStore.refresh();
      const job = args.id ? jobStore.get(String(args.id)) : jobStore.list()[0];
      if (!job) throw new Error('没有这个任务');
      const html = buildBookHtml(job, { pluginDir: PLUGIN_DIR });
      const outFile = args.outFile
        ? path.resolve(String(args.outFile))
        : path.join(DATA_DIR, job.id, '导演本.html');
      await fs.mkdir(path.dirname(outFile), { recursive: true });
      await fs.writeFile(outFile, html, 'utf8');
      const shots = Array.isArray(job.shots) ? job.shots : [];
      return text([
        `导演本已生成：《${(job.plan && job.plan.title) || '未命名'}》`,
        `文件：${outFile}（${(html.length / 1024 / 1024).toFixed(2)} MB）`,
        `内容：${shots.length} 镜 · 静帧 ${shots.filter((s) => s.frameFile).length} 张 · ${(job.plan && job.plan.scenes && job.plan.scenes.length) || 0} 场`,
      ]);
    },
  });

  ctx.tools.register({
    name: 'mv_script',
    description: '只出剧本 + 导演本，不占 GPU：主题 → 剧本/歌词/分镜 → 体检 → 单文件 HTML（静帧位置留白）。先看本子决定要不要花一小时渲染。',
    parameters: {
      type: 'object',
      properties: {
        theme: { type: 'string', description: '一句话主题' },
        duration: { type: 'number', description: '时长秒数，默认 60；>120 秒会自动分段出歌' },
        shotCount: { type: 'number', description: '镜头数；不填按每镜约 10 秒算' },
        style: { type: 'string', description: '指定曲风（可选）' },
        lyrics: { type: 'string', description: '自带歌词（可选），只补段落标记' },
        outFile: { type: 'string', description: '输出 html 路径；不填写到 .data/script-<时间>.html' },
      },
      required: ['theme'],
    },
    output: OUTPUT,
    timeoutMs: 300000,
    async execute(args) {
      const started = Date.now();
      // 生成是随机的：同样的主题，一次 100 分、一次 89 分。所以自动重试，
      // 拿到满分或试满 3 次为止——反正只花 45 秒、不占 GPU。
      const attempts = [];
      let best = null;
      for (let i = 0; i < 3; i += 1) {
        const got = await generatePlan(ctx, {
          theme: args.theme,
          duration: args.duration,
          shotCount: args.shotCount,
          style: args.style,
          lyrics: args.lyrics,
        });
        attempts.push(got.lint.score);
        if (!best || got.lint.score > best.lint.score) best = got;
        if (got.lint.score >= 100) break;
      }
      const { plan, lint } = best;
      const id = 'script_' + Date.now().toString(36);
      const job = { id, plan, shots: plan.shots, heroes: [], song: null, params: {} };
      const html = buildBookHtml(job, { pluginDir: PLUGIN_DIR });
      const outFile = args.outFile
        ? path.resolve(String(args.outFile))
        : path.join(DATA_DIR, `${id}.html`);
      await fs.mkdir(path.dirname(outFile), { recursive: true });
      await fs.writeFile(outFile, html, 'utf8');
      const jsonFile = outFile.replace(/\.html$/i, '') + '.json';
      await fs.writeFile(jsonFile, JSON.stringify({ plan, lint }, null, 2), 'utf8');
      const fails = (lint.checks || []).filter((c) => c.ok === false);
      return text([
        `《${plan.title}》${(plan.shots || []).length} 镜 · ${(plan.scenes || []).length} 场 · 全长 ${Math.round((plan.shots || []).reduce((a, s) => a + (s.end - s.start), 0))} 秒`,
        `体检：${lint.score} 分（${lint.passed}/${lint.total}）${fails.length ? '｜没过：' + fails.map((c) => c.label || c.id).join('、') : ''}${attempts.length > 1 ? `｜试了 ${attempts.length} 次：${attempts.join('→')}` : ''}`,
        `本子：${outFile}（${(html.length / 1024 / 1024).toFixed(2)} MB）`,
        `素材：${(plan.props || []).map((p) => p.name).join('、') || '无'}　｜　下一步可以 mv_book / mv_render`,
      ]);
    },
  });

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
          const { plan, model, lint } = await generatePlan(ctx, body);
          sendJson(response, 200, { plan, model, lint });
        } catch (error) {
          sendJson(response, 502, { error: 'plan_failed', message: friendlyError(error) });
        }
      },
    }));

    /** 弱镜返修：按体检意见重写弱镜，返回新 plan 与前后分数。 */
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/polish-shots',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        let body = null;
        try { body = await readJsonBody(request); } catch { body = null; }
        if (!body) { sendJson(response, 400, { error: 'bad_body' }); return; }
        let plan = body.plan && typeof body.plan === 'object' ? body.plan : null;
        if (!plan && body.id) {
          const job = jobStore.get(String(body.id));
          if (!job) { sendJson(response, 404, { error: 'job_not_found' }); return; }
          plan = job.plan;
        }
        if (!plan || !Array.isArray(plan.shots) || !plan.shots.length) {
          sendJson(response, 400, { error: 'plan_required', message: '要么给 plan，要么给任务 id' });
          return;
        }
        try {
          const before = await reviewPlan(ctx, plan);
          const weakItems = before.shots.filter((s) => (body.all ? true : s.total <= 14));
          const next = await rewriteShots(ctx, plan, weakItems);
          const after = body.recheck === false ? null : await reviewPlan(ctx, next);
          sendJson(response, 200, {
            plan: next,
            before: { avg: before.avg, weak: before.weak, overall: before.overall },
            after: after ? { avg: after.avg, weak: after.weak, overall: after.overall, shots: after.shots } : null,
            rewritten: weakItems.map((s) => s.i),
          });
        } catch (error) {
          sendJson(response, 500, { error: 'polish_failed', message: String((error && error.message) || error) });
        }
      },
    }));

    /** 分镜体检：按"一眼读懂"四项打分，指出弱镜与改法。 */
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/review',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        let body = null;
        try { body = await readJsonBody(request); } catch { body = null; }
        if (!body) { sendJson(response, 400, { error: 'bad_body' }); return; }
        let plan = body.plan && typeof body.plan === 'object' ? body.plan : null;
        if (!plan && body.id) {
          const job = jobStore.get(String(body.id));
          if (!job) { sendJson(response, 404, { error: 'job_not_found' }); return; }
          plan = job.plan;
        }
        if (!plan || !Array.isArray(plan.shots) || !plan.shots.length) {
          sendJson(response, 400, { error: 'plan_required', message: '要么给 plan，要么给任务 id' });
          return;
        }
        sendJson(response, 200, await reviewPlan(ctx, plan));
      },
    }));

    /** 两版逐镜对打：打分噪声大，比 A/B 稳。 */
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/compare',
      handler: async (request, response) => {
        try {
          if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
          if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
          let body = null;
          try { body = await readJsonBody(request); } catch { body = null; }
          if (!body) { sendJson(response, 400, { error: 'bad_body' }); return; }
          const pick = (v) => {
            if (v && typeof v === 'object' && Array.isArray(v.shots)) return v;
            if (typeof v === 'string') {
              const job = jobStore.get(v);
              if (job) return job.plan;
            }
            return null;
          };
          const a = pick(body.a);
          const b = pick(body.b);
          if (!a || !b) { sendJson(response, 400, { error: 'two_plans_required', message: 'a / b 各给一个 plan，或两个任务 id' }); return; }
          sendJson(response, 200, await comparePlans(ctx, a, b));
        } catch (error) {
          sendJson(response, 500, { error: 'compare_failed', message: String((error && error.message) || error) });
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
        // 续跑时可以覆盖一部分参数（比如把视频像素从 0.4 提到 0.6）
        if (body && body.params && typeof body.params === 'object') {
          const allowed = ['megapixels', 'frameMegapixels', 'aspectRatio', 'tailLink', 'lipSync', 'grade', 'crop', 'seed'];
          const patch = {};
          for (const key of allowed) if (body.params[key] !== undefined) patch[key] = body.params[key];
          job.params = { ...job.params, ...patch };
          await jobStore.patch(id, { params: job.params });
        }
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

    /** 导演本：浏览器里直接看 / 打印成 PDF（不加 ?download=1 就直接渲染）。 */
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/book',
      handler: async (request, response) => {
        if (request.method !== 'GET') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        const url = new URL(request.url || '/', 'http://localhost');
        const id = String(url.searchParams.get('id') || '');
        await jobStore.refresh();
        const job = id ? jobStore.get(id) : jobStore.list()[0];
        if (!job) { response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ error: 'not_found', id })); return; }
        try {
          const html = buildBookHtml(job, { pluginDir: PLUGIN_DIR });
          const buffer = Buffer.from(html, 'utf8');
          const headers = { 'content-type': 'text/html; charset=utf-8', 'content-length': buffer.length };
          if (url.searchParams.get('download')) {
            const name = encodeURIComponent(`《${(job.plan && job.plan.title) || job.id}》导演本.html`);
            headers['content-disposition'] = `attachment; filename="mv-book.html"; filename*=UTF-8''${name}`;
          }
          response.writeHead(200, headers);
          response.end(buffer);
        } catch (error) {
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'book_failed', message: friendlyError(error) }));
        }
      },
    }));

    /** 重出定妆图：每个角色按「原形 / 人形」两张重生成，不动已经出好的静帧与视频。 */
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/heroes',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        let body = null;
        try { body = await readJsonBody(request); } catch { body = null; }
        const id = String((body && body.id) || '');
        const only = body && body.index !== undefined ? Number(body.index) : null;
        await jobStore.refresh();
        const job = jobStore.get(id);
        if (!job) { sendJson(response, 404, { error: 'not_found', id }); return; }
        const castList = charactersOf(job.plan);
        if (!castList.length) { sendJson(response, 400, { error: 'no_characters' }); return; }
        try {
          const client = new ComfyClient();
          if (!(await client.alive())) throw new Error('连不上 ComfyUI');
          const heroes = Array.isArray(job.heroes) ? job.heroes.slice() : [];
          for (let i = 0; i < castList.length; i += 1) {
            if (only !== null && only !== i) continue;
            const entry = await renderHero(client, job, job.plan, castList[i], i, job.params || {});
            if (heroes[i]) heroes[i] = { ...heroes[i], ...entry }; else heroes[i] = entry;
            await jobStore.patch(id, { heroes });
          }
          sendJson(response, 200, { ok: true, heroes });
        } catch (error) {
          sendJson(response, 500, { error: 'hero_failed', message: friendlyError(error) });
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
          'move', 'light', 'dof', 'transition', 'action', 'dialogue', 'seed', 'seconds', 'cast'];
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

    /** 导出方案：剧本 + 参数存成一个 json，下次直接导回来（不用把整支 MV 重跑才能复用）。 */
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/export',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const id = String(url.searchParams.get('id') || '');
        await jobStore.refresh();
        const job = jobStore.get(id);
        if (!job || !job.plan) { sendJson(response, 404, { error: 'not_found', id }); return; }
        const project = {
          kind: 'mv-project',
          version: 1,
          exportedAt: new Date().toISOString(),
          plan: job.plan,
          params: {
            aspectRatio: job.params.aspectRatio,
            megapixels: job.params.megapixels,
            tailLink: job.params.tailLink,
            lipSync: job.params.lipSync,
            seed: job.params.seed,
          },
        };
        const safe = String(job.plan.title || 'mv').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40);
        // 头部值只能是 ASCII：中文名放进 filename*（RFC 5987），别直接塞进 filename="..."
        const asciiName = safe.replace(/[^\x20-\x7E]+/g, '_') || 'mv';
        const body = JSON.stringify(project, null, 2);
        try {
          response.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="${asciiName}.json"; filename*=UTF-8''${encodeURIComponent(safe + '.json')}`,
            'content-length': String(Buffer.byteLength(body)),
          });
          response.end(body);
        } catch (error) {
          sendJson(response, 500, { error: 'export_failed', message: String((error && error.message) || error) });
        }
      },
    }));

    /** 导入方案：校验并规整后返回给面板，不直接开跑。 */
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/import',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        let body = null;
        try { body = await readJsonBody(request); } catch { body = null; }
        const project = body && (body.project || body);
        const planSrc = project && (project.plan || project);
        if (!planSrc || !Array.isArray(planSrc.shots)) {
          sendJson(response, 400, { error: 'bad_project', message: '这不是一个 MV 方案文件（缺 shots）' });
          return;
        }
        try {
          const plan = normalizePlan(planSrc, {
            duration: planSrc.duration,
            shotCount: planSrc.shots.length,
          });
          sendJson(response, 200, { plan, params: (project && project.params) || {} });
        } catch (error) {
          sendJson(response, 400, { error: 'bad_project', message: friendlyError(error) });
        }
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
        if (!(job.shots || []).some((s) => s.comfyVideo && s.video)) { sendJson(response, 400, { error: 'no_clips' }); return; }
        try {
          const client = new ComfyClient();
          const out = await buildFinal(client, job, { grade: (body && body.grade) !== false, crop: (body && body.crop) !== false });
          await jobStore.patch(id, {
            status: 'done', stage: 'done', stageLabel: '完成',
            file: out.file, bytes: out.buffer.length, stitchMode: out.mode,
          });
          sendJson(response, 200, { ok: true, file: out.file, mode: out.mode });
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


