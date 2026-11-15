/**
 * MV 核心：歌曲时长解析、时间轴分配、单镜头图装配、成品拼接图。
 *
 * 设计前提（MiniMax H3 的硬限制）：
 *   - 单段视频 5–15 秒，所以一支 MV 必然是 N 个 5–15 秒镜头拼起来；
 *   - 每个镜头自带的音轨一律丢掉，成品音轨由 ConcatenateVideo.complete_audio 压上原曲。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { buildPrompt as buildRef2vPrompt } from './ref2v.js';
import { buildPrompt as buildT2iPrompt } from './t2i.js';
import { MOVES, LIGHTS, cameraFragment } from './shotlang.js';

export const LIMITS = {
  shotMinSeconds: 5,
  shotMaxSeconds: 15,
  maxShots: 100,
  songMinSeconds: 15,
  songMaxSeconds: 600,
};

/* --------------------------- 音频时长 --------------------------- */

/**
 * 从 FLAC 的 STREAMINFO 里读精确时长（不解码）。
 * STREAMINFO 位于文件头 8 字节之后，固定 34 字节；
 * 偏移 18..25 的 64 位里依次是 采样率20 | 声道3 | 位深5 | 总采样数36。
 */
export function flacInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 42) return null;
  if (buffer.subarray(0, 4).toString('latin1') !== 'fLaC') return null;
  const b = buffer;
  const sampleRate = (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
  if (!sampleRate) return null;
  const channels = ((b[20] >> 1) & 0x07) + 1;
  const bitsPerSample = (((b[20] & 0x01) << 4) | (b[21] >> 4)) + 1;
  const totalSamples = (b[21] & 0x0f) * 2 ** 32
    + ((b[22] << 24) >>> 0) + (b[23] << 16) + (b[24] << 8) + b[25];
  if (!totalSamples) return null;
  return { sampleRate, channels, bitsPerSample, totalSamples, duration: totalSamples / sampleRate };
}

/** MP3 只能估：按第一帧的比特率算，VBR 会有偏差，返回里带 estimated 标记。 */
export function mp3Info(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  let offset = 0;
  if (buffer.length > 10 && buffer.subarray(0, 3).toString('latin1') === 'ID3') {
    const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) | ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
    offset = 10 + size;
  }
  for (let i = offset; i < Math.min(buffer.length - 4, offset + 65536); i += 1) {
    if (buffer[i] !== 0xff || (buffer[i + 1] & 0xe0) !== 0xe0) continue;
    const versionBits = (buffer[i + 1] >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layerBits = (buffer[i + 1] >> 1) & 0x03; // 1=Layer3
    if (versionBits === 1 || layerBits !== 1) continue;
    const bitrateIndex = (buffer[i + 2] >> 4) & 0x0f;
    const rateIndex = (buffer[i + 2] >> 2) & 0x03;
    if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) continue;
    const rates = versionBits === 3 ? [44100, 48000, 32000] : [22050, 24000, 16000];
    const sampleRate = rates[rateIndex];
    const table = versionBits === 3
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
    const kbps = table[bitrateIndex];
    if (!kbps) continue;
    const duration = (buffer.length - offset) / ((kbps * 1000) / 8);
    return { sampleRate, channels: 2, bitsPerSample: 16, duration, estimated: true, kbps };
  }
  return null;
}

/** 按扩展名解析音频时长；都不认识就返回 null，让调用方要求用户手填。 */
export function audioDuration(buffer, filename = '') {
  const ext = path.extname(String(filename || '')).toLowerCase();
  let info = null;
  if (ext === '.flac') info = flacInfo(buffer);
  else if (ext === '.mp3') info = mp3Info(buffer);
  else info = flacInfo(buffer) || mp3Info(buffer);
  return info ? { ...info, duration: Math.round(info.duration * 10) / 10 } : null;
}

/* --------------------------- 时间轴 --------------------------- */

/** 总时长 → 建议镜头数：目标每镜 10 秒，且每镜必须落在 5–15 秒之间。 */
export function suggestShotCount(duration, target = 10) {
  const d = Number(duration);
  if (!Number.isFinite(d) || d <= 0) return 1;
  const min = Math.max(1, Math.ceil(d / LIMITS.shotMaxSeconds));
  const max = Math.max(1, Math.floor(d / LIMITS.shotMinSeconds));
  const wanted = Math.round(d / target);
  const count = Math.min(Math.max(wanted, min), Math.max(max, 1));
  return Math.max(1, Math.min(LIMITS.maxShots, count));
}

/** 均分时间轴；最后一镜吃掉余数，保证 start/end 首尾相接。 */
export function allocateTimeline(duration, count) {
  const total = Math.max(0.1, Number(duration) || 0);
  const n = Math.max(1, Math.min(LIMITS.maxShots, Math.trunc(Number(count) || 1)));
  const base = total / n;
  const shots = [];
  for (let i = 0; i < n; i += 1) {
    const start = Math.round(base * i * 100) / 100;
    const end = i === n - 1 ? Math.round(total * 100) / 100 : Math.round(base * (i + 1) * 100) / 100;
    shots.push({
      index: i,
      start,
      end,
      seconds: Math.round(Math.min(LIMITS.shotMaxSeconds, Math.max(LIMITS.shotMinSeconds, end - start)) * 100) / 100,
    });
  }
  return shots;
}

/* --------------------------- 分镜表 --------------------------- */

/** 从模型输出里抠出 JSON（容忍代码块、前后废话）。 */
export function parsePlanJson(raw) {
  let text = String(raw || '').trim();
  if (!text) throw new Error('模型没有返回分镜表');
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) text = fenced[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('分镜表不是合法 JSON：' + text.slice(0, 200));
  }
  return data;
}

/**
 * 把模型给的剧本 + 分镜表规整成可执行的：
 * 镜头数定死、时间轴重算、剧本四件套（logline/arc/ending/story）补齐、提示词去空行。
 * shots 里允许只给 prompt；秒数一律由时间轴决定，避免模型瞎写导致每镜越界。
 */
export function normalizePlan(data, opts = {}) {
  const duration = Math.min(
    LIMITS.songMaxSeconds,
    Math.max(LIMITS.songMinSeconds, Number(opts.duration) || 60),
  );
  const rawShots = Array.isArray(data && data.shots) ? data.shots : [];
  const wanted = Number(opts.shotCount) || suggestShotCount(duration);
  const count = Math.max(1, Math.min(LIMITS.maxShots, Math.min(wanted, Math.max(1, rawShots.length || wanted))));
  const timeline = allocateTimeline(duration, count);
  const storySrc = (data && data.story && typeof data.story === 'object') ? data.story : {};

  const picks = (...keys) => {
    for (const key of keys) {
      const fromStory = storySrc[key];
      const fromRoot = data && data[key];
      const value = typeof fromStory === 'string' && fromStory.trim() ? fromStory : fromRoot;
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  };

  const shots = timeline.map((slot, i) => {
    const src = rawShots[i] || {};
    const text = (v) => String(v || '').replace(/\s+/g, ' ').trim();
    const action = text(src.action || src.prompt || src.description);
    return {
      index: i,
      start: slot.start,
      end: slot.end,
      seconds: slot.seconds,
      label: text(src.label || src.title) || `镜头 ${i + 1}`,
      section: text(src.section || src.lyricSection),
      beat: text(src.beat || src.emotion),
      // 专业分镜字段：场景 / 时间 / 景别 / 方向 / 俯仰 / 运镜 / 灯光 / 景深 / 转场
      scene: text(src.scene || src.location),
      time: text(src.time),
      size: text(src.size) || 'medium',
      horizontal: text(src.horizontal) || 'front',
      elevation: text(src.elevation) || 'eye',
      move: text(src.move || src.movement) || 'static',
      light: text(src.light || src.lighting) || 'natural',
      dof: text(src.dof) || 'medium',
      transition: text(src.transition) || 'cut',
      action,
      dialogue: text(src.dialogue),
      prompt: action,
      seed: Number.isFinite(Number(src.seed)) ? Math.trunc(Number(src.seed)) : null,
      // 运行时产物：静帧 / 历史版本 / 视频 / 末帧
      frame: null,
      frameFile: null,
      frameVersions: [],
      video: null,
      comfyVideo: null,
      tailFrame: null,
      frameAt: null,
      videoAt: null,
    };
  });

  const empty = shots.filter((s) => !s.prompt);
  if (empty.length) {
    throw new Error(`有 ${empty.length} 个镜头没有提示词（第 ${empty.map((s) => s.index + 1).join('、')} 个）`);
  }

  return {
    title: String((data && data.title) || '').trim() || '未命名 MV',
    style: String((data && data.style) || '').trim(),
    lyrics: String((data && data.lyrics) || '').trim(),
    character: String((data && data.character) || '').trim(),
    negative: String((data && data.negative) || '').trim(),
    story: {
      logline: picks('logline', 'oneLine', 'premise'),
      arc: picks('arc', 'emotionArc', 'structure'),
      ending: picks('ending', 'finalImage'),
      notes: picks('notes', 'direction', 'directorNotes'),
    },
    duration,
    shotCount: shots.length,
    shots,
  };
}

/* --------------------------- 提示词组装 --------------------------- */

/**
 * 静帧（图片）提示词：这一镜的"定妆照"。
 * 结构化字段在这里咬合：人物 + 场景 + 时间 + 动作 + 景别/角度/运镜/灯光/景深 + 全片风格。
 */
export function composeFramePrompt(plan, shot) {
  const parts = [];
  if (plan.character) parts.push(plan.character.replace(/\s+/g, ' ').trim());
  if (shot.scene) parts.push(shot.scene);
  if (shot.time) parts.push(shot.time);
  if (shot.action) parts.push(shot.action);
  parts.push(cameraFragment(shot));
  if (shot.beat) parts.push(`情绪：${shot.beat}`);
  if (plan.style) parts.push(plan.style);
  parts.push('电影剧照，人物与场景细节清晰，不要文字、不要水印');
  return parts.filter(Boolean).join('。');
}

/** 生成这一镜的静帧图（Krea2）。 */
export async function buildFramePrompt(plan, shot, options = {}) {
  const promptText = composeFramePrompt(plan, shot);
  const built = await buildT2iPrompt({
    prompt: promptText,
    aspectRatio: options.aspectRatio || '16:9 (Widescreen)',
    megapixels: options.megapixels || 1.0,
    steps: options.steps || 8,
    batchSize: 1,
    expand: options.expand !== false,
    seed: options.seed,
    filenamePrefix: options.filenamePrefix || 'mv_frame',
  });
  return { ...built, promptText };
}

/**
 * 视频提示词：静帧当首帧、定妆图当身份参考，正文只写"怎么动"。
 * 画面长什么样已经由静帧定死了，这里再描述一遍场景只会跟首帧打架。
 */
export function composeVideoPrompt(plan, shot, opts = {}) {
  const pics = [];
  if (opts.frameImage) pics.push('以 <Picture 1> 作为本镜的开场画面，人物、服装、场景、光线都与它一致');
  if (opts.heroImage) pics.push(opts.frameImage ? '<Picture 2> 是同一人物的身份参考' : '<Picture 1> 是同一人物的身份参考');
  if (opts.audioRef) {
    const line = shot.dialogue ? `，唱的歌词是「${shot.dialogue}」` : '';
    pics.push(`<Audio 1> 是本镜要唱的那一段歌声，人物严格按 <Audio 1> 的音色与节奏开口对口型${line}`);
  }
  const head = pics.length ? pics.join('；') + '。' : '';
  const move = (MOVES.find((m) => m.key === shot.move) || MOVES[0]).en;
  const light = (LIGHTS.find((l) => l.key === shot.light) || LIGHTS[0]).en;
  const body = [
    shot.action ? `${shot.action}。` : '',
    `镜头：${move}。`,
    `光线：${light}。`,
    '人物表演自然连贯，画面稳定，不要文字、不要水印、不要字幕。',
  ].filter(Boolean).join('');
  return head + body;
}

/** 生成这一镜的 ref2v 图：首帧=静帧，身份=定妆图。 */
export async function buildShotVideoPrompt(plan, shot, options = {}) {
  const images = [];
  if (options.frameImage) images.push(options.frameImage);
  if (options.heroImage) images.push(options.heroImage);
  const promptText = composeVideoPrompt(plan, shot, {
    frameImage: options.frameImage,
    heroImage: options.heroImage,
    audioRef: Array.isArray(options.audios) && options.audios.length > 0,
  });
  const built = await buildRef2vPrompt({
    prompt: promptText,
    images,
    audios: Array.isArray(options.audios) ? options.audios : [],
    aspectRatio: options.aspectRatio,
    megapixels: options.megapixels,
    durationSeconds: shot.seconds,
    seed: Number.isFinite(Number(shot.seed)) ? shot.seed : options.seed,
    lightning: options.lightning !== false,
    refImageSize: options.refImageSize || 'match',
  });
  return { ...built, promptText };
}

/* --------------------------- 音频切片（对口型用） --------------------------- */

/**
 * 把整首歌按镜头时间轴切出一段，喂给模型当 <Audio 1> 的参考。
 * 用的是 ComfyUI 自带的 TrimAudioDuration，不需要 ffmpeg：
 *   LoadAudio → TrimAudioDuration(start_index, duration) → SaveAudioAdvanced(flac)
 * 单元测试的坑：flac 不需要 format.quality，mp3/opus 才要。
 */
export function buildSliceAudioPrompt({ audio, start, duration, filenamePrefix = 'mv_slice' }) {
  if (!audio) throw new Error('切片需要整首歌');
  if (!(Number(duration) > 0)) throw new Error('切片时长必须大于 0');
  return {
    '1': { class_type: 'LoadAudio', inputs: { audio } },
    '2': {
      class_type: 'TrimAudioDuration',
      inputs: { audio: ['1', 0], start_index: Math.max(0, Number(start) || 0), duration: Number(duration) },
    },
    '3': {
      class_type: 'SaveAudioAdvanced',
      inputs: { audio: ['2', 0], filename_prefix: filenamePrefix, format: 'flac' },
    },
  };
}

/** 取 history 里某个节点产出的音频并下载。 */
export async function fetchComfyAudio(client, entry, nodeId) {
  const items = [];
  const nodes = nodeId ? [String(nodeId)] : Object.keys(entry.outputs || {});
  for (const id of nodes) {
    const output = (entry.outputs || {})[id];
    if (!output) continue;
    for (const item of output.audio || []) if (item && item.filename) items.push(item);
  }
  const item = items[0];
  if (!item) throw new Error('切片没有产出音频');
  const url = client.host + '/view?filename=' + encodeURIComponent(item.filename)
    + '&subfolder=' + encodeURIComponent(item.subfolder || '')
    + '&type=' + encodeURIComponent(item.type || 'output');
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error('取回切片失败：HTTP ' + res.status);
  return { buffer: Buffer.from(await res.arrayBuffer()), filename: item.filename };
}

/* --------------------------- 末帧衔接 --------------------------- */

/**
 * 从一段视频里抽最后一帧存成图片。
 * 没有 ffmpeg 也能做：LoadVideo → Video Slice(掐最后 0.12 秒) → GetVideoComponents → SaveImage。
 * 抽出来的图会直接当下一镜的首帧，这就是"末帧接龙"。
 */
export function buildTailFramePrompt({ video, startTime, filenamePrefix = 'mv_tail' }) {
  const start = Math.max(0, Number(startTime) || 0);
  return {
    '1': { class_type: 'LoadVideo', inputs: { file: video } },
    '2': {
      class_type: 'Video Slice',
      inputs: { video: ['1', 0], start_time: start, duration: 0.12, strict_duration: false },
    },
    '3': { class_type: 'GetVideoComponents', inputs: { video: ['2', 0] } },
    '4': { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: filenamePrefix } },
  };
}

/* --------------------------- 拼接图 --------------------------- */

/**
 * 成品拼接：N 段视频按顺序接起来，音轨换成整首歌。
 * complete_audio 会覆盖每段自带的音频——镜头里模型自己生成的声音全部丢掉。
 *
 * trimSeconds：H3 的帧数按 17n+5 对齐，7.5 秒会变成 8 秒，几段下来成片比歌长；
 * 给这个参数就用 Video Slice 把成片裁到和歌一样长，避免结尾 1 秒静音。
 */
export function buildStitchPrompt({ clips, audio, filenamePrefix = 'video/MV', trimSeconds = 0 }) {
  const names = (clips || []).map((c) => String(c || '').trim()).filter(Boolean);
  if (names.length === 0) throw new Error('没有可拼接的镜头');
  if (names.length > LIMITS.maxShots) throw new Error(`一次最多拼 ${LIMITS.maxShots} 段`);
  if (!audio) throw new Error('缺少音轨：拼接必须给整首歌');

  const prompt = {};
  const links = names.map((name, i) => {
    const id = String(1000 + i);
    prompt[id] = { class_type: 'LoadVideo', inputs: { file: name } };
    return [id, 0];
  });

  const concatInputs = { codec: 'auto' };
  // AUTOGROW 输入的键名是 videos.video0 / videos.video1（下标前没有下划线），
  // 写成 videos.video_0 会被静默忽略，然后报 required_input_missing。
  links.forEach((link, i) => { concatInputs[`videos.video${i}`] = link; });

  prompt['2000'] = { class_type: 'LoadAudio', inputs: { audio } };
  concatInputs.complete_audio = ['2000', 0];

  prompt['2001'] = { class_type: 'ConcatenateVideo', inputs: concatInputs };

  let tail = ['2001', 0];
  const trim = Number(trimSeconds);
  if (Number.isFinite(trim) && trim > 0.5) {
    prompt['2003'] = {
      class_type: 'Video Slice',
      inputs: { video: ['2001', 0], start_time: 0, duration: trim, strict_duration: false },
    };
    tail = ['2003', 0];
  }

  prompt['2002'] = {
    class_type: 'SaveVideo',
    inputs: { video: tail, filename_prefix: filenamePrefix, format: 'mp4' },
  };
  return prompt;
}

/**
 * 从 history 条目取成品视频并下载。
 *
 * 坑：LoadVideo / LoadImage 这类加载节点也会在 outputs 里留一条 {type:'input'} 的记录，
 * 而且排在 SaveVideo 前面。照单收第一条会下回"输入的素材"（曾把原片当成拼接结果存下来）。
 * 所以只认 type==='output' 的条目；给了 nodeId 就只看那个保存节点。
 */
export async function fetchVideo(client, entry, options = {}) {
  const candidates = [];
  for (const [nodeId, output] of Object.entries(entry.outputs || {})) {
    for (const key of ['videos', 'gifs', 'images']) {
      for (const item of output[key] || []) {
        if (!item || !item.filename) continue;
        if (!/\.(mp4|webm|mov|mkv)$/i.test(String(item.filename))) continue;
        if (String(item.type || 'output') !== 'output') continue;
        candidates.push({ ...item, nodeId });
      }
    }
  }
  if (candidates.length === 0) throw new Error('这次执行没有产出视频');

  let pick = null;
  if (options.nodeId) pick = candidates.find((c) => c.nodeId === String(options.nodeId)) || null;
  if (!pick) {
    // 没指定节点时，取时长最大的那条（拼接结果总是不短于任意单段）
    const score = (c) => Number((c.metadata && c.metadata.duration) || 0);
    pick = candidates.slice().sort((a, b) => score(b) - score(a))[0];
  }

  const url = client.host + '/view?filename=' + encodeURIComponent(pick.filename)
    + '&subfolder=' + encodeURIComponent(pick.subfolder || '')
    + '&type=' + encodeURIComponent(pick.type || 'output');
  const res = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!res.ok) throw new Error('取回视频失败：HTTP ' + res.status);
  return {
    buffer: Buffer.from(await res.arrayBuffer()),
    filename: pick.filename,
    subfolder: pick.subfolder || '',
    duration: Number((pick.metadata && pick.metadata.duration) || 0) || null,
  };
}

/** 产物落盘。 */
export async function saveVideo(dataDir, filename, buffer) {
  const dir = path.join(dataDir, 'mv');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, filename);
  await fs.writeFile(file, buffer);
  return file;
}

/** 取 history 里某个保存节点产出的图片条目（SaveImage 会把 batch 拆成多条，取最后一张）。 */
export function firstOutputImage(entry, nodeId) {
  const nodes = nodeId ? [String(nodeId)] : Object.keys(entry.outputs || {});
  const items = [];
  for (const id of nodes) {
    const output = (entry.outputs || {})[id];
    if (!output) continue;
    for (const item of output.images || []) {
      if (item && item.filename && /\.(png|jpg|jpeg|webp)$/i.test(item.filename)) items.push(item);
    }
  }
  return items.length ? items[items.length - 1] : null;
}

/** 把 ComfyUI 输出目录里的图片取回来。 */
export async function fetchComfyImage(client, item) {
  const url = client.host + '/view?filename=' + encodeURIComponent(item.filename)
    + '&subfolder=' + encodeURIComponent(item.subfolder || '')
    + '&type=' + encodeURIComponent(item.type || 'output');
  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error('取回图片失败：HTTP ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

/** 静帧落盘。 */
export async function saveFrame(dataDir, filename, buffer) {
  const dir = path.join(dataDir, 'frames');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, filename);
  await fs.writeFile(file, buffer);
  return file;
}

export function mimeOf(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.flac') return 'audio/flac';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.ogg' || ext === '.opus') return 'audio/ogg';
  if (ext === '.wav') return 'audio/wav';
  return 'application/octet-stream';
}
