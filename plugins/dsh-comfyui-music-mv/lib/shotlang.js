/**
 * 镜头语言词典：把「景别 / 角度 / 运镜 / 灯光 / 景深 / 转场」变成可选的枚举 + 英文提示词片段。
 *
 * 思路参考 LocalMiniDrama 的 angleService（8 方向 × 4 俯仰 × 3 景别 ...），
 * 但按 MV 的用法精简：中文标签给人选，英文片段给模型吃。
 * 分镜表里的一个镜头由这些结构化字段拼出提示词，而不是一段自由文本 ——
 * 这样「特写推镜 + 侧光」这种意图才不会被自由文本稀释。
 */

export const SIZES = [
  { key: 'extreme_wide', zh: '大远景', en: 'extreme wide shot, subject tiny within a vast environment, deep focus' },
  { key: 'wide', zh: '全景', en: 'wide shot, full body with environment, subject small relative to scene, deep depth of field' },
  { key: 'medium', zh: '中景', en: 'medium shot, waist-up to full body, character and immediate surroundings visible' },
  { key: 'close', zh: '近景', en: 'close-up shot, chest and up, subject fills most of the frame' },
  { key: 'extreme_close', zh: '特写', en: 'extreme close-up, face detail, eyes in razor focus' },
];

export const HORIZONTALS = [
  { key: 'front', zh: '正面', en: 'shooting from the front' },
  { key: 'front_left', zh: '前左 45°', en: 'shooting from front-left at a 45-degree angle' },
  { key: 'left', zh: '正左侧', en: 'shooting from the left side, profile view' },
  { key: 'back_left', zh: '后左 135°', en: 'shooting from back-left at a 135-degree angle' },
  { key: 'back', zh: '正背面', en: "shooting from behind, character's back to camera" },
  { key: 'back_right', zh: '后右 135°', en: 'shooting from back-right at a 135-degree angle' },
  { key: 'right', zh: '正右侧', en: 'shooting from the right side, profile view' },
  { key: 'front_right', zh: '前右 45°', en: 'shooting from front-right at a 45-degree angle' },
];

export const ELEVATIONS = [
  { key: 'worm', zh: '虫眼仰拍', en: "extreme low-angle worm's eye view, camera near the ground pointing upward" },
  { key: 'low', zh: '低角度', en: 'low-angle upward shot, camera below eye line, slight upward tilt' },
  { key: 'eye', zh: '平视', en: 'eye-level shot, neutral horizontal perspective' },
  { key: 'high', zh: '高角度', en: "high-angle shot looking down, bird's eye perspective" },
];

export const MOVES = [
  { key: 'static', zh: '固定', en: 'static locked shot, no camera movement' },
  { key: 'push', zh: '推镜', en: 'slow push-in dolly, camera gradually moves closer' },
  { key: 'pull', zh: '拉镜', en: 'pull-back dolly, camera gradually moves away' },
  { key: 'pan', zh: '横摇', en: 'horizontal pan, camera sweeps laterally' },
  { key: 'tilt', zh: '纵摇', en: 'vertical tilt, camera pivots up or down' },
  { key: 'tracking', zh: '跟镜', en: 'tracking shot, camera follows the subject smoothly' },
  { key: 'crane_up', zh: '升镜', en: 'crane up, camera rises vertically revealing the wider scene' },
  { key: 'crane_down', zh: '降镜', en: 'crane down, camera descends vertically' },
  { key: 'orbit', zh: '环绕', en: 'orbiting arc shot, camera circles the subject' },
  { key: 'handheld', zh: '手持', en: 'handheld shot, subtle natural camera shake' },
];

export const LIGHTS = [
  { key: 'natural', zh: '自然光', en: 'natural ambient lighting, soft and even' },
  { key: 'front', zh: '顺光', en: 'flat front lighting, minimal shadows' },
  { key: 'side', zh: '侧光', en: 'dramatic side lighting, strong contrast' },
  { key: 'backlit', zh: '逆光', en: 'backlit with rim light, subject partly silhouetted' },
  { key: 'top', zh: '顶光', en: 'harsh overhead top light, strong downward shadows' },
  { key: 'under', zh: '底光', en: 'unsettling underlighting from below' },
  { key: 'soft', zh: '柔光', en: 'soft diffused lighting, gentle shadows' },
  { key: 'dramatic', zh: '戏剧光', en: 'high-contrast chiaroscuro lighting, deep shadows' },
  { key: 'golden', zh: '黄金时段', en: 'warm golden-hour sunlight, long low shadows, amber glow' },
  { key: 'blue', zh: '蓝调', en: 'cool blue-hour twilight, moody dusk atmosphere' },
  { key: 'night', zh: '夜景', en: 'low-key night lighting, isolated artificial light sources' },
  { key: 'neon', zh: '霓虹', en: 'vivid neon lighting, colored artificial lights, cyberpunk mood' },
];

export const DOFS = [
  { key: 'extreme_shallow', zh: '极浅', en: 'extremely shallow depth of field, razor-thin focus plane, creamy bokeh' },
  { key: 'shallow', zh: '浅', en: 'shallow depth of field, subject sharp, background softly blurred' },
  { key: 'medium', zh: '中等', en: 'moderate depth of field, subject and surroundings in focus' },
  { key: 'deep', zh: '深', en: 'deep focus, everything sharp from foreground to background' },
];

export const TRANSITIONS = [
  { key: 'cut', zh: '硬切' },
  { key: 'dissolve', zh: '叠化' },
  { key: 'match', zh: '同构图' },
  { key: 'whip', zh: '甩镜' },
  { key: 'fade', zh: '淡入淡出' },
];

const pick = (list, key, fallback) => list.find((x) => x.key === key) || list.find((x) => x.key === fallback) || list[0];

/** 中文标签（找不到就原样返回，容忍模型写自由文本）。 */
export function labelOf(list, key) {
  const hit = list.find((x) => x.key === key || x.zh === key);
  return hit ? hit.zh : String(key || '');
}

export function vocab() {
  const strip = (list) => list.map((x) => ({ key: x.key, zh: x.zh }));
  return {
    sizes: strip(SIZES),
    horizontals: strip(HORIZONTALS),
    elevations: strip(ELEVATIONS),
    moves: strip(MOVES),
    lights: strip(LIGHTS),
    dofs: strip(DOFS),
    transitions: strip(TRANSITIONS),
  };
}

/**
 * 把一镜的结构化字段拼成一段镜头语言英文（景别 → 俯仰 → 方向 → 运镜 → 灯光 → 景深）。
 * 这是"专业分镜"的核心：模型对 `close-up ... eye-level ... shallow depth of field`
 * 这类短语的反应比"很感人的特写"稳定得多。
 */
export function cameraFragment(shot = {}) {
  const size = pick(SIZES, shot.size, 'medium');
  const elev = pick(ELEVATIONS, shot.elevation, 'eye');
  const horiz = pick(HORIZONTALS, shot.horizontal, 'front');
  const move = pick(MOVES, shot.move, 'static');
  const light = pick(LIGHTS, shot.light, 'natural');
  const dof = pick(DOFS, shot.dof, 'medium');
  return [size.en, elev.en, horiz.en, move.en, light.en, dof.en].join(', ');
}

/** 分镜里用的一句话摘要，给 UI 和日志看。 */
export function cameraSummary(shot = {}) {
  const size = pick(SIZES, shot.size, 'medium');
  const elev = pick(ELEVATIONS, shot.elevation, 'eye');
  const horiz = pick(HORIZONTALS, shot.horizontal, 'front');
  const move = pick(MOVES, shot.move, 'static');
  const light = pick(LIGHTS, shot.light, 'natural');
  return `${size.zh}·${elev.zh}·${horiz.zh}｜${move.zh}｜${light.zh}`;
}
