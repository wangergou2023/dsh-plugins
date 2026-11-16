/**
 * 参考图生静帧：把定妆图当"演员本人"，把分镜提示词当"这场戏怎么拍"。
 * 用 Qwen-Image 2.1 的编辑链路（LoadImage × N → TextEncodeQwenImage21）——
 * 只有它能一边换场景一边把角色的脸/毛色/项圈记住，Krea2 纯文生图做不到。
 */
import { readFile } from 'node:fs/promises';

export async function loadRefEditTemplate(file) {
  const raw = await readFile(file, 'utf8');
  return JSON.parse(raw);
}

/** 按 16:9 之类的比例 + 目标像素算一个 64 对齐、单边 ≤2048 的尺寸。 */
export function refFrameSize(aspectRatio, megapixels = 1.3) {
  const m = /(\d+)\s*[:：]\s*(\d+)/.exec(String(aspectRatio || '16:9'));
  const r = m ? Math.max(0.4, Number(m[1]) / Number(m[2])) : 16 / 9;
  const mp = Math.min(2.4, Math.max(0.5, Number(megapixels) || 1.3));
  let h = Math.sqrt((mp * 1e6) / r);
  let w = h * r;
  if (w > 2048) { w = 2048; h = w / r; }
  if (h > 2048) { h = 2048; w = h * r; }
  const round = (v) => Math.max(512, Math.min(2048, Math.round(v / 64) * 64));
  return { width: round(w), height: round(h) };
}

export function buildRefEditGraph(template, opts = {}) {
  const g = JSON.parse(JSON.stringify(template || {}));
  const refs = (Array.isArray(opts.refs) ? opts.refs : []).map((x) => String(x || '').trim()).filter(Boolean);
  if (!refs.length) throw new Error('参考生图至少需要一张定妆图');
  if (refs.length > 4) refs.length = 4;

  const enc = g['459:474'];
  const batch = g['459:485'];
  if (!enc || !batch) throw new Error('Qwen 参考模板结构不对：缺 TextEncodeQwenImage21 / BatchImagesNode');

  g['470'].inputs.image = refs[0];
  for (const key of Object.keys(enc.inputs)) if (key.startsWith('images.image_')) delete enc.inputs[key];
  enc.inputs['images.image_1'] = ['470', 0];

  if (refs[1]) {
    g['475'].inputs.image = refs[1];
    enc.inputs['images.image_2'] = ['475', 0];
    batch.inputs['images.image1'] = ['475', 0];
  } else {
    delete g['475'];
    delete batch.inputs['images.image1'];
  }

  for (let i = 2; i < refs.length; i += 1) {
    const id = String(900 + i - 2);
    g[id] = { class_type: 'LoadImage', inputs: { image: refs[i] } };
    enc.inputs[`images.image_${i + 1}`] = [id, 0];
    batch.inputs[`images.image${i}`] = [id, 0];
  }

  const text = String(opts.prompt || '').trim();
  if (!text) throw new Error('参考生图缺提示词');
  g['459:484'].inputs.on_false = text;
  g['459:484'].inputs.switch = false;
  g['459:500'].inputs.prompt = text;

  const sampler = g['459:458'].inputs;
  sampler.steps = Math.max(4, Math.min(60, Math.round(Number(opts.steps) || 25)));
  sampler.cfg = Number.isFinite(Number(opts.cfg)) ? Number(opts.cfg) : 1;
  const seed = Number.isFinite(Number(opts.seed)) ? Math.trunc(Number(opts.seed)) : Math.floor(Math.random() * 2 ** 48);
  sampler.seed = seed;

  const size = refFrameSize(opts.aspectRatio, opts.megapixels);
  g['459:468'].inputs.switch = true;
  g['459:456'].inputs.width = size.width;
  g['459:456'].inputs.height = size.height;
  if (opts.prefix) g['461'].inputs.filename_prefix = opts.prefix;

  return { prompt: g, seed, width: size.width, height: size.height };
}

/** 这一镜是"本体"还是"人形"：交给喂哪张定妆图。 */
export function shotForm(shot) {
  const t = `${(shot && shot.action) || ''} ${(shot && shot.performance) || ''} ${(shot && shot.dialogue) || ''}`;
  const beast = /小狗|细犬|四爪|前爪|爪子|爪|尾巴|摇尾|犬|狗形|狗/.test(t);
  const human = /人形|少女|少年|男人|女人|男子|女子|她的脸|他的脸|脸上|眼神/.test(t);
  const bone = /骨架|骨爪|骨颅|骨指|指骨|腕骨|骷髅|白骨/.test(t);
  if (human && !beast) return 'human';
  if (beast || bone) return 'beast';
  return 'human';
}

/**
 * 这一镜要用哪几张定妆图：按 cast 找人，再按形态选"本体图 / 人形图"。
 * 一张图只代表一个形态——喂错图，模型就会把狗画成人。
 */
export function refsForShot(job, shot, max = 2) {
  const heroes = Array.isArray(job && job.heroes) ? job.heroes : [];
  if (!heroes.length) return { refs: [], labels: [] };
  const cast = Array.isArray(shot && shot.cast) ? shot.cast.map((x) => String(x).trim()).filter(Boolean) : [];
  const pool = cast.length ? heroes.filter((h) => cast.includes(String(h.label || '').trim())) : heroes;
  const form = shotForm(shot);
  const refs = [];
  const labels = [];
  for (const h of pool) {
    const name = String(h.label || '').trim();
    const wantHuman = form === 'human';
    const comfy = wantHuman ? (h.humanComfy || h.comfy) : (h.comfy || h.humanComfy);
    if (!comfy) continue;
    refs.push(comfy);
    labels.push(wantHuman ? `${name}的人形` : `${name}的本体`);
    if (refs.length >= max) break;
  }
  return { refs, labels };
}

/** 喂给 Qwen 的话术：先认人，再演戏。两张定妆图时必须点名"这是两个角色"。 */
export function refInstruction(refLabels, sceneText) {
  const names = (Array.isArray(refLabels) ? refLabels : []).filter(Boolean).slice(0, 2);
  const head = names.length >= 2
    ? `画面里有 ${names.length} 个完全不同的角色，绝对不要融合成一个：参考图 1 是${names[0]}，参考图 2 是${names[1]}。`
    : `参考图是${names[0] || '角色'}的定妆照，整张图只有这一个角色，不要添加别的生物。`;
  return [
    head,
    '长相、毛色、发型、服装、配饰（项圈、铜牌、骨纹）必须与参考图完全一致，不要换脸、不要换毛色、不要改配饰。',
    '只改变场景、机位、光线和动作。整体曝光正常，主体在画面里清楚可见，不要压得过暗。',
    sceneText,
  ].filter(Boolean).join('\n');
}
