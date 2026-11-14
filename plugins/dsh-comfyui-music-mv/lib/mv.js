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
    const prompt = String((src && (src.prompt || src.description)) || '').replace(/\s+/g, ' ').trim();
    return {
      index: i,
      start: slot.start,
      end: slot.end,
      seconds: slot.seconds,
      label: String((src && (src.label || src.title)) || `镜头 ${i + 1}`).trim(),
      section: String((src && (src.section || src.lyricSection)) || '').trim(),
      beat: String((src && (src.beat || src.emotion)) || '').trim(),
      camera: String((src && (src.camera || src.shot)) || '').trim(),
      transition: String((src && (src.transition || src.cut)) || '').trim(),
      prompt,
      seed: Number.isFinite(Number(src && src.seed)) ? Math.trunc(Number(src.seed)) : null,
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

/* --------------------------- 单镜头图 --------------------------- */

/** 拼出这一镜最终给模型的提示词：主角一致性 + 镜头内容 + 运镜/情绪 + 全片风格。 */
export function composeShotPrompt(plan, shot) {
  const parts = [];
  if (plan.character) parts.push(plan.character.replace(/\s+/g, ' ').trim());
  parts.push(shot.prompt);
  if (shot.camera && !shot.prompt.includes(shot.camera)) parts.push(shot.camera);
  if (shot.beat) parts.push(`情绪：${shot.beat}`);
  if (plan.style) parts.push(`整体风格：${plan.style}`);
  parts.push('电影感，画面稳定，不要文字、不要水印');
  return parts.filter(Boolean).join('。');
}

/**
 * 生成单镜头的 ref2v 图。heroImage 是主角定妆图（ComfyUI input 里的文件名），
 * 所有镜头共用它，这是人物不跑的唯一可靠手段。
 */
export async function buildShotPrompt(plan, shot, options = {}) {
  const images = [];
  let promptText = composeShotPrompt(plan, shot);
  if (options.heroImage) {
    images.push(options.heroImage);
    promptText = `<Picture 1> 是全片主角（同一张脸、同一发型、同一套服装，不要变）。` + promptText;
  }
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

/* --------------------------- 拼接图 --------------------------- */

/**
 * 成品拼接：N 段视频按顺序接起来，音轨换成整首歌。
 * complete_audio 会覆盖每段自带的音频——镜头里模型自己生成的声音全部丢掉。
 */
export function buildStitchPrompt({ clips, audio, filenamePrefix = 'video/MV' }) {
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
  prompt['2002'] = {
    class_type: 'SaveVideo',
    inputs: { video: ['2001', 0], filename_prefix: filenamePrefix, format: 'mp4' },
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
