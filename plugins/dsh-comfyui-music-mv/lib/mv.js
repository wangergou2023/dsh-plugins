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

/**
 * 按段落变速的时间轴：副歌切短、主歌放长、桥段与尾奏更慢。
 * 全片等长是业余感的来源之一——MV 的节奏本来就该跟着歌走。
 * meta[i] = { section, move }，权重越高镜越长。
 */
export function allocateRhythmTimeline(duration, meta = []) {
  const total = Math.max(0.1, Number(duration) || 0);
  const n = Math.max(1, meta.length);
  if (!meta.length) return allocateTimeline(total, n);

  const weightOf = (m) => {
    const sec = String((m && m.section) || '').toLowerCase();
    if (/chorus|副歌/.test(sec) && !/pre/.test(sec)) return 0.62;
    if (/pre-?chorus|导歌/.test(sec)) return 0.8;
    if (/bridge|桥/.test(sec)) return 1.3;
    if (/intro|前奏/.test(sec)) return 1.4;
    if (/outro|尾奏/.test(sec)) return 1.3;
    if (/verse|主歌/.test(sec)) return 1;
    // 模型常把歌词句子填进 section——被反复引用的那句就是副歌钩子
    if (m && m.repeats >= 3) return 0.62;
    const mv = String((m && m.move) || '');
    if (/whip|crash|swish/.test(mv)) return 0.78;
    return 1;
  };

  const freq = new Map();
  for (const m of meta) {
    const key = String((m && m.section) || '').replace(/\s+/g, '').slice(0, 12);
    if (key) freq.set(key, (freq.get(key) || 0) + 1);
  }
  const metaWithCount = meta.map((m) => {
    const key = String((m && m.section) || '').replace(/\s+/g, '').slice(0, 12);
    return { ...m, repeats: key ? freq.get(key) || 1 : 1 };
  });
  const weights = metaWithCount.map((m, i) => weightOf(m) * (1 + 0.12 * Math.sin(i * 1.9)));
  const MIN = LIMITS.shotMinSeconds;
  const MAX = LIMITS.shotMaxSeconds;
  const lens = new Array(n).fill(0);
  let free = weights.map((_, i) => i);
  let remaining = total;
  let guard = 0;

  while (free.length && guard < 40) {
    guard += 1;
    const sum = free.reduce((a, i) => a + weights[i], 0) || 1;
    let clamped = false;
    for (const i of [...free]) {
      const want = (remaining * weights[i]) / sum;
      if (want < MIN) {
        lens[i] = MIN; remaining -= MIN; free = free.filter((j) => j !== i); clamped = true;
      } else if (want > MAX) {
        lens[i] = MAX; remaining -= MAX; free = free.filter((j) => j !== i); clamped = true;
      }
    }
    if (!clamped) {
      for (const i of free) lens[i] = (remaining * weights[i]) / sum;
      free = [];
    }
  }

  const sumLen = lens.reduce((a, b) => a + b, 0);
  if (!(sumLen > 0)) return allocateTimeline(total, n);
  const k = total / sumLen;
  let t = 0;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const len = lens[i] * k;
    const start = Math.round(t * 100) / 100;
    const end = i === n - 1 ? Math.round(total * 100) / 100 : Math.round((t + len) * 100) / 100;
    out.push({ index: i, start, end, seconds: Math.round((end - start) * 100) / 100 });
    t = end;
  }
  return out;
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
  const meta = rawShots.slice(0, count).map((s) => ({
    section: (s && (s.section || s.lyricSection)) || '',
    move: (s && (s.move || s.movement)) || '',
  }));
  const timeline = opts.rhythm === false ? allocateTimeline(duration, count) : allocateRhythmTimeline(duration, meta);
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
      // 表演层：影帝级 MV 靠这个，不靠"他很悲伤"这种形容词
      performance: text(src.performance || src.microAction || src.acting),
      objective: text(src.objective || src.want),
      prop: text(src.prop || src.object || src.item),
      // 定格：动作是一段时间，静帧只截一刻（变形镜必须写，否则模型只能猜）
      stillFrame: text(src.stillFrame || src.freeze || src.freezeAt || src.frameMoment),
      // 这一镜出的是人形还是原形（狗 / 骷髅）——决定用哪套外形喂图
      form: text(src.form || src.shape || src.state),
      dialogue: text(src.dialogue),
      cast: Array.isArray(src.cast)
        ? src.cast.map((x) => String(x || '').trim()).filter(Boolean)
        : [],
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
    // 兼容两种写法：新的 characters 数组，旧的单 character 字符串
    character: String((data && data.character) || '').trim(),
    characters: Array.isArray(data && data.characters)
      ? data.characters
        .map((c) => ({
          name: String((c && (c.name || c.role)) || '').trim(),
          look: String((c && (c.look || c.description || c.appearance)) || '').trim(),
          // 原形外形（狗 / 骷髅）：只在这一镜是原形时才喂进画面提示词
          beast: String((c && (c.beast || c.original || c.creature)) || '').trim(),
        }))
        .filter((c) => c.name || c.look)
      : [],
    // 视觉基调：只喂画面（胶片感、调色、镜头），和曲风分开
    look: String((data && (data.look || data.visualStyle)) || '').trim(),
    negative: String((data && data.negative) || '').trim(),
    // 物件母题：一支 MV 靠 3–5 个重复出现的道具咬合，而不是靠"情绪"
    props: Array.isArray(data && data.props)
      ? data.props
        .map((p) => ({
          name: String((p && (p.name || p.prop || p.object)) || '').trim(),
          meaning: String((p && (p.meaning || p.shift || p.arc)) || '').trim(),
        }))
        .filter((p) => p.name)
      : [],
    // 场次体剧本：面板和 markdown 都按这个渲染，不再是"一句话故事"
    scenes: Array.isArray(data && data.scenes)
      ? data.scenes
        .map((s, i) => {
          const pickText = (v) => String(v || '').replace(/[ \t]+/g, ' ').trim();
          return {
            no: pickText(s && (s.no || s.number || s.index)) || String(i + 1),
            heading: pickText(s && (s.heading || s.slug || s.title || s.location)),
            action: pickText(s && (s.action || s.description || s.body)),
            performance: pickText(s && (s.performance || s.beats || s.acting)),
            sound: pickText(s && (s.sound || s.audio || s.sfx)),
            lyric: pickText(s && (s.lyric || s.line || s.dialogue)),
          };
        })
        .filter((s) => s.heading || s.action || s.performance || s.lyric)
      : [],
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

/* --------------------------- 角色 --------------------------- */

/**
 * 一个角色的外形里往往同时写了人形和原形（「中华细犬…幻化人形时为20岁少年…」）。
 * 这里按「幻化人形时」这类词切开，出图时只喂其中一套，免得把狗画成少年。
 */
export function splitLook(look) {
  const raw = String(look || '').trim();
  if (!raw) return { beast: '', human: '' };
  const m = raw.match(/幻化人形时|化为人形时|化作人形时|人形时|人形形态|变作人形时/);
  if (!m || m.index === undefined) return { beast: '', human: raw };
  const beast = raw.slice(0, m.index).replace(/[，,、；;\s]+$/, '').replace(/^(原形[:：]?)/, '').trim();
  const human = raw.slice(m.index + m[0].length).replace(/^[为是:：]/, '').trim();
  return { beast, human: human || raw };
}

/** 全片角色表：新的 characters 数组优先，旧的单 character 字段兜底。 */
export function charactersOf(plan) {
  const list = Array.isArray(plan && plan.characters) ? plan.characters : [];
  const clean = list
    .map((c) => ({
      name: String((c && c.name) || '').trim(),
      look: String((c && (c.look || c.description)) || '').trim(),
      beast: String((c && (c.beast || c.original)) || '').trim(),
    }))
    .filter((c) => c.name || c.look);
  if (clean.length) return clean;
  if (plan && plan.character) return [{ name: '主角', look: String(plan.character).trim() }];
  return [];
}

/** 这一镜出场的人：shot.cast 里点了名就取交集，没点就全上。 */
export function castOf(plan, shot) {
  const all = charactersOf(plan);
  const names = Array.isArray(shot && shot.cast) ? shot.cast.map((n) => String(n || '').trim()).filter(Boolean) : [];
  if (!names.length) return all;
  const picked = all.filter((c) => names.includes(c.name));
  return picked.length ? picked : all;
}

/* --------------------------- 提示词组装 --------------------------- */

/**
 * 静帧（图片）提示词：这一镜的"定妆照"。
 * 结构化字段在这里咬合：人物 + 场景 + 时间 + 动作 + 景别/角度/运镜/灯光/景深 + 全片风格。
 */
/**
 * 把歌词切成 N 段，喂给分段生成的歌。
 * 优先按 [Verse]/[Chorus] 段落块切，块数不够再按行切——保证每段都有词。
 */
export function segmentLyrics(lyrics, index, total) {
  const text = String(lyrics || '').trim();
  if (!text || total <= 1) return text;
  const blocks = text.split(/\n(?=\[)/).map((s) => s.trim()).filter(Boolean);
  if (blocks.length >= total) {
    const per = Math.ceil(blocks.length / total);
    return blocks.slice(index * per, (index + 1) * per).join('\n\n').trim();
  }
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  const per = Math.ceil(lines.length / total);
  return lines.slice(index * per, (index + 1) * per).join('\n').trim();
}

/** 这一镜的视线落点：静帧最容易拍成"站好、看镜头"，所以每条都要有落点。 */
export function eyelineFor(shot, castCount = 0) {
  if (shot && shot.eyeline) return shot.eyeline;
  const actingText = `${(shot && shot.action) || ''} ${(shot && shot.performance) || ''} ${(shot && shot.objective) || ''}`;
  if (castCount > 1) return '看向对方（脸或手）';
  if (/找|看|望|寻|凝视|盯着|抬头|低头/.test(actingText)) return '看向画外一个具体方向';
  return '看着手里的东西';
}

export function composeFramePrompt(plan, shot) {
  const parts = [];
  const cast = castOf(plan, shot);
  // 原形 / 人形决定喂哪套外形：不然"狗叼骨头"会被画成"男人抱女人"
  const probe = `${shot.form || ''} ${shot.action || ''} ${shot.label || ''}`;
  const animalShot = /小狗|黑狗|白狗|狗形|犬|四爪|前爪|尾巴|摇尾/.test(probe);
  const boneShot = /骨架|骨爪|骨颅|白骨原形|骨节|骨指|变回骨/.test(probe);
  const humanShot = /人形|少女|少年|男人|女人|男子|女子|少年|她|他/.test(probe);
  const beastShot = (animalShot || boneShot) && !humanShot;
  const mixedShot = (animalShot || boneShot) && humanShot;
  if (cast.length) {
    parts.push(cast.map((c) => {
      const forms = splitLook(c.look);
      const own = String(c.beast || '').trim();
      let look;
      if (mixedShot) {
        // 同一镜里人和原形都在（例如"少女摇铃，狗坐在脚边"）——两套外形都给
        const b = own || forms.beast;
        look = b ? `人形：${forms.human}／原形：${b}` : c.look;
      } else if (beastShot) {
        look = own || forms.beast || c.look;
      } else {
        look = forms.human || c.look;
      }
      return look ? `${c.name}（${look}）` : c.name;
    }).join('；'));
  } else if (plan.character) {
    parts.push(plan.character.replace(/\s+/g, ' ').trim());
  }
  if (shot.scene) parts.push(shot.scene);
  if (shot.time) parts.push(shot.time);
  if (shot.action) parts.push(shot.action);
  // 定格：动作是「一段时间」，静帧只能截「一刻」。变形这类过程镜必须另外指定截在哪一刻，
  // 否则模型只能猜，猜出来就是「已经变完」或者「完全没变」。
  if (shot.stillFrame) parts.push(`这一格定格在：${shot.stillFrame}`);
  // 物件点名：动作里没写到它时补一句，保证它真的进画面（写到了就不重复）
  if (shot.prop && !String(shot.action || '').includes(shot.prop)) parts.push(`画面里出现${shot.prop}`);
  parts.push(cameraFragment(shot));
  if (shot.beat) parts.push(`情绪：${shot.beat}`);
  // 表演指向：静帧最容易拍成"站好、看镜头"。给视线落点，并要求动作发生在半途。
  const eyeline = cast.length > 1
    ? '视线落在另一个角色身上（脸或手），不看镜头'
    : (/找|看|望|寻|凝视|盯着|抬头|低头/.test(`${shot.action || ''} ${shot.performance || ''} ${shot.objective || ''}`)
      ? '视线看向画外的一个具体方向，不看镜头'
      : '视线落在手里的东西上，不看镜头');
  parts.push(eyeline);
  parts.push('捕捉动作正在进行到一半的瞬间（不是摆拍），表情具体、有微小的肌肉动作');
  // 服装护栏：Krea2 很容易把人形画成赤膊（定妆里写了"穿…"照样脱），
  // 把衣服单独拎出来在镜头描述之后再说一遍，命中最稳。
  if (cast.length && !beastShot) {
    const wardrobe = cast.map((c) => {
      const human = splitLook(c.look).human || '';
      const garment = (human.match(/穿([^，。；]+)/) || [])[1];
      return garment ? `${c.name}：${garment}` : '';
    }).filter(Boolean).join('；');
    if (wardrobe) parts.push(`角色全程穿着（服装完整，不要赤膊、不要裸上身）：${wardrobe}`);
  }
  // 只喂视觉基调；曲风是给 YuE2 的，塞进画面提示词只会把画面带偏
  if (plan.look) parts.push(plan.look);
  parts.push('电影剧照，人物与场景细节清晰，不要文字、不要水印');
  // 去重标点：每一段自己带句号时不要拼成「。。」
  return parts
    .filter(Boolean)
    .map((p) => String(p).trim().replace(/[。，、；;,.]+$/, ''))
    .filter(Boolean)
    .join('。');
}

/** 生成这一镜的静帧图（Krea2）。 */export async function buildFramePrompt(plan, shot, options = {}) {
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
  for (const item of opts.identity || []) {
    pics.push(`<Picture ${item.picture}> 是${item.name}的身份参考，长相、发型、服装不能变`);
  }
  if (opts.audioRef) {
    const line = shot.dialogue ? `，唱的歌词是「${shot.dialogue}」` : '';
    pics.push(`<Audio 1> 是本镜要唱的那一段歌声，人物严格按 <Audio 1> 的音色与节奏开口对口型${line}`);
  }
  const head = pics.length ? pics.join('；') + '。' : '';
  const move = (MOVES.find((m) => m.key === shot.move) || MOVES[0]).en;
  const light = (LIGHTS.find((l) => l.key === shot.light) || LIGHTS[0]).en;
  const body = [
    shot.action ? `${shot.action.replace(/[。.]\s*$/, '')}。` : '',
    `镜头：${move}。`,
    `光线：${light}。`,
    '人物表演自然连贯，画面稳定，不要文字、不要水印、不要字幕。',
  ].filter(Boolean).join('');
  return head + body;
}

/** 生成这一镜的 ref2v 图：首帧=静帧，随后是每个出场角色的定妆图。 */
export async function buildShotVideoPrompt(plan, shot, options = {}) {
  const images = [];
  if (options.frameImage) images.push(options.frameImage);

  // 兼容旧的单图入参
  const heroes = Array.isArray(options.heroes) ? options.heroes.slice() : [];
  if (heroes.length === 0 && options.heroImage) heroes.push({ label: '主角', comfy: options.heroImage });

  const identity = [];
  for (const hero of heroes) {
    const comfy = hero && hero.comfy;
    if (!comfy) continue;
    images.push(comfy);
    identity.push({ name: hero.label || '主角', picture: images.length });
  }

  const promptText = composeVideoPrompt(plan, shot, {
    frameImage: options.frameImage,
    identity,
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


/* --------------------------- 剧本体检 --------------------------- */

/**
 * 把「这支 MV 好不好」变成可数的检查项。
 * 全部是结构指标，不需要看画面：用户可以只凭这些判断剧本该不该开拍。
 */
/**
 * 沉默那一镜如果太短（< minSeconds），从相邻镜头借时间把它撑到 8 秒。
 * 宁可少唱一句，也要留一镜让表演自己说完——这是硬指标，靠"抽台词"糊弄不过去。
 */
export function extendSilentBeat(plan, minSeconds = 8) {
  const shots = (Array.isArray(plan && plan.shots) ? plan.shots : []).map((s) => ({ ...s }));
  if (shots.length < 2) return plan;
  const MIN = LIMITS.shotMinSeconds;
  let changed = false;

  shots.forEach((s, i) => {
    if (String(s.dialogue || '').trim()) return;
    let need = Math.round((minSeconds - (s.end - s.start)) * 100) / 100;
    if (need <= 0.01) return;
    const order = i + 1 < shots.length ? [i + 1, i - 1] : [i - 1];
    for (const j of order) {
      if (need <= 0.01) break;
      if (j < 0 || j >= shots.length) continue;
      const nb = shots[j];
      const spare = Math.round(((nb.end - nb.start) - MIN) * 100) / 100;
      if (spare <= 0.01) continue;
      const take = Math.min(spare, need);
      if (j > i) {
        nb.start = Math.round((nb.start + take) * 100) / 100;
        s.end = Math.round((s.end + take) * 100) / 100;
      } else {
        nb.end = Math.round((nb.end - take) * 100) / 100;
        s.start = Math.round((s.start - take) * 100) / 100;
      }
      need = Math.round((need - take) * 100) / 100;
      changed = true;
    }
  });

  if (!changed) return plan;
  const fixed = shots.map((s) => ({ ...s, seconds: Math.round((s.end - s.start) * 100) / 100 }));
  return { ...plan, shots: fixed };
}

export function lintPlan(plan) {
  const shots = Array.isArray(plan && plan.shots) ? plan.shots : [];
  const props = Array.isArray(plan && plan.props) ? plan.props : [];
  const checks = [];
  const push = (id, label, ok, detail) => checks.push({ id, label, ok: !!ok, detail: String(detail || '') });

  // 1. 每镜齐活：表演 / 目标 / 唱词
  const missingPerf = shots.filter((s) => !s.performance).length;
  const missingWant = shots.filter((s) => !s.objective).length;
  push('complete', '每镜都有表演和目的', missingPerf === 0 && missingWant === 0,
    missingPerf || missingWant ? `${missingPerf} 镜缺表演，${missingWant} 镜缺目的` : `${shots.length} 镜齐全`);

  // 2. 表演不重复：任意两镜不能共用同一个开头
  const heads = shots.map((s) => String(s.performance || '').replace(/[，,。；;、\s]/g, '').slice(0, 8));
  const dup = heads.filter((h, i) => h.length >= 4 && heads.indexOf(h) !== i);
  push('perf-dup', '表演不重复', dup.length === 0,
    dup.length ? `${dup.length} 镜的表演开头重复（${dup.slice(0, 3).join('、')}）` : '每镜微动作都不同');

  // 3. 景别不三连
  const sizes = shots.map((s) => s.size || '');
  let sizeRun = 0; let worstSize = 0;
  for (let i = 0; i < sizes.length; i += 1) {
    sizeRun = i && sizes[i] === sizes[i - 1] ? sizeRun + 1 : 1;
    worstSize = Math.max(worstSize, sizeRun);
  }
  push('size-run', '景别有节奏（不三连）', worstSize < 3, `最长连续同景别 ${worstSize} 镜`);

  // 4. 运镜不三连
  const moves = shots.map((s) => s.move || '');
  let moveRun = 0; let worstMove = 0;
  for (let i = 0; i < moves.length; i += 1) {
    moveRun = i && moves[i] === moves[i - 1] ? moveRun + 1 : 1;
    worstMove = Math.max(worstMove, moveRun);
  }
  push('move-run', '运镜不三连', worstMove < 3, `最长连续同运镜 ${worstMove} 镜`);

  // 5. 物件母题：至少 3 个，每个被 ≥2 镜引用
  const text = shots.map((s) => `${s.action || ''} ${s.prop || ''}`).join(' ');
  const used = props.map((p) => ({ name: p.name, hits: shots.filter((s) => `${s.prop || ''} ${s.action || ''}`.includes(p.name)).length }));
  const weak = used.filter((u) => u.hits < 2);
  push('props', '物件母题重复咬合', props.length >= 3 && weak.length === 0 && text.length > 0,
    props.length < 3 ? `只有 ${props.length} 个物件，至少要 3 个` : (weak.length ? `${weak.map((u) => u.name).join('、')} 只出现一次` : `${used.map((u) => `${u.name}×${u.hits}`).join('　')}`));

  // 6. 首尾回扣：最后一镜要用到第一个物件
  const firstProp = props.length ? props[0].name : '';
  const lastShot = shots[shots.length - 1] || {};
  const bookend = firstProp && `${lastShot.prop || ''} ${lastShot.action || ''}`.includes(firstProp);
  push('bookend', '最后一镜回扣开场物件', bookend, bookend ? `末镜回到「${firstProp}」` : `末镜没有回到「${firstProp || '（无物件）'}」`);

  // 7. 歌词不复述画面
  const overlap = shots.filter((s) => {
    const lyric = String(s.dialogue || '').replace(/[，,。；;、\s]/g, '');
    const act = String(s.action || '').replace(/[，,。；;、\s]/g, '');
    if (!lyric || !act) return false;
    let hit = 0;
    for (let i = 0; i < lyric.length - 1; i += 1) if (act.includes(lyric.slice(i, i + 2))) hit += 1;
    return hit / Math.max(1, lyric.length - 1) > 0.6;
  });
  push('lyric-offset', '歌词与画面错位', overlap.length === 0,
    overlap.length ? `${overlap.length} 镜的唱词在复述画面` : '歌词在说别的事');

  // 8. 动作长度可执行（12–90 字）
  const badLen = shots.filter((s) => {
    const n = String(s.action || '').trim().length;
    return n < 12 || n > 90;
  });
  push('action-len', '动作长度可执行', badLen.length === 0,
    badLen.length ? `${badLen.length} 镜的动作过短或过长` : '12–90 字之间');

  // 9. 空镜数量受控
  const empty = shots.filter((s) => !(Array.isArray(s.cast) && s.cast.length)).length;
  push('empty-shot', '空镜不超过 2 个', empty <= 2, `${empty} 个空镜`);

  // 10. 时间轴连续
  let gap = 0;
  for (let i = 1; i < shots.length; i += 1) if (Math.abs(shots[i].start - shots[i - 1].end) > 0.01) gap += 1;
  push('timeline', '时间轴连续', gap === 0, gap ? `${gap} 处断裂` : `${shots.length} 镜无空洞`);

  // 11. 全片至少留一镜不说话：让表演自己说完
  const silent = shots.filter((s) => !String(s.dialogue || '').trim() && (s.end - s.start) >= 8);
  push('silence', '有一镜不说话', silent.length >= 1,
    silent.length ? `第 ${silent.map((s) => s.index + 1).join('、')} 镜不说话，只有动作` : '每一镜都在唱，没有留给表演的空白');

  // 12. 剪辑节奏：镜头要有长有短，全片等长是业余感
  const lens = shots.map((s) => Math.round((s.end - s.start) * 100) / 100).filter((v) => v > 0);
  const longest = lens.length ? Math.max(...lens) : 0;
  const shortest = lens.length ? Math.min(...lens) : 0;
  const ratio = shortest ? longest / shortest : 1;
  const distinct = new Set(lens.map((v) => v.toFixed(1))).size;
  push('rhythm', '镜头有长有短（跟歌走）', ratio >= 1.5 && distinct >= 3,
    `${shortest.toFixed(1)}–${longest.toFixed(1)} 秒，长短比 ${ratio.toFixed(1)}，${distinct} 种长度`);

  const passed = checks.filter((c) => c.ok).length;
  const total = checks.length || 1;
  return {
    score: Math.round((passed / total) * 100),
    passed,
    total,
    checks,
  };
}
