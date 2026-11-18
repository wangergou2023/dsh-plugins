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
  fixSizeRuns, fixMoveRuns, diversifyChannels,
  linkWarmProp,
  assignPropSlots, forceSignShot, ensureOtsPair, dedupePerformance, dedupeLabels,
  planLocations, scenePlatePrompt, planProps, propPrompt, assetState,
} from './lib/mv.js';
import { vocab, cameraSummary } from './lib/shotlang.js';
import { probeFfmpeg, stitchWithTransitions, concatAudio, composeTransHero } from './lib/ffmpeg.js';
import { loadRefEditTemplate, buildRefEditGraph, refsForShot, refInstruction, shotForm } from './lib/refedit.js';
import { cinematicPass } from './lib/grade.js';
import { buildBookHtml } from './lib/book.js';
import { buildBoard } from './lib/board.js';
import { text, llmText, friendlyError } from './lib/llm.js';
import { planSystemPrompt, planScriptPrompt, shotsPrompt, shotBatches, scenesForBatch } from './lib/prompts.js';
import { repairBookend, relieveSilence, reviewPlan, comparePlans, comparePlansFair, rewriteShots, addWarmBeat, focusSignShot } from './lib/repairs.js';
import { JobStore } from './lib/jobs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = HERE;
const DATA_DIR = process.env.DSH_MUSIC_MV_DATA || path.join(HERE, '.data');
const DEFAULT_HOST = 'http://127.0.0.1:8188';

const ASPECTS = ['16:9 (Widescreen)', '9:16 (Portrait)', '1:1 (Square)', '4:3 (Standard)', '3:4 (Portrait)', '21:9 (Cinematic)'];

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv']);
const AUDIO_EXT = new Set(['.flac', '.mp3', '.wav', '.ogg', '.opus', '.m4a']);

/* ---------------------------- 工具函数 ---------------------------- */

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
      plan = assignPropSlots(plan);
      plan = await repairBookend(ctx, plan);
      plan = await focusSignShot(ctx, plan);
  plan = forceSignShot(plan);
  plan = ensureOtsPair(plan);
      plan = enforceReversePair(plan);
      plan = trimLongActions(plan);
      plan = mergeScenes(plan);
      plan = cleanLogline(plan);
      plan = dedupePerformance(plan);
      plan = dedupeLabels(plan);
      plan = linkWarmProp(plan);
      plan = fixSizeRuns(plan);
      plan = fixMoveRuns(plan);
      plan = diversifyChannels(plan);
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
    plan = assignPropSlots(plan);
  plan = await repairBookend(ctx, plan);
    plan = await focusSignShot(ctx, plan);
    plan = forceSignShot(plan);
    plan = ensureOtsPair(plan);
    plan = enforceReversePair(plan);
    plan = trimLongActions(plan);
    plan = mergeScenes(plan);
    plan = cleanLogline(plan);
    plan = dedupePerformance(plan);
    plan = dedupeLabels(plan);
  plan = linkWarmProp(plan);
  plan = fixSizeRuns(plan);
  plan = fixMoveRuns(plan);
  plan = diversifyChannels(plan);
  return { plan, model, raw: rawHead, lint: lintPlan(plan) };
}

/* ---------------------------- 分镜体检（人眼标准） ---------------------------- */

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
        guard: '角色定妆照，只有这一个非人形态：动物或骨架本体，完整身形，四足着地或直立骨架，画面里只有它一个',
      },
      {
        form: 'human',
        // 否定句会被 ComfyUI 里的扩写模型反过来"看见"（写"没有骨架"它就画一具骨架），
        // 所以这里只写正面陈述：整个人由皮肤覆盖、穿日常衣服。
        text: character.look || beastText,
        guard: '角色定妆照，只有这一个人形：正常人类的头部、头发与皮肤，整个人由皮肤覆盖，穿着日常衣物，画面里只有他一个',
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
    // 两处确定性护栏（都是踩过的坑）：
    // 1) look 里只写了上装（"灰色连帽衫"）时，定妆图会给出光腿的人，后面每格都跟着光腿；
    // 2) 把整句 look 喂进去，模型会把"二十出头"这类描述写到胸牌上。
    const needPants = spec.form === 'human' && !/裤|裙|短裤|长裤|下装/.test(String(spec.text || ''));
    const heroPrompt = [
      spec.text || character.name || '一位年轻人',
      needPants ? '下半身穿着深色长裤，与上身是同一套日常衣服' : '',
      spec.guard,
      '牌子、标签、门牌上的字迹都保持模糊，画面里没有可读文字',
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

/**
 * 地点定妆图：一场（严格说是一个地点）出一张空镜。
 * 为什么要它：静帧只喂角色参考图，背景全靠文字，同一间修表店会画成十二间店。
 */
async function renderPlate(client, job, plan, location, index, params) {
  const prompt = scenePlatePrompt(plan, location);
  const built = await buildT2iPrompt({
    prompt,
    aspectRatio: params.aspectRatio || '16:9 (Widescreen)',
    megapixels: params.plateMegapixels || 1.2,
    steps: params.heroSteps || 8,
    filenamePrefix: `mv_plate/${job.id}_${index + 1}`,
  });
  applyModelOverrides(built.prompt, params.models);
  const promptId = await client.submit(built.prompt);
  const result = await client.wait(promptId, 1800000);
  const item = firstOutputImage(result, '29');
  if (!item) throw new Error(`地点「${location.key}」的定妆图没有产出`);
  const buffer = await fetchComfyImage(client, item);
  const dir = path.join(DATA_DIR, job.id, 'plates');
  await fs.mkdir(dir, { recursive: true });
  const stamp = Date.now().toString(36);
  const file = path.join(dir, `plate_${index + 1}_${stamp}.png`);
  await fs.writeFile(file, buffer);
  const comfy = await client.upload(buffer, `mv_plate_${job.id}_${index + 1}_${stamp}.png`, 'image/png');
  return {
    key: location.key,
    heading: location.heading,
    sceneNos: location.sceneNos,
    shots: location.shots.map((s) => s.index + 1),
    file,
    comfy,
  };
}

async function renderProp(client, job, plan, prop, index, params) {
  const prompt = propPrompt(plan, prop);
  const built = await buildT2iPrompt({
    prompt,
    aspectRatio: '1:1 (Square)',
    megapixels: params.propMegapixels || 1.0,
    steps: params.heroSteps || 8,
    filenamePrefix: `mv_prop/${job.id}_${index + 1}`,
  });
  applyModelOverrides(built.prompt, params.models);
  const promptId = await client.submit(built.prompt);
  const result = await client.wait(promptId, 1800000);
  const item = firstOutputImage(result, '29');
  if (!item) throw new Error(`道具「${prop.name}」的资产图没有产出`);
  const buffer = await fetchComfyImage(client, item);
  const dir = path.join(DATA_DIR, job.id, 'props');
  await fs.mkdir(dir, { recursive: true });
  const stamp = Date.now().toString(36);
  const file = path.join(dir, `prop_${index + 1}_${stamp}.png`);
  await fs.writeFile(file, buffer);
  const comfy = await client.upload(buffer, `mv_prop_${job.id}_${index + 1}_${stamp}.png`, 'image/png');
  return {
    name: prop.name,
    meaning: prop.meaning,
    shots: (plan.shots || []).filter((s) => String(s.prop || '') === prop.name).map((s) => s.index + 1),
    file,
    comfy,
  };
}

async function renderFrame(client, job, plan, shot, params) {
  // 有定妆图就走"认人"链路：Qwen 参考编辑，角色长相全片锁死
  const sceneText = composeFramePrompt(plan, shot);
  // 过肩镜只给主角一张参考图。两张开给，模型会把两个人并排画出来（实测过），
  // 过肩就变成了两人合影——而这一镜的表演关键恰恰是"对方不在画面里"。
  const otsFocus = String(shot.composition || '') === 'ots' && (shot.cast || []).length >= 2
    ? { ...shot, cast: shot.cast.slice(0, 1) }
    : shot;
  const pick = params.frameMode === 't2i' ? { refs: [], labels: [] } : refsForShot(job, otsFocus, 4);
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

  /* 4b. 地点定妆图：每个地点一张空镜，之后这一场的每一镜都拿它当空间参考 */
  if (params.scenePlates !== false) {
    const locations = planLocations(plan);
    const canResume = Array.isArray(job.plates) && job.plates.length && params.resume !== false;
    if (canResume && job.plates.length >= locations.length) {
      // 续跑：已有的直接用
    } else if (locations.length) {
      await jobPatch(job.id, { stage: 'plates', stageLabel: `生成地点定妆图（0/${locations.length}）` });
      const plates = canResume ? [...job.plates] : [];
      for (let i = 0; i < locations.length; i += 1) {
        const loc = locations[i];
        const done = plates.find((p) => p && p.key === loc.key && p.comfy);
        if (done) continue;
        await jobPatch(job.id, { stageLabel: `生成地点定妆图（${i + 1}/${locations.length}·${loc.key}）` });
        try {
          const plate = await renderPlate(client, job, plan, loc, i, params);
          plates[i] = plate;
          await jobPatch(job.id, { plates: plates.filter(Boolean) });
        } catch (error) {
          // 地点定妆失败不该毁掉整个任务：静帧照旧按文字生成
          await jobPatch(job.id, { plates: plates.filter(Boolean), plateWarning: String(error && error.message || error) });
        }
      }
      await jobPatch(job.id, { plates: plates.filter(Boolean) });
    }
  }

  /* 4c. 道具资产卡：全片用到的每件东西一张，形制全片锁死 */
  if (params.propAssets !== false) {
    const props = planProps(plan);
    const canResumeProp = Array.isArray(job.props) && job.props.length && params.resume !== false;
    if (canResumeProp && job.props.length >= props.length) {
      // 续跑：已有资产直接用
    } else if (props.length) {
      await jobPatch(job.id, { stage: 'props', stageLabel: `生成道具资产（0/${props.length}）` });
      const assets = canResumeProp ? [...job.props] : [];
      for (let i = 0; i < props.length; i += 1) {
        const prop = props[i];
        const done = assets.find((p) => p && p.name === prop.name && p.comfy);
        if (done) continue;
        await jobPatch(job.id, { stageLabel: `生成道具资产（${i + 1}/${props.length}·${prop.name}）` });
        try {
          const asset = await renderProp(client, job, plan, prop, i, params);
          assets[i] = asset;
          await jobPatch(job.id, { props: assets.filter(Boolean) });
        } catch (error) {
          // 道具资产失败也不该毁任务：静帧照旧按文字生成
          await jobPatch(job.id, { props: assets.filter(Boolean), propWarning: String(error && error.message || error) });
        }
      }
      await jobPatch(job.id, { props: assets.filter(Boolean) });
    }
  }

  /* 4d. 资产确认关：资产齐了就停下来，等人点"资产收下"再出静帧。
     素材形态写进 job.assetState：M2 已入库 / M1 有占位 / M0 纯提示词。 */
  const phase0 = String(params.phase || 'all');
  const assetsState = assetState(plan, job);
  await jobPatch(job.id, {
    assetState: assetsState.mode,
    assetGaps: assetsState.gaps,
  });
  if (phase0 === 'assets' || params.assetsOnly === true) {
    const label = assetsState.mode === 'M2'
      ? '资产就绪（已入库），等你审'
      : (assetsState.mode === 'M1' ? '资产不齐（有占位），等你审' : '资产为空（纯提示词），等你审');
    await jobPatch(job.id, { status: 'paused', stage: 'assets', stageLabel: label });
    return jobStore.get(job.id) || job;
  }

  /* 5. 静帧：每镜一张，先给人看，不满意可以单张重 roll */
  const phase = phase0;
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
    name: 'mv_board',
    description: '把任务的分镜静帧拼成一张 PNG 分镜板（每格带镜号/时长/景别/物件/标题），ffmpeg 拼图，约 1 秒。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '任务 id（不填就用最近一个）' },
        outFile: { type: 'string', description: '输出 png 路径；不填写到插件 .data/<任务id>/分镜板.png' },
        cols: { type: 'number', description: '列数，默认 3' },
        width: { type: 'number', description: '每格宽度像素，默认 620' },
      },
    },
    output: OUTPUT,
    timeoutMs: 300000,
    async execute(args) {
      await jobStore.refresh();
      const job = args.id ? jobStore.get(String(args.id)) : jobStore.list()[0];
      if (!job) throw new Error('没有这个任务');
      const shots = (job.shots || []).filter((s) => s.frameFile);
      if (!shots.length) throw new Error('这个任务还没有静帧');
      const outFile = args.outFile
        ? path.resolve(String(args.outFile))
        : path.join(DATA_DIR, job.id, '分镜板.png');
      await fs.mkdir(path.dirname(outFile), { recursive: true });
      const t0 = Date.now();
      await buildBoard({
        pluginDir: PLUGIN_DIR,
        files: shots.map((s) => s.frameFile),
        shots,
        outFile,
        cols: Number(args.cols) || 3,
        width: Number(args.width) || 620,
      });
      return text([
        `分镜板：${outFile}`,
        `${shots.length} 格 · ${Date.now() - t0} ms`,
      ]);
    },
  });

  ctx.tools.register({
    name: 'mv_compare',
    description: '两版分镜换位对打：同一对版本跑两遍（A/B 各占一次前位），只有两个次序下都赢的镜才算赢，避免位置偏差。',
    parameters: {
      type: 'object',
      properties: {
        a: { type: 'string', description: 'A 版：任务 id 或 plan JSON 文件路径' },
        b: { type: 'string', description: 'B 版：任务 id 或 plan JSON 文件路径' },
        outFile: { type: 'string', description: '把逐镜结论写成 json（可选）' },
      },
      required: ['a', 'b'],
    },
    output: OUTPUT,
    timeoutMs: 600000,
    async execute(args) {
      await jobStore.refresh();
      const load = async (ref) => {
        const key = String(ref || '').trim();
        if (!key) throw new Error('缺少版本参数');
        const job = jobStore.get(key);
        if (job && job.plan) return job.plan;
        const buf = await fs.readFile(path.resolve(key), 'utf8');
        const data = JSON.parse(buf);
        return data.plan || data;
      };
      const planA = await load(args.a);
      const planB = await load(args.b);
      const result = await comparePlansFair(ctx, planA, planB);
      if (args.outFile) {
        await fs.mkdir(path.dirname(path.resolve(String(args.outFile))), { recursive: true });
        await fs.writeFile(path.resolve(String(args.outFile)), JSON.stringify(result, null, 2), 'utf8');
      }
      const lines = result.shots.map((s) => `${String(s.i).padStart(2, '0')}  ${s.verdict === 'tie' ? '平' : s.verdict}  (A ${s.a} : B ${s.b})  ${String(s.why || '').slice(0, 28)}`);
      return text([
        `换位对打：A 胜 ${result.wins.A} · B 胜 ${result.wins.B} · 平 ${result.wins.tie}`,
        result.note,
        ...lines,
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

    /**
     * 后台写剧本：POST 立刻返回 taskId，服务端把生成跑完。
     * 面板切走/关掉都不影响——回来用 GET /plan-task?id=... 取结果。
     */
    const planTasks = new Map();
    const PLAN_TASK_TTL = 30 * 60 * 1000;

    function newPlanTaskId() {
      return 'pt_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
    }

    function prunePlanTasks() {
      const now = Date.now();
      for (const [id, task] of planTasks) {
        if (now - task.startedAt > PLAN_TASK_TTL) planTasks.delete(id);
      }
    }

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/plan-async',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        let body = null;
        try { body = await readJsonBody(request); } catch { body = null; }
        if (!body || !String(body.theme || '').trim()) {
          sendJson(response, 400, { error: 'theme_required', message: '先写一个主题' });
          return;
        }
        prunePlanTasks();
        const id = newPlanTaskId();
        planTasks.set(id, { status: 'running', startedAt: Date.now(), theme: String(body.theme || '').slice(0, 60) });
        // 故意不 await：请求立刻返回，生成长任务在服务端继续跑。
        (async () => {
          try {
            const out = await generatePlan(ctx, body);
            planTasks.set(id, { status: 'done', startedAt: planTasks.get(id).startedAt, finishedAt: Date.now(), plan: out.plan, model: out.model, lint: out.lint, theme: String(body.theme || '').slice(0, 60) });
          } catch (error) {
            planTasks.set(id, { status: 'failed', startedAt: planTasks.get(id).startedAt, finishedAt: Date.now(), error: friendlyError(error), theme: String(body.theme || '').slice(0, 60) });
          }
        })();
        sendJson(response, 200, { taskId: id, running: planTasks.size });
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/plan-task',
      handler: async (request, response) => {
        const url = new URL(request.url || '/', 'http://localhost');
        const id = String(url.searchParams.get('id') || '');
        const task = planTasks.get(id);
        if (!task) { sendJson(response, 404, { error: 'not_found', id }); return; }
        const elapsed = Date.now() - task.startedAt;
        if (task.status === 'done') {
          sendJson(response, 200, { status: 'done', elapsedMs: elapsed, plan: task.plan, model: task.model, lint: task.lint });
          return;
        }
        if (task.status === 'failed') {
          sendJson(response, 200, { status: 'failed', elapsedMs: elapsed, error: task.error });
          return;
        }
        sendJson(response, 200, { status: 'running', elapsedMs: elapsed });
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

    /** 分镜板 PNG：把已出好的静帧拼成一张图，直接回二进制，面板可以下载。 */
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/board',
      handler: async (request, response) => {
        if (request.method !== 'GET') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        const url = new URL(request.url || '/', 'http://localhost');
        const id = String(url.searchParams.get('id') || '');
        await jobStore.refresh();
        const job = id ? jobStore.get(id) : jobStore.list()[0];
        if (!job) { response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ error: 'not_found', id })); return; }
        const shots = (job.shots || []).filter((s) => s.frameFile);
        if (!shots.length) { response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' }); response.end(JSON.stringify({ error: 'no_frames' })); return; }
        try {
          const outFile = path.join(DATA_DIR, job.id, '分镜板.png');
          await fs.mkdir(path.dirname(outFile), { recursive: true });
          await buildBoard({
            pluginDir: PLUGIN_DIR,
            files: shots.map((s) => s.frameFile),
            shots,
            outFile,
            cols: Number(url.searchParams.get('cols')) || 3,
            width: Number(url.searchParams.get('width')) || 620,
          });
          const buffer = await fs.readFile(outFile);
          const headers = { 'content-type': 'image/png', 'content-length': buffer.length };
          if (url.searchParams.get('download')) {
            const name = encodeURIComponent(`《${(job.plan && job.plan.title) || job.id}》分镜板.png`);
            headers['content-disposition'] = `attachment; filename="mv-board.png"; filename*=UTF-8''${name}`;
          }
          response.writeHead(200, headers);
          response.end(buffer);
        } catch (error) {
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ error: 'board_failed', message: friendlyError(error) }));
        }
      },
    }));

    /** 重出地点定妆图：每个地点一张空镜，不动已经出好的静帧与视频。 */
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/plates',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        let body = null;
        try { body = await readJsonBody(request); } catch { body = null; }
        const id = String((body && body.id) || '');
        await jobStore.refresh();
        const job = jobStore.get(id);
        if (!job) { sendJson(response, 404, { error: 'not_found', id }); return; }
        const locations = planLocations(job.plan);
        if (!locations.length) { sendJson(response, 400, { error: 'no_locations' }); return; }
        try {
          const client = new ComfyClient();
          if (!(await client.alive())) throw new Error('连不上 ComfyUI');
          const plates = [];
          for (let i = 0; i < locations.length; i += 1) {
            const plate = await renderPlate(client, job, job.plan, locations[i], i, job.params || {});
            plates.push(plate);
            await jobStore.patch(id, { plates: plates.slice() });
          }
          sendJson(response, 200, { ok: true, plates });
        } catch (error) {
          sendJson(response, 500, { error: 'plates_failed', message: String(error && error.message || error) });
        }
      },
    }));

    /** 重出道具资产卡：全片每件东西一张，形制锁死后再出静帧。 */
    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/props',
      handler: async (request, response) => {
        if (request.method !== 'POST') { sendJson(response, 405, { error: 'method_not_allowed' }); return; }
        if (!sameOrigin(request)) { sendJson(response, 403, { error: 'forbidden: same-origin only' }); return; }
        let body = null;
        try { body = await readJsonBody(request); } catch { body = null; }
        const id = String((body && body.id) || '');
        await jobStore.refresh();
        const job = jobStore.get(id);
        if (!job) { sendJson(response, 404, { error: 'not_found', id }); return; }
        const list = planProps(job.plan);
        if (!list.length) { sendJson(response, 400, { error: 'no_props' }); return; }
        try {
          const client = new ComfyClient();
          if (!(await client.alive())) throw new Error('连不上 ComfyUI');
          const assets = [];
          for (let i = 0; i < list.length; i += 1) {
            const asset = await renderProp(client, job, job.plan, list[i], i, job.params || {});
            assets.push(asset);
            await jobStore.patch(id, { props: assets.slice() });
          }
          sendJson(response, 200, { ok: true, props: assets });
        } catch (error) {
          sendJson(response, 500, { error: 'props_failed', message: String(error && error.message || error) });
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
      path: '/api/comfyui-music-mv/hero-img',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const id = String(url.searchParams.get('id') || '');
        const index = Number(url.searchParams.get('index') || 0);
        const kind = String(url.searchParams.get('kind') || 'file');
        await jobStore.refresh();
        const job = jobStore.get(id);
        const hero = job && Array.isArray(job.heroes) ? job.heroes[index] : null;
        if (!hero) { sendJson(response, 404, { error: 'not_found', id, index }); return; }
        const file = kind === 'human' ? hero.humanFile : kind === 'trans' ? hero.transFile : hero.file;
        if (!file) { sendJson(response, 404, { error: 'no_' + kind, id, index }); return; }
        await streamFile(request, response, file, 'image/png');
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/scene-img',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const id = String(url.searchParams.get('id') || '');
        const index = Number(url.searchParams.get('index') || 0);
        await jobStore.refresh();
        const job = jobStore.get(id);
        const plate = job && Array.isArray(job.plates) ? job.plates[index] : null;
        if (!plate || !plate.file) { sendJson(response, 404, { error: 'not_found', id, index }); return; }
        await streamFile(request, response, plate.file, 'image/png');
      },
    }));

    disposers.push(webServer.register({
      kind: 'exact',
      path: '/api/comfyui-music-mv/prop-img',
      handler: async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        const id = String(url.searchParams.get('id') || '');
        const index = Number(url.searchParams.get('index') || 0);
        await jobStore.refresh();
        const job = jobStore.get(id);
        const asset = job && Array.isArray(job.props) ? job.props[index] : null;
        if (!asset || !asset.file) { sendJson(response, 404, { error: 'not_found', id, index }); return; }
        await streamFile(request, response, asset.file, 'image/png');
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

