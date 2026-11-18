import fs from 'node:fs';
import path from 'node:path';
import { lintPlan } from './mv.js';
import { spawnSync } from 'node:child_process';
import { findFfmpeg } from './ffmpeg.js';

/**
 * 导演本：把一份已经出好静帧的任务，导成单文件 HTML（A4 打印样式，图片内嵌）。
 * 不依赖任何外部工具，双击就能看，Ctrl+P 直接出 PDF。
 */

const SIZE_CN = {
  extreme_wide: '大远景', wide: '全景', medium: '中景', medium_close: '中近景',
  close: '近景', close_up: '特写', extreme_close: '大特写',
};
const MOVE_CN = {
  static: '固定', push: '推', pull: '拉', tracking: '跟', handheld: '手持',
  crane_up: '升', crane_down: '降', pan: '摇', orbit: '环绕', whip: '甩',
};
const LIGHT_CN = {
  natural: '自然光', blue: '冷蓝', golden: '暖金', neon: '霓虹', backlit: '逆光', soft: '柔光', candle: '烛光',
};
const DOF_CN = { deep: '深景深', medium: '中景深', shallow: '浅景深' };
const H_CN = {
  front: '正面', front_left: '左前', front_right: '右前', back: '背面', back_left: '左后', back_right: '右后',
  left: '左侧', right: '右侧', profile_left: '左profile', profile_right: '右profile', top: '顶拍', ground: '地面',
};
const E_CN = { eye: '平视', high: '俯拍', low: '仰拍', top: '顶拍', ground: '地面', overhead: '顶拍' };
const FORM_CN = { beast: '本体', human: '人形', trans: '过渡' };

const esc = (value) => String(value === undefined || value === null ? '' : value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function mimeOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * 内嵌用的小图：静帧原图 1–3MB，二十几张直接 base64 会变成 60MB+ 的 HTML。
 * 用 ffmpeg 缩到指定宽度存 JPEG（按源文件 mtime 缓存，重复导出不重转）。
 * 没有 ffmpeg 时退回原图（HTML 会很大，但至少能看）。
 */
function thumbUri(file, width, ctx) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    if (ctx && ctx.bin) {
      const stat = fs.statSync(file);
      const outFile = path.join(ctx.cacheDir, `${path.basename(file).replace(/\.[^.]+$/, '')}-${width}-${Math.round(stat.mtimeMs)}.jpg`);
      if (!fs.existsSync(outFile)) {
        fs.mkdirSync(ctx.cacheDir, { recursive: true });
        const result = spawnSync(ctx.bin, [
          '-y', '-loglevel', 'error', '-i', file,
          '-vf', `scale=${width}:-2:flags=lanczos`, '-q:v', '4', outFile,
        ], { windowsHide: true, timeout: 60000 });
        if (result.status !== 0 || !fs.existsSync(outFile)) {
          return `data:${mimeOf(file)};base64,${fs.readFileSync(file).toString('base64')}`;
        }
      }
      return `data:image/jpeg;base64,${fs.readFileSync(outFile).toString('base64')}`;
    }
    return `data:${mimeOf(file)};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
}

function shotFrame(shot) {
  if (shot && shot.frameFile && fs.existsSync(shot.frameFile)) return shot.frameFile;
  if (shot && shot.frame && shot.frame.file && fs.existsSync(shot.frame.file)) return shot.frame.file;
  return null;
}

/** 节奏条：纯 SVG，块宽=时长，颜色区分景别。 */
function rhythmSvg(shots) {
  const total = shots.reduce((sum, s) => sum + Number(s.seconds || 0), 0) || 1;
  const W = 1000;
  const palette = {
    extreme_wide: '#3f5e7a', wide: '#54748f', medium: '#b4744a',
    medium_close: '#c08a5a', close: '#8f5f74', close_up: '#c2703f', extreme_close: '#d98324',
  };
  let x = 0;
  const bars = shots.map((s) => {
    const w = (Number(s.seconds || 0) / total) * W;
    const fill = palette[String(s.size || '')] || '#6b7b8c';
    const part = `<g><rect x="${x.toFixed(1)}" y="0" width="${Math.max(1, w - 1.5).toFixed(1)}" height="76" fill="${fill}"/>`
      + `<text x="${(x + 4).toFixed(1)}" y="16" fill="#fff" font-size="11" font-family="sans-serif">${s.index + 1}</text>`
      + `<text x="${(x + 4).toFixed(1)}" y="32" fill="#fff" font-size="10" font-family="sans-serif">${Number(s.seconds || 0).toFixed(1)}s</text>`
      + `<text x="${(x + 4).toFixed(1)}" y="48" fill="#f0eee8" font-size="9.5" font-family="sans-serif">${esc(SIZE_CN[String(s.size || '')] || '')}</text>`
      + `<text x="${(x + 4).toFixed(1)}" y="62" fill="#e8e4da" font-size="9.5" font-family="sans-serif">${esc(MOVE_CN[String(s.move || '')] || '')}</text></g>`;
    x += w;
    return part;
  }).join('');
  const ticks = [];
  for (let t = 0; t <= total; t += 10) {
    const px = (t / total) * W;
    ticks.push(`<text x="${px.toFixed(1)}" y="94" fill="#8a857a" font-size="9" font-family="sans-serif" text-anchor="middle">${t}</text>`);
  }
  return `<svg viewBox="0 0 ${W} 132" width="100%" style="display:block;border:1px solid #ddd8cb;background:#14161b">
${bars}
<line x1="0" y1="76" x2="${W}" y2="76" stroke="#2a2f36" stroke-width="1"/>
${ticks.join('')}
</svg>`;
}

/** 定妆：每个角色最多三套（原形 / 人形 / 过渡）。 */
function heroesSection(job, ctx) {
  const heroes = Array.isArray(job.heroes) ? job.heroes : [];
  // 纯人类角色没有"本体"，主图就是人形——别把普通人标成"本体"（会让人以为片子有兽形）
  const chars = (job.plan && job.plan.characters) || [];
  const hasBeast = (label) => chars.some((c) => String(c.name || '') === String(label || '') && String(c.beast || '').trim());
  const cards = [];
  for (const hero of heroes) {
    const beast = hasBeast(hero.label);
    const forms = beast
      ? [
        { form: 'beast', file: hero.file, note: hero.beastNote || '' },
        { form: 'human', file: hero.humanFile, note: '' },
        { form: 'trans', file: hero.transFile, note: '' },
      ]
      : [
        { form: 'human', file: hero.humanFile || hero.file, note: '' },
        { form: 'trans', file: hero.transFile, note: '' },
      ];
    for (const item of forms) {
      const uri = thumbUri(item.file, 420, ctx);
      if (!uri) continue;
      cards.push(`<div class="fig"><img src="${uri}"><p><b>${esc(hero.label || '')} · ${FORM_CN[item.form]}</b>　${esc(item.note)}</p></div>`);
    }
  }
  if (!cards.length) return '';
  return `<h2>定妆 · 每个角色三套外形</h2><p class="meta">原形（动物 / 骨架）· 人形（人）· 过渡形态（正在变的那一瞬）。静帧按镜头形态取图。</p><div class="heroes">${cards.join('')}</div>${platesSection(job, ctx)}${propsSection(job, ctx)}`;
}

/** 地点定妆：每个地点一张空镜，这一场的每一镜都拿它当空间参考。 */
function platesSection(job, ctx) {
  const plates = Array.isArray(job && job.plates) ? job.plates : [];
  const cards = [];
  for (const p of plates) {
    const uri = thumbUri(p.file, 560, ctx);
    if (!uri) continue;
    const shots = Array.isArray(p.shots) ? p.shots.join('、') : '';
    cards.push(`<div class="fig"><img src="${uri}"><p><b>${esc(p.key || '')}</b>　${esc(p.heading || '')}<br><span class="n2">用于第 ${esc(shots)} 镜</span></p></div>`);
  }
  if (!cards.length) return '';
  return `<h2>地点 · 每个地点一张空镜</h2><p class="meta">静帧生成时作为空间参考喂进参考图：同一间屋、同样的陈设位置、同样的光源方向。</p><div class="heroes">${cards.join('')}</div>`;
}

/** 道具资产：全片每件东西一张，形制锁死。 */
function propsSection(job, ctx) {
  const assets = Array.isArray(job && job.props) ? job.props : [];
  const cards = [];
  for (const p of assets) {
    const uri = thumbUri(p.file, 420, ctx);
    if (!uri) continue;
    const shots = Array.isArray(p.shots) && p.shots.length ? `用于第 ${p.shots.join('、')} 镜` : '未被任何镜头引用';
    cards.push(`<div class="fig"><img src="${uri}"><p><b>${esc(p.name || '')}</b><br><span class="n2">${esc(p.meaning || '')}</span><br><span class="n2">${esc(shots)}</span></p></div>`);
  }
  if (!cards.length) return '';
  return `<h2>道具 · 每件东西一张</h2><p class="meta">孤立单件、中性灰底、无人物无场景。静帧生成时作为参考图喂进去：要的是同一件东西，不是"一件同类的"。</p><div class="heroes">${cards.join('')}</div>`;
}

/** 分镜板。 */
function boardSection(shots, ctx) {
  const cells = shots.map((s) => {
    const file = shotFrame(s);
    const uri = file ? thumbUri(file, 560, ctx) : null;
    const cap = `<span class="n2">${String(s.index + 1).padStart(2, '0')}</span>　${esc(s.label || '')}　<span class="n2">${Number(s.seconds || 0).toFixed(1)}s</span>`;
    return uri
      ? `<div class="cell"><img src="${uri}"><div class="cap">${cap}</div></div>`
      : `<div class="cell"><div class="cap">${cap}（未出图）</div></div>`;
  }).join('');
  return `<h2>分镜 · ${shots.length} 格</h2><div class="grid21">${cells}</div>`;
}

function tableSection(shots) {
  const rows = shots.map((s) => `<tr>
<td class="n">${s.index + 1}</td>
<td>${Number(s.seconds || 0).toFixed(1)}s</td>
<td>${esc(SIZE_CN[String(s.size || '')] || '')}</td>
<td>${esc(H_CN[String(s.horizontal || '')] || s.horizontal || '')}·${esc(E_CN[String(s.elevation || '')] || s.elevation || '')}</td>
<td>${esc(MOVE_CN[String(s.move || '')] || s.move || '')}</td>
<td>${esc(LIGHT_CN[String(s.light || '')] || '')}</td>
<td>${esc(s.action || '')}</td>
<td>${esc(s.performance || '')}</td>
<td>${esc(s.objective || '')}</td>
<td>${esc(s.prop || '')}</td>
</tr>`).join('');
  const cols = '<colgroup><col style="width:3.5%"><col style="width:6%"><col style="width:6.5%"><col style="width:9%"><col style="width:6.5%"><col style="width:7%"><col style="width:21.5%"><col style="width:22%"><col style="width:10.5%"><col style="width:6.5%"></colgroup>';
  return `<h2>分镜表</h2><table class="sheet">${cols}<tr><th>#</th><th>时长</th><th>景别</th><th>机位</th><th>运镜</th><th>光</th><th>动作</th><th>表演</th><th>他要</th><th>道具</th></tr>${rows}</table>`;
}

function scriptSection(plan) {
  const scenes = Array.isArray(plan.scenes) ? plan.scenes : [];
  if (!scenes.length) return '';
  const body = scenes.map((sc) => {
    const parts = [`<h3>${esc(sc.no || '')}　${esc(sc.heading || '')}</h3>`, `<p>${esc(sc.action || '')}</p>`];
    if (sc.performance) parts.push(`<blockquote><b>表演</b><br>${esc(sc.performance)}</blockquote>`);
    if (sc.sound) parts.push(`<blockquote><b>声音</b><br>${esc(sc.sound)}</blockquote>`);
    if (sc.lyric) parts.push(`<blockquote><b>唱</b><br>${esc(sc.lyric)}</blockquote>`);
    return parts.join('');
  }).join('');
  return `<h2>剧本 · 场次体</h2>${body}`;
}

function creditsSection(plan, job) {
  const props = Array.isArray(plan.props) ? plan.props : [];
  const propList = props.length
    ? `<h3>物件母题</h3><ul class="tight">${props.map((p) => `<li><b>${esc(p.name || '')}</b>　${esc(p.meaning || '')}</li>`).join('')}</ul>`
    : '';
  const cast = Array.isArray(plan.characters) ? plan.characters : [];
  const castLine = cast.length ? `<p><b>角色</b>　${cast.map((c) => esc(c.name || '')).filter(Boolean).join(' · ')}</p>` : '';
  const twist = plan.twist && plan.twist.what
    ? `<p><b>结构</b>　第 ${esc(plan.twist.atIndex || '?')} 镜揭示：${esc(plan.twist.what)}</p>`
      + (plan.twist.sign ? `<p><b>画面信号</b>　${esc(plan.twist.sign)}<span class="dim">（这一格只拍这个，不加台词、不加解释）</span></p>` : '')
    : '';
  return `<h2>主创与基调</h2>
<p><b>曲风</b>　${esc(plan.style || '')}</p>
<p><b>视觉基调</b>　${esc(plan.look || '')}</p>
${castLine}
${twist}
${propList}`;
}

const CSS = `
@page { size: A4; margin: 16mm 14mm; }
* { box-sizing: border-box; }
body { margin:0; background:#f4f2ed; color:#16181b; font-family:"Songti SC","SimSun","Noto Serif CJK SC",serif; font-size:10.5pt; line-height:1.62; }
.page { width:210mm; min-height:296mm; padding:16mm 14mm; margin:0 auto 8mm; background:#fff; box-shadow:0 2px 14px rgba(0,0,0,.08); page-break-after:always; }
h1 { font-size:34pt; margin:0 0 6pt; letter-spacing:2pt; }
h2 { font-size:13pt; margin:22pt 0 8pt; padding-bottom:4pt; border-bottom:1px solid #c9c4b8; font-family:"PingFang SC","Microsoft YaHei",sans-serif; letter-spacing:.5pt; }
h3 { font-size:11pt; margin:14pt 0 4pt; font-family:"PingFang SC","Microsoft YaHei",sans-serif; }
.kicker { font-family:"PingFang SC","Microsoft YaHei",sans-serif; font-size:9pt; letter-spacing:3pt; color:#8a857a; }
.lede { font-size:12pt; line-height:1.8; }
.meta { font-family:"PingFang SC","Microsoft YaHei",sans-serif; font-size:9pt; color:#5c5a55; }
.cover { display:flex; flex-direction:column; justify-content:space-between; }
.cover .bottom { border-top:1px solid #d8d3c7; padding-top:8pt; }
.poster { margin:12pt 0 6pt; }
.poster img { width:100%; border-radius:2pt; display:block; }
blockquote { margin:6pt 0; padding:6pt 10pt; background:#faf8f3; border-left:2px solid #c9c4b8; font-size:9.6pt; color:#33322e; }
blockquote b { font-family:"PingFang SC","Microsoft YaHei",sans-serif; font-size:8.6pt; letter-spacing:1pt; color:#7a756b; }
table { width:100%; border-collapse:collapse; font-family:"PingFang SC","Microsoft YaHei",sans-serif; font-size:8.2pt; }
table.sheet { table-layout:fixed; font-size:7.4pt; line-height:1.45; }
table.sheet td, table.sheet th { word-break:break-all; padding:3pt 3pt; }
th { text-align:left; background:#f1eee6; border-bottom:1px solid #c9c4b8; padding:4pt 5pt; font-weight:600; color:#3b3a36; }
td { border-bottom:1px solid #e6e2d8; padding:4pt 5pt; vertical-align:top; }
td.n { color:#8a857a; width:18pt; }
.grid21 { display:grid; grid-template-columns:repeat(3,1fr); gap:7pt; }
.cell img { width:100%; display:block; border:1px solid #ddd8cb; }
.cell .cap { font-family:"PingFang SC","Microsoft YaHei",sans-serif; font-size:7.4pt; color:#4a4843; padding-top:2pt; }
.cell .n2, td.n { color:#8a857a; }
.heroes { display:grid; grid-template-columns:repeat(3,1fr); gap:8pt; }
.fig img { width:100%; display:block; border:1px solid #ddd8cb; }
.fig p { font-family:"PingFang SC","Microsoft YaHei",sans-serif; font-size:8pt; color:#5c5a55; margin:3pt 0 0; }
ul.tight { margin:4pt 0 0 14pt; padding:0; }
ul.tight li { margin:2pt 0; }
@media print { body { background:#fff; } .page { box-shadow:none; margin:0; } }
`;

/** 体检：这稿为什么是 100 分，或者哪一项没过——导演本里必须自己交代。 */
function lintSection(plan) {
  let lint = null;
  try {
    lint = lintPlan(plan);
  } catch {
    return '';
  }
  if (!lint || !Array.isArray(lint.checks)) return '';
  const rows = lint.checks.map((c) => `<tr>
    <td class="n">${c.ok ? '✓' : '✗'}</td>
    <td>${esc(c.label || c.id || '')}</td>
    <td class="meta">${esc(c.detail || '')}</td>
  </tr>`).join('');
  const bad = lint.checks.filter((c) => !c.ok);
  return `<h2>剧本体检 · ${lint.score} 分（${lint.passed}/${lint.total}）</h2>
  <p class="meta">${bad.length ? `没过 ${bad.length} 项：${bad.map((c) => esc(c.label || c.id)).join('、')}` : '全部通过。这一项一项都是能落到画面上的条件，不是形容词。'}</p>
  <table class="sheet" style="font-size:7.8pt">
    <tr><th style="width:16pt"></th><th style="width:150pt">检查项</th><th>说明</th></tr>
    ${rows}
  </table>`;
}

export function buildBookHtml(job, options = {}) {
  const pluginDir = options.pluginDir || process.cwd();
  const ctx = {
    bin: options.ffmpeg || findFfmpeg(pluginDir),
    cacheDir: path.join(pluginDir, '.data', String(job && job.id || 'book'), '.book'),
  };
  const plan = (job && job.plan) || {};
  const shots = Array.isArray(job && job.shots) ? job.shots : [];
  const title = plan.title || '未命名';
  const total = shots.reduce((sum, s) => sum + Number(s.seconds || 0), 0);
  const logline = (plan.story && (plan.story.logline || plan.story.story)) || plan.logline || '';
  // 封面用第 1 镜的静帧当主视觉：一本没有图的导演本翻开来像报价单。
  const poster = thumbUri(shotFrame(shots[0]), 1200, ctx);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>《${esc(title)}》导演本</title><style>${CSS}</style></head><body>
<section class="page cover">
  <div>
    <div class="kicker">AI MUSIC VIDEO · DIRECTOR'S SCRIPT</div>
    <h1>${esc(title)}</h1>
    <div class="meta" style="margin-top:2pt">${total.toFixed(1)} 秒 · ${shots.length} 镜 · 静帧 ${shots.filter((s) => shotFrame(s)).length}/${shots.length} 已出</div>
  </div>
  ${poster ? `<div class="poster"><img src="${poster}"></div>` : ''}
  <div><p class="lede">${esc(logline).replace(/\n/g, '<br>')}</p></div>
  <div class="bottom meta">任务 ${esc(job && job.id || '')} · 生成于 ${new Date().toLocaleString('zh-CN')}</div>
</section>
<section class="page">
  ${creditsSection(plan, job)}
  ${heroesSection(job, ctx)}
</section>
<section class="page">
  <h2>节奏</h2>
  <p class="meta">横向为真实时长，块宽 = 镜头长度，颜色区分景别。</p>
  ${rhythmSvg(shots)}
  ${scriptSection(plan)}
</section>
<section class="page">${boardSection(shots, ctx)}</section>
<section class="page">${tableSection(shots)}</section>
<section class="page">${lintSection(plan)}</section>
</body></html>`;
}
