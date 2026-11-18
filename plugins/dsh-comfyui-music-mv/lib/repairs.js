import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { lintPlan, normalizePlan, parsePlanJson } from './mv.js';
import { llmText, text } from './llm.js';
import { REVIEW_SYSTEM, COMPARE_SYSTEM, REWRITE_SYSTEM, WARM_SYSTEM, FOCUS_SYSTEM } from './prompts.js';

export async function repairBookend(ctx, plan) {
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
export function relieveSilence(plan) {
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

export async function reviewPlan(ctx, plan) {
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

export async function comparePlans(ctx, planA, planB) {
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

/**
 * 两版分镜对打，必须换位跑两遍。
 * 单跑一遍会被位置偏差吃掉：同一份分镜放 A 位比放 B 位多赢一倍。
 * 只有"两种次序下都赢"才算真赢。
 */
export async function comparePlansFair(ctx, planA, planB) {
  const first = await comparePlans(ctx, planA, planB);
  const second = await comparePlans(ctx, planB, planA); // 换位
  const byIndex = new Map();
  const note = (round, flip) => {
    for (const s of round.shots || []) {
      const cur = byIndex.get(s.i) || { i: s.i, votes: [] };
      // 第二次跑时 B 位是 A 版，判词里的 A/B 要翻转回来
      const w = s.winner === 'tie' ? 'tie' : (flip ? (s.winner === 'A' ? 'B' : 'A') : s.winner);
      cur.votes.push({ winner: w, why: s.why });
      byIndex.set(s.i, cur);
    }
  };
  note(first, false);
  note(second, true);
  const shots = [...byIndex.values()].sort((a, b) => a.i - b.i).map((row) => {
    const a = row.votes.filter((v) => v.winner === 'A').length;
    const b = row.votes.filter((v) => v.winner === 'B').length;
    const verdict = a > b ? 'A' : b > a ? 'B' : 'tie';
    return { i: row.i, verdict, a, b, why: (row.votes[0] && row.votes[0].why) || '' };
  });
  const wins = { A: 0, B: 0, tie: 0 };
  for (const s of shots) wins[s.verdict] += 1;
  return { wins, shots, rounds: 2, note: '换位跑了两遍：只有两个次序下都赢的镜才算赢' };
}

/* ---------------------------- 弱镜返修 ---------------------------- */

export async function rewriteShots(ctx, plan, items) {
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

export async function addWarmBeat(ctx, plan) {
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

export async function focusSignShot(ctx, plan) {
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

