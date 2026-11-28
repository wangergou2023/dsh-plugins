/**
 * 工作台：一个自包含的网页（HTML + CSS + 原生 JS），由插件的 webServer 直接发出。
 *
 * 为什么单独做页面：DSH 面板的容器限制高度、改一次要硬刷/重启，21 镜的审查在那种环境里很难受。
 * 这里不做构建、不引依赖——页面只 fetch 现成的 /api/comfyui-music-mv/* 路由。
 *
 * 渲染时会把 job / plan / lint / meta 注入到 window.__MV_STUDIO__，
 * 首屏不用等一次网络往返；之后按 job.status 轮询。
 */

const THE_STAGES = [
  ['plan', '剧本'],
  ['song', '出歌'],
  ['hero', '定妆'],
  ['plates', '地点'],
  ['props', '道具'],
  ['frames', '静帧'],
  ['videos', '视频'],
  ['stitch', '合成'],
];

const STAGE_ORDER = THE_STAGES.map((s) => s[0]);

function escapeHtml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeJson(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function renderStudio({ job = null, jobs = [], meta = null, lint = null, error = '' } = {}) {
  const seed = { job, jobs, meta, lint, error };

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>音乐 MV · 工作台</title>
<style>
  :root{
    --bg:#f6f7f9; --card:#fff; --line:#e6e8ec; --ink:#1b1d21; --dim:#6b7280;
    --accent:#3b6cf6; --accent-soft:#eef3ff; --ok:#12805c; --ok-soft:#e8f6f0;
    --warn:#a15c00; --warn-soft:#fff4e5; --bad:#c6353c; --bad-soft:#fdeeee;
  }
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);color:var(--ink);
    font:14px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
  a{color:var(--accent);text-decoration:none}
  button{font:inherit;color:inherit}
  .bar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:12px;
    height:54px;padding:0 16px;background:rgba(255,255,255,.94);
    border-bottom:1px solid var(--line);backdrop-filter:blur(8px)}
  .bar h1{margin:0;font-size:15px;font-weight:650;letter-spacing:.2px;white-space:nowrap}
  .meta-mini{font-size:12px;color:var(--dim);white-space:nowrap}
  .pill{font-size:11px;padding:2px 8px;border-radius:999px;background:#f1f3f6;color:#57606a;white-space:nowrap}
  .pill.ok{background:var(--ok-soft);color:var(--ok)}
  .pill.warn{background:var(--warn-soft);color:var(--warn)}
  .pill.bad{background:var(--bad-soft);color:var(--bad)}
  .stages{display:flex;gap:4px;margin-left:auto;overflow:hidden}
  .stage{font-size:12px;padding:4px 9px;border-radius:999px;color:#8b929c;white-space:nowrap}
  .stage.done{color:var(--ok);background:var(--ok-soft)}
  .stage.now{color:#fff;background:var(--accent)}
  .cta{font-size:13px;font-weight:600;color:#fff;background:var(--accent);border:0;
    border-radius:8px;padding:8px 14px;cursor:pointer;white-space:nowrap}
  .cta[disabled]{opacity:.45;cursor:not-allowed}
  .cta.ghost{background:#fff;color:var(--ink);border:1px solid var(--line);font-weight:500}

  .wrap{display:grid;grid-template-columns:344px minmax(0,1fr);gap:16px;
    padding:16px 16px 48px;align-items:start}
  @media (max-width:1080px){ .wrap{grid-template-columns:minmax(0,1fr)} .col-l{position:static;max-height:none} }
  .col-l{position:sticky;top:70px;display:flex;flex-direction:column;gap:10px;
    max-height:calc(100vh - 86px);overflow:auto;padding-right:2px}

  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}
  .card h2{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--dim)}
  .ta{width:100%;min-height:74px;resize:vertical;border:1px solid var(--line);border-radius:8px;
    padding:8px 10px;font:13px/1.55 inherit;background:#fcfcfd}
  .ta:focus{outline:2px solid var(--accent-soft);border-color:#cbdcff}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}
  .field{display:flex;flex-direction:column;gap:4px;min-width:0}
  .field span{font-size:11px;color:var(--dim)}
  .field input,.field select,.field textarea{border:1px solid var(--line);border-radius:7px;
    padding:6px 8px;font:13px inherit;background:#fcfcfd;width:100%;min-width:0}
  .field textarea{min-height:64px;resize:vertical;line-height:1.5}
  .row{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}
  .btn{font-size:12px;border:1px solid var(--line);background:#fff;border-radius:7px;
    padding:6px 10px;cursor:pointer;white-space:nowrap}
  .btn:hover{border-color:#cfd4dc}
  .btn[disabled]{opacity:.45;cursor:not-allowed}
  .btn.primary{background:var(--accent-soft);border-color:#cbdcff;color:#2554d6;font-weight:600}
  .btn.danger{color:var(--bad)}

  details{border:1px solid var(--line);border-radius:10px;background:var(--card)}
  details+details{margin-top:8px}
  summary{list-style:none;cursor:pointer;padding:10px 12px;font-size:12px;font-weight:600;
    color:var(--dim);display:flex;align-items:center;gap:8px}
  summary::-webkit-details-marker{display:none}
  summary::before{content:"▸";font-size:10px;color:#9aa1ab;transition:transform .15s}
  details[open] summary::before{content:"▾"}
  summary em{margin-left:auto;font-style:normal;font-weight:400;color:#9aa1ab}
  .dbody{padding:0 12px 12px;font-size:13px}
  .lede{color:#374151;line-height:1.7;white-space:pre-wrap}
  .lede b{color:var(--ink)}
  .thumbs{display:flex;gap:8px;flex-wrap:wrap}
  .thumbs figure{margin:0;width:62px}
  .thumbs img{width:62px;height:62px;object-fit:cover;border-radius:8px;border:1px solid var(--line);background:#f1f3f6}
  .thumbs figcaption{font-size:10px;color:var(--dim);text-align:center;margin-top:3px;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .score{display:flex;align-items:baseline;gap:8px}
  .score b{font-size:26px;letter-spacing:-.5px}
  .score span{font-size:11px;color:var(--dim)}
  .checks{display:flex;flex-direction:column;gap:4px;margin-top:8px;font-size:12px}
  .checks .bad{color:var(--bad)}
  .checks .ok{color:#8b929c}
  .hist{font-size:12px;color:var(--dim);display:flex;flex-direction:column;gap:5px}
  .hist button{all:unset;cursor:pointer;display:flex;gap:6px;align-items:baseline}
  .hist b{color:var(--ink);font-weight:500}
  .hist .st{font-size:10.5px;padding:0 6px;border-radius:999px;background:#f1f3f6;color:#57606a}

  .film{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(220px,1fr);gap:14px;
    background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}
  @media (max-width:760px){ .film{grid-template-columns:minmax(0,1fr)} }
  .film .stagebox{position:relative;background:#000;border-radius:8px;overflow:hidden;aspect-ratio:2.35/1}
  .film video,.film img.poster{width:100%;height:100%;object-fit:contain;display:block;background:#000}
  .film .empty{color:#c7ccd4;font-size:12px;display:flex;align-items:center;justify-content:center;height:100%}
  .film-side{display:flex;flex-direction:column;gap:7px;font-size:12px;color:var(--dim);min-width:0}
  .film-side .big{font-size:15px;color:var(--ink);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .kv{display:flex;justify-content:space-between;gap:10px;border-bottom:1px dashed var(--line);padding-bottom:5px}
  .kv b{color:var(--ink);font-weight:600;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .film-actions{margin-top:auto;display:flex;gap:6px;flex-wrap:wrap}

  .strip{display:flex;gap:4px;margin:14px 0 10px}
  .seg{height:30px;border-radius:5px;position:relative;overflow:hidden;cursor:pointer;
    background:linear-gradient(180deg,#dfe7fb,#c9d7f7);flex-grow:1;min-width:26px;border:1px solid transparent}
  .seg.s2{background:linear-gradient(180deg,#f7e6d5,#f0d6bb)}
  .seg.s3{background:linear-gradient(180deg,#e2f1e8,#cfe8da)}
  .seg.s4{background:linear-gradient(180deg,#ece4f6,#ddcff0)}
  .seg.on{border-color:var(--accent)}
  .seg span{position:absolute;left:4px;bottom:2px;font-size:10px;color:#3c4a63;white-space:nowrap}

  .shots{display:grid;grid-template-columns:repeat(auto-fill,minmax(266px,1fr));gap:12px}
  .shot{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;
    display:flex;flex-direction:column;scroll-margin-top:70px}
  .shot.on{border-color:#cbdcff;box-shadow:0 0 0 3px var(--accent-soft)}
  .shot .top{display:flex;align-items:center;gap:8px;padding:8px 10px;font-size:12px}
  .shot .no{font-weight:700}
  .shot .dur{color:var(--dim);font-size:11px}
  .shot .badge{margin-left:auto;font-size:10px;color:#57606a;background:#f1f3f6;
    padding:1px 6px;border-radius:999px;white-space:nowrap}
  .shot .badge.ok{background:var(--ok-soft);color:var(--ok)}
  .shot .badge.run{background:var(--accent-soft);color:#2554d6}
  .shot .badge.bad{background:var(--bad-soft);color:var(--bad)}
  .thumb{position:relative;background:#f1f3f6;aspect-ratio:16/9;display:block;width:100%;border:0;padding:0;cursor:pointer}
  .thumb img{width:100%;height:100%;object-fit:cover;display:block}
  .thumb .ph{display:flex;align-items:center;justify-content:center;height:100%;color:#a4abb5;font-size:12px}
  .thumb .sect{position:absolute;left:8px;top:8px;font-size:10px;color:#fff;background:rgba(0,0,0,.55);
    padding:1px 6px;border-radius:999px}
  .shot .cap{padding:8px 10px 10px;display:flex;flex-direction:column;gap:6px}
  .tags{display:flex;gap:5px;flex-wrap:wrap}
  .tag{font-size:10.5px;color:#4b5563;background:#f3f5f8;border-radius:4px;padding:1px 5px;white-space:nowrap}
  .tag.hot{background:var(--warn-soft);color:var(--warn)}
  .act{font-size:12px;color:#4b5563;line-height:1.55;display:-webkit-box;-webkit-line-clamp:2;
    -webkit-box-orient:vertical;overflow:hidden}
  .ops{display:flex;gap:6px;margin-top:2px}
  .ops .btn{flex:1;text-align:center;padding:5px 0;font-size:11.5px}

  .drawer{position:fixed;right:16px;bottom:16px;width:min(560px,calc(100vw - 32px));z-index:30;
    background:var(--card);border:1px solid var(--line);border-radius:14px;
    box-shadow:0 18px 48px rgba(18,22,30,.18);padding:14px;display:none}
  .drawer.on{display:block}
  .drawer h3{margin:0 0 10px;font-size:13px;display:flex;align-items:center;gap:8px}
  .drawer h3 button{margin-left:auto;border:0;background:none;font-size:16px;cursor:pointer;color:var(--dim)}
  .dr-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
  @media (max-width:640px){ .dr-grid{grid-template-columns:1fr 1fr} }
  .dr-grid .field span{font-size:10.5px}
  .note{font-size:11.5px;color:var(--dim);line-height:1.6;margin-top:10px}
  .toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:40;
    background:#1b1d21;color:#fff;font-size:12.5px;padding:9px 14px;border-radius:9px;
    opacity:0;pointer-events:none;transition:opacity .18s;max-width:70vw}
  .toast.on{opacity:.96}
  .empty-state{background:var(--card);border:1px dashed var(--line);border-radius:12px;
    padding:26px;text-align:center;color:var(--dim);font-size:13px}
</style>
</head>
<body>
<div class="bar">
  <h1>音乐 MV</h1>
  <span class="meta-mini" id="meta-line">连接中…</span>
  <span class="pill" id="pill">状态未知</span>
  <div class="stages" id="stages"></div>
  <button class="cta" id="btn-resume" style="display:none">▶ 继续</button>
</div>

<div class="wrap">
  <div class="col-l">
    <div class="card">
      <h2>主题</h2>
      <textarea class="ta" id="theme" placeholder="一句话说清想拍什么：失恋的男生在雨夜街头走了很久，最后在天亮时笑了一下"></textarea>
      <div class="grid2">
        <label class="field"><span>歌长(秒)</span><input id="duration" type="number" min="15" max="600" step="5"></label>
        <label class="field"><span>比例</span>
          <select id="aspectRatio">
            <option>16:9 (Widescreen)</option>
            <option>9:16 (Portrait Widescreen)</option>
            <option>21:9 (Ultrawide)</option>
            <option>1:1 (Square)</option>
            <option>4:3 (Standard)</option>
            <option>3:4 (Portrait Standard)</option>
          </select>
        </label>
        <label class="field"><span>静帧(MP)</span><input id="frameMegapixels" type="number" min="1" max="16" step="0.5"></label>
        <label class="field"><span>视频(MP)</span><input id="megapixels" type="number" min="0.2" max="1" step="0.05"></label>
      </div>
      <div class="row">
        <button class="btn primary" id="btn-plan">🎬 生成剧本</button>
        <button class="btn" id="btn-run">一键到底</button>
        <button class="btn" id="btn-import">⇧ 导入</button>
        <button class="btn" id="btn-new">＋ 新建</button>
        <input id="file-import" type="file" accept=".json,application/json" style="display:none">
      </div>
      <div class="note" id="busy-line" style="min-height:17px"></div>
    </div>

    <div id="rail"></div>
  </div>

  <div class="col-r" id="main"></div>
</div>

<div class="drawer" id="drawer"></div>
<div class="toast" id="toast"></div>

<script>
const SEED = ${escapeJson(seed)};
const API = '/api/comfyui-music-mv';

const STAGES_UI = [['plan','剧本'],['song','出歌'],['hero','定妆'],['plates','地点'],['props','道具'],['frames','静帧'],['videos','视频'],['stitch','合成']];
const STAGE_ORDER = STAGES_UI.map(function(s){ return s[0]; });

const SIZES = ['大远景','远景','全景','中景','近景','特写','大特写','微距','插入镜'];
const HORS = ['正面','前左','前右','侧面','后左','后右','背面','越肩'];
const ELEVS = ['平视','仰拍','俯拍','高角','低角','鸟瞰'];
const MOVES = ['固定','推','拉','摇','移','跟','环绕','升降','手持'];
const LIGHTS = ['顺光','侧光','逆光','顶光','底光','柔光','戏剧光','黄金时段','夜景'];
const DOFS = ['浅','中','深','全焦'];
const TRANS = ['硬切','叠化','白闪','黑场','甩镜'];

const state = {
  job: SEED.job || null,
  jobs: SEED.jobs || [],
  meta: SEED.meta || null,
  lint: SEED.lint || null,
  plan: null,
  busy: '',
  current: 0,
  timer: 0,
};

function $(id){ return document.getElementById(id); }
function h(strings){ return strings; }

function esc(v){
  return String(v === undefined || v === null ? '' : v)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
function toast(msg){
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(function(){ el.classList.remove('on'); }, 2400);
}
function fmtClock(sec){
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s/60) + ':' + String(s%60).padStart(2,'0');
}
async function api(path, options){
  const res = await fetch(API + path, Object.assign({
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
  }, options || {}));
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) throw new Error((body && (body.message || body.error)) || ('HTTP ' + res.status));
  return body;
}

/* ---------------- 顶部 ---------------- */
function renderTop(){
  const meta = state.meta;
  const job = state.job;
  const line = $('meta-line');
  const pill = $('pill');

  if (meta && meta.comfyui && meta.comfyui.version) {
    const vram = meta.comfyui.vramFreeGB !== undefined && meta.comfyui.vramFreeGB !== null
      ? ' · 空闲 ' + Number(meta.comfyui.vramFreeGB).toFixed(1) + ' GB' : '';
    line.textContent = 'ComfyUI ' + meta.comfyui.version + vram;
  } else {
    line.textContent = 'ComfyUI 未连接';
  }
  if (meta && meta.ffmpeg && meta.ffmpeg.ok) {
    pill.textContent = '转场可用';
    pill.className = 'pill ok';
  } else if (meta) {
    pill.textContent = '转场不可用（硬切）';
    pill.className = 'pill warn';
  }

  const now = job ? STAGE_ORDER.indexOf(job.stage) : -1;
  $('stages').innerHTML = STAGES_UI.map(function(item, i){
    var cls = 'stage';
    if (job) {
      if (job.stage === 'done' || (now > i && job.stage !== 'failed')) cls += ' done';
      else if (now === i) cls += job.status === 'running' ? ' now' : '';
    }
    var extra = '';
    if (job && item[0] === 'frames' && job.shots && job.shots.length) {
      var done = job.shots.filter(function(s){ return s.frame; }).length;
      extra = ' ' + done + '/' + job.shots.length;
    }
    if (job && item[0] === 'videos' && job.shots && job.shots.length) {
      var vd = job.shots.filter(function(s){ return s.video; }).length;
      extra = ' ' + vd + '/' + job.shots.length;
    }
    return '<span class="' + cls + '">' + esc(item[1] + extra) + '</span>';
  }).join('');

  var btn = $('btn-resume');
  if (job && (job.status === 'paused' || job.status === 'interrupted' || job.status === 'failed')) {
    btn.style.display = '';
    var phase = job.stage === 'videos' ? 'videos' : (job.shots || []).some(function(s){ return s.frame; }) ? 'videos' : 'frames';
    btn.textContent = job.status === 'failed' ? '▶ 重试' : (phase === 'videos' ? '▶ 出视频' : '▶ 出静帧');
    btn.dataset.phase = phase;
  } else {
    btn.style.display = 'none';
  }
}

/* ---------------- 左栏 ---------------- */
function renderRail(){
  const job = state.job;
  const plan = (job && job.plan) || state.plan;
  const rail = $('rail');
  if (!plan) {
    rail.innerHTML = '<div class="empty-state">还没有剧本。左边写一句主题，点「生成剧本」。</div>';
    return;
  }

  const story = plan.story || {};
  const chars = plan.characters || plan.character || [];
  const scenes = plan.scenes || [];
  const heroes = (job && job.heroes) || [];
  const plates = (job && job.plates) || [];
  const props = (job && job.props) || [];
  const lint = state.lint;
  const checks = (lint && (lint.checks || lint.items)) || [];

  var html = '';

  /* 剧本 */
  html += '<details open><summary>剧本<em>' + esc((plan.shots ? plan.shots.length : 0) + ' 镜 / ' + scenes.length + ' 场') + '</em></summary><div class="dbody">';
  html += '<div class="lede"><b>《' + esc(plan.title || '未命名') + '》</b> ' + esc(plan.duration || (job && job.params && job.params.duration) || '') + ' 秒';
  if (story.logline) html += '<br>' + esc(story.logline);
  if (story.arc) html += '<br><span style="color:#6b7280">' + esc(story.arc) + '</span>';
  if (plan.twist && plan.twist.what) html += '<br><span style="color:#a15c00">第 ' + esc(plan.twist.atIndex || '?') + ' 镜揭示：' + esc(plan.twist.what) + '</span>';
  html += '</div>';
  if (plan.lyrics) html += '<div class="note" style="white-space:pre-wrap;max-height:150px;overflow:auto">' + esc(plan.lyrics) + '</div>';
  html += '</div></details>';

  /* 资产 */
  var assets = '';
  if (heroes.length) {
    assets += '<div class="thumbs" style="margin-bottom:8px">';
    heroes.forEach(function(hero, i){
      var src = API + '/hero-img?id=' + encodeURIComponent(job.id) + '&index=' + i + '&kind=' + (hero.humanFile ? 'human' : 'file');
      assets += '<figure><img loading="lazy" src="' + src + '" alt=""><figcaption>' + esc(hero.label || ('角色' + (i+1))) + '</figcaption></figure>';
    });
    assets += '</div>';
  } else if (chars.length) {
    assets += '<div class="note">角色：' + esc(chars.map(function(c){ return c.name; }).join(' · ')) + '（还没出定妆图）</div>';
  }
  if (plates.length) {
    assets += '<div class="thumbs" style="margin-bottom:8px">';
    plates.forEach(function(plate, i){
      var src = API + '/scene-img?id=' + encodeURIComponent(job.id) + '&index=' + i;
      assets += '<figure><img loading="lazy" src="' + src + '" alt=""><figcaption>' + esc(plate.heading || plate.key || ('地点' + (i+1))) + '</figcaption></figure>';
    });
    assets += '</div>';
  }
  if (props.length) {
    assets += '<div class="thumbs">';
    props.forEach(function(prop, i){
      if (!prop.file) return;
      var src = API + '/prop-img?id=' + encodeURIComponent(job.id) + '&index=' + i;
      assets += '<figure><img loading="lazy" src="' + src + '" alt=""><figcaption>' + esc(prop.name || ('道具' + (i+1))) + '</figcaption></figure>';
    });
    assets += '</div>';
  }
  if (assets) {
    html += '<details><summary>资产<em>' + esc(heroes.length + ' 角色 / ' + plates.length + ' 地点 / ' + props.length + ' 道具') + '</em></summary><div class="dbody">' + assets + '</div></details>';
  }

  /* 体检 */
  if (checks.length) {
    var bad = checks.filter(function(it){ return !it.ok; });
    html += '<details' + (bad.length ? ' open' : '') + '><summary>剧本体检<em>' + esc(checks.length + ' 项') + '</em></summary><div class="dbody">';
    html += '<div class="score"><b style="color:' + (bad.length ? '#c6353c' : '#12805c') + '">' + esc(lint.score !== undefined ? lint.score : Math.round((checks.length - bad.length) / checks.length * 100)) + '</b><span>/ ' + esc(checks.length) + ' 项，' + (bad.length ? (bad.length + ' 项没过') : '全部通过') + '</span></div>';
    html += '<div class="checks">';
    bad.slice(0, 6).forEach(function(it){
      html += '<div class="bad">✗ ' + esc(it.label) + '：' + esc(it.detail) + '</div>';
    });
    if (!bad.length) html += '<div class="ok">✓ 全部通过</div>';
    html += '</div></div></details>';
  }

  /* 历史 */
  if (state.jobs && state.jobs.length) {
    html += '<details><summary>最近生成<em>' + esc(state.jobs.length) + '</em></summary><div class="dbody"><div class="hist">';
    state.jobs.slice(0, 10).forEach(function(item){
      var title = (item.plan && item.plan.title) ? '《' + item.plan.title + '》' : item.id;
      html += '<button data-open="' + esc(item.id) + '">'
        + '<b>' + esc(title) + '</b>'
        + '<span class="st">' + esc(item.status) + (item.stageLabel ? ' · ' + item.stageLabel : '') + '</span>'
        + '</button>';
    });
    html += '</div></div></details>';
  }

  rail.innerHTML = html;
  rail.querySelectorAll('[data-open]').forEach(function(btn){
    btn.addEventListener('click', function(){ openJob(btn.dataset.open); });
  });
}

/* ---------------- 右栏 ---------------- */
function shotStatus(shot){
  if (shot.video) return { text: '视频 ✓', cls: 'ok' };
  if (shot.videoStatus === 'running') return { text: '渲染中', cls: 'run' };
  if (shot.frame) return { text: '静帧 ✓', cls: 'ok' };
  if (shot.frameStatus === 'running') return { text: '出图中', cls: 'run' };
  if (shot.frameStatus === 'failed' || shot.videoStatus === 'failed') return { text: '失败', cls: 'bad' };
  return { text: '待渲染', cls: '' };
}

function renderMain(){
  const job = state.job;
  const plan = (job && job.plan) || state.plan;
  const main = $('main');

  if (!plan) { main.innerHTML = ''; return; }

  var shots = (job && job.shots && job.shots.length) ? job.shots : (plan.shots || []);
  var total = shots.reduce(function(a, s){ return a + (Number(s.seconds) || 0); }, 0);
  var hasFilm = job && job.status === 'done' && job.file;

  var html = '';

  /* 成片条 */
  html += '<div class="film"><div class="stagebox">';
  if (hasFilm) {
    html += '<video id="film" controls preload="metadata" poster="' + (shots[0] && shots[0].frame ? API + '/frame-img?id=' + encodeURIComponent(job.id) + '&index=' + shots[0].index : '') + '"'
      + ' src="' + API + '/media?id=' + encodeURIComponent(job.id) + '&v=' + esc(job.updatedAt || '') + '"></video>';
  } else if (shots[0] && shots[0].frame) {
    html += '<img class="poster" src="' + API + '/frame-img?id=' + encodeURIComponent(job.id) + '&index=' + shots[0].index + '" alt="">';
  } else {
    html += '<div class="empty">还没有成片</div>';
  }
  html += '</div><div class="film-side">';
  html += '<div class="big">《' + esc(plan.title || '未命名') + '》</div>';
  html += '<div class="kv"><span>总时长</span><b>' + esc(total.toFixed(1)) + ' s</b></div>';
  html += '<div class="kv"><span>镜头</span><b>' + esc(shots.length + ' 镜 / ' + (plan.scenes ? plan.scenes.length : 0) + ' 场') + '</b></div>';
  if (job && job.song && job.song.duration) html += '<div class="kv"><span>歌曲</span><b>' + esc(Math.round(job.song.duration) + ' s') + '</b></div>';
  if (job && job.status) html += '<div class="kv"><span>状态</span><b>' + esc(job.status + (job.stageLabel ? ' · ' + job.stageLabel : '')) + '</b></div>';
  if (job && job.stitchMode) html += '<div class="kv"><span>拼接</span><b>' + esc(job.stitchMode) + '</b></div>';
  if (job && job.error) html += '<div class="note" style="color:#c6353c">' + esc(job.error) + '</div>';
  html += '<div class="film-actions">';
  if (hasFilm) {
    html += '<a class="btn" target="_blank" rel="noreferrer" href="' + API + '/media?id=' + encodeURIComponent(job.id) + '">打开原文件</a>';
    html += '<button class="btn" data-act="stitch">重新合成</button>';
  }
  if (job) {
    html += '<a class="btn" target="_blank" rel="noreferrer" href="' + API + '/book?id=' + encodeURIComponent(job.id) + '">导演本</a>';
    html += '<a class="btn" target="_blank" rel="noreferrer" href="' + API + '/board?id=' + encodeURIComponent(job.id) + '">分镜板</a>';
    html += '<a class="btn" href="' + API + '/export?id=' + encodeURIComponent(job.id) + '">导出方案</a>';
  }
  html += '</div>';
  if (job && job.song && job.song.file) {
    html += '<audio controls preload="none" style="width:100%;height:30px;margin-top:6px" src="' + API + '/song?id=' + encodeURIComponent(job.id) + '"></audio>';
  }
  html += '</div></div>';

  /* 时间轴 */
  if (shots.length) {
    html += '<div class="strip">';
    shots.forEach(function(shot, i){
      var w = Math.max(4, Number(shot.seconds) || 5);
      var cls = 'seg s' + ((i % 4) + 1);
      if (state.current === shot.index) cls += ' on';
      html += '<div class="' + cls + '" style="flex-grow:' + w + '" data-jump="' + esc(shot.index) + '" title="第 ' + esc(shot.index + 1) + ' 镜 · ' + esc(shot.seconds) + 's">'
        + '<span>' + esc((shot.index + 1) + ' · ' + Number(shot.seconds || 0).toFixed(1) + 's') + '</span></div>';
    });
    html += '</div>';
  }

  /* 镜卡 */
  if (shots.length) {
    html += '<div class="shots">';
    shots.forEach(function(shot){
      var st = shotStatus(shot);
      var img = shot.frame ? API + '/frame-img?id=' + encodeURIComponent(job.id) + '&index=' + shot.index + '&v=' + esc(shot.frameAt || '') : '';
      html += '<div class="shot' + (state.current === shot.index ? ' on' : '') + '" id="shot-' + esc(shot.index) + '">';
      html += '<div class="top"><span class="no">' + esc(shot.index + 1) + '</span>'
        + '<span class="dur">' + esc(Number(shot.start || 0).toFixed(1)) + '–' + esc(Number(shot.end || 0).toFixed(1)) + 's</span>'
        + '<span class="badge ' + st.cls + '">' + esc(st.text) + '</span></div>';
      html += '<button class="thumb" data-open-shot="' + esc(shot.index) + '">';
      if (img) html += '<img loading="lazy" src="' + img + '" alt="">';
      else html += '<div class="ph">（还没出图）</div>';
      if (shot.sceneNo) html += '<span class="sect">第 ' + esc(shot.sceneNo) + ' 场</span>';
      html += '</button>';
      html += '<div class="cap"><div class="tags">';
      if (shot.size) html += '<span class="tag">' + esc(shot.size) + '</span>';
      if (shot.move) html += '<span class="tag">' + esc(shot.move) + '</span>';
      if (shot.composition === 'ots') html += '<span class="tag hot">过肩</span>';
      if (shot.form === 'beast') html += '<span class="tag hot">本体</span>';
      if (shot.prop) html += '<span class="tag">' + esc(shot.prop) + '</span>';
      html += '</div><div class="act">' + esc(shot.action || '') + '</div>';
      html += '<div class="ops">';
      if (job) {
        html += '<button class="btn" data-act="reframe" data-index="' + esc(shot.index) + '">🔄 换一张</button>';
        html += '<button class="btn" data-act="params" data-index="' + esc(shot.index) + '">⚙ 参数</button>';
        if (shot.video) html += '<button class="btn" data-act="play" data-index="' + esc(shot.index) + '">▶ 看这段</button>';
      }
      html += '</div></div></div>';
    });
    html += '</div>';
  }

  main.innerHTML = html;

  main.querySelectorAll('[data-jump]').forEach(function(el){
    el.addEventListener('click', function(){
      var idx = Number(el.dataset.jump);
      var card = document.getElementById('shot-' + idx);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      state.current = idx;
    });
  });
  main.querySelectorAll('[data-open-shot]').forEach(function(el){
    el.addEventListener('click', function(){ openDrawer(Number(el.dataset.openShot)); });
  });
  main.querySelectorAll('[data-act]').forEach(function(el){
    el.addEventListener('click', function(){ onAction(el.dataset.act, el.dataset.index); });
  });
}

/* ---------------- 抽屉：单镜参数 ---------------- */
function openDrawer(index){
  const job = state.job;
  if (!job) { toast('还没有任务'); return; }
  const shot = (job.shots || []).find(function(s){ return s.index === index; });
  if (!shot) return;
  state.current = index;

  function opts(list, value){
    return list.map(function(v){
      return '<option' + (v === value ? ' selected' : '') + '>' + esc(v) + '</option>';
    }).join('');
  }

  var html = '<h3>第 ' + esc(index + 1) + ' 镜 · 参数<button data-close="1">✕</button></h3>';
  html += '<div class="dr-grid">';
  html += '<label class="field"><span>景别</span><select data-f="size">' + opts(SIZES, shot.size) + '</select></label>';
  html += '<label class="field"><span>机身</span><select data-f="horizontal">' + opts(HORS, shot.horizontal) + '</select></label>';
  html += '<label class="field"><span>俯仰</span><select data-f="elevation">' + opts(ELEVS, shot.elevation) + '</select></label>';
  html += '<label class="field"><span>运镜</span><select data-f="move">' + opts(MOVES, shot.move) + '</select></label>';
  html += '<label class="field"><span>灯光</span><select data-f="light">' + opts(LIGHTS, shot.light) + '</select></label>';
  html += '<label class="field"><span>景深</span><select data-f="dof">' + opts(DOFS, shot.dof) + '</select></label>';
  html += '<label class="field"><span>转场</span><select data-f="transition">' + opts(TRANS, shot.transition) + '</select></label>';
  html += '<label class="field"><span>时长</span><input type="number" step="0.1" min="2" max="15" data-f="seconds" value="' + esc(shot.seconds) + '"></label>';
  html += '</div>';
  html += '<label class="field" style="margin-top:8px"><span>动作（画面里发生什么）</span><textarea data-f="action">' + esc(shot.action || '') + '</textarea></label>';
  html += '<div class="film-actions" style="margin-top:10px">'
    + '<button class="btn primary" data-save="1">保存</button>'
    + '<button class="btn" data-save-reframe="1">保存并重出这张</button>'
    + '<button class="btn" data-close="1">取消</button></div>';
  if (shot.framePromptText) {
    html += '<div class="note" style="max-height:120px;overflow:auto">出图提示词：' + esc(shot.framePromptText) + '</div>';
  }
  if (shot.error) html += '<div class="note" style="color:#c6353c">上次失败：' + esc(shot.error) + '</div>';

  const drawer = $('drawer');
  drawer.innerHTML = html;
  drawer.classList.add('on');
  drawer.querySelectorAll('[data-close]').forEach(function(el){ el.addEventListener('click', closeDrawer); });
  drawer.querySelectorAll('[data-save]').forEach(function(el){ el.addEventListener('click', function(){ saveShot(index, false); }); });
  drawer.querySelectorAll('[data-save-reframe]').forEach(function(el){ el.addEventListener('click', function(){ saveShot(index, true); }); });
  renderMain();
}
function closeDrawer(){ $('drawer').classList.remove('on'); }

function collectPatch(){
  const patch = {};
  document.querySelectorAll('#drawer [data-f]').forEach(function(el){
    var key = el.dataset.f;
    var value = el.value;
    if (key === 'seconds') value = Number(value);
    patch[key] = value;
  });
  return patch;
}

async function saveShot(index, rerender){
  try {
    state.busy = '保存参数…';
    renderBusy();
    await api('/shot', { method: 'POST', body: JSON.stringify({ id: state.job.id, index: index, patch: collectPatch() }) });
    await refreshJob();
    closeDrawer();
    if (rerender) {
      toast('参数已存，正在重出这张（几十秒）');
      await api('/frame', { method: 'POST', body: JSON.stringify({ id: state.job.id, index: index }) });
      await refreshJob();
      toast('这张重出好了');
    } else {
      toast('参数已保存');
    }
  } catch (err) {
    toast('失败：' + err.message);
  } finally {
    state.busy = '';
    renderBusy();
  }
}

/* ---------------- 动作 ---------------- */
async function onAction(act, index){
  if (act === 'params') { openDrawer(Number(index)); return; }
  if (act === 'reframe') {
    try {
      state.busy = '重出第 ' + (Number(index) + 1) + ' 张静帧…';
      renderBusy();
      await api('/frame', { method: 'POST', body: JSON.stringify({ id: state.job.id, index: Number(index) }) });
      await refreshJob();
      toast('已重出');
    } catch (err) { toast('失败：' + err.message); }
    finally { state.busy = ''; renderBusy(); }
    return;
  }
  if (act === 'play') { playClip(Number(index)); return; }
  if (act === 'stitch') {
    try {
      state.busy = '重新拼接…';
      renderBusy();
      await api('/stitch', { method: 'POST', body: JSON.stringify({ id: state.job.id }) });
      await refreshJob();
      toast('合成完成');
    } catch (err) { toast('失败：' + err.message); }
    finally { state.busy = ''; renderBusy(); }
  }
}

function playClip(index){
  const job = state.job;
  if (!job) return;
  const drawer = $('drawer');
  drawer.innerHTML = '<h3>第 ' + esc(index + 1) + ' 镜 · 成片<button data-close="1">✕</button></h3>'
    + '<video controls autoplay style="width:100%;border-radius:8px;background:#000" src="' + API + '/clip?id=' + encodeURIComponent(job.id) + '&index=' + index + '&v=' + esc(Date.now()) + '"></video>';
  drawer.classList.add('on');
  drawer.querySelectorAll('[data-close]').forEach(function(el){ el.addEventListener('click', closeDrawer); });
}

function renderBusy(){ $('busy-line').textContent = state.busy || ''; }

/* ---------------- 数据 ---------------- */
async function refreshJob(){
  if (!state.job) return;
  try {
    const job = await api('/job?id=' + encodeURIComponent(state.job.id));
    state.job = job;
    try { state.lint = await api('/lint?id=' + encodeURIComponent(job.id)); } catch { /* 没这个路由就算了 */ }
    renderAll();
    schedule();
  } catch (err) { /* 客户端掉线时别刷屏 */ }
}
function schedule(){
  clearTimeout(state.timer);
  const job = state.job;
  if (!job) return;
  const running = job.status === 'running' || (job.shots || []).some(function(s){
    return s.frameStatus === 'running' || s.videoStatus === 'running';
  });
  if (running) state.timer = setTimeout(refreshJob, 4000);
}

async function openJob(id){
  try {
    state.job = await api('/job?id=' + encodeURIComponent(id));
    history.replaceState(null, '', '?id=' + encodeURIComponent(id));
    await refreshJob();
  } catch (err) { toast('打不开这个任务：' + err.message); }
}

function renderAll(){
  try {
    renderTop(); renderRail(); renderMain();
  } catch (error) {
    document.title = 'ERR ' + ((error && error.message) || error);
    console.error(error);
  }
}

/* ---------------- 动作：剧本 / 跑 ---------------- */
function readCfg(){
  return {
    theme: $('theme').value.trim(),
    duration: Number($('duration').value) || 60,
    aspectRatio: $('aspectRatio').value,
    frameMegapixels: Number($('frameMegapixels').value) || 8,
    megapixels: Number($('megapixels').value) || 0.4,
  };
}

async function makePlan(){
  const cfg = readCfg();
  if (!cfg.theme) { toast('先写一句主题'); return; }
  try {
    state.busy = '写剧本中…（20–60 秒）';
    renderBusy();
    const out = await api('/plan', { method: 'POST', body: JSON.stringify(cfg) });
    state.plan = out.plan;
    state.job = null;
    state.lint = out.lint || null;
    renderAll();
    toast('剧本好了：' + (out.plan.shots || []).length + ' 镜');
  } catch (err) { toast('失败：' + err.message); }
  finally { state.busy = ''; renderBusy(); }
}

async function runAll(){
  const cfg = readCfg();
  const plan = state.plan || (state.job && state.job.plan);
  if (!plan) { toast('先生成剧本'); return; }
  if (!plan.lyrics && !cfg.theme) { toast('剧本里没有歌词，无法出歌'); return; }
  try {
    state.busy = '已提交，正在跑…（开跑后可以关掉这个页面）';
    renderBusy();
    const out = await api('/run', {
      method: 'POST',
      body: JSON.stringify(Object.assign({}, cfg, {
        plan: plan,
        lyrics: plan.lyrics,
        style: plan.style,
        shotCount: (plan.shots || []).length,
        duration: plan.duration || cfg.duration,
      })),
    });
    toast('开跑了：' + out.job.id);
    await openJob(out.job.id);
  } catch (err) { toast('失败：' + err.message); }
  finally { state.busy = ''; renderBusy(); }
}

async function resume(){
  const job = state.job;
  if (!job) return;
  const btn = $('btn-resume');
  const phase = btn.dataset.phase || 'videos';
  try {
    state.busy = '继续：' + phase;
    renderBusy();
    await api('/continue', { method: 'POST', body: JSON.stringify({ id: job.id, phase: phase }) });
    await refreshJob();
    toast('继续跑起来了');
  } catch (err) { toast('失败：' + err.message); }
  finally { state.busy = ''; renderBusy(); }
}

function importPlan(){
  $('file-import').click();
}
async function onImportFile(event){
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const out = await api('/import', { method: 'POST', body: JSON.stringify({ project: JSON.parse(text) }) });
    state.plan = out.plan;
    state.job = null;
    state.lint = null;
    renderAll();
    toast('方案已导入：' + (out.plan.shots || []).length + ' 镜');
  } catch (err) { toast('导入失败：' + err.message); }
  event.target.value = '';
}

function newProject(){
  if (!window.confirm('清掉当前剧本，从零开始？')) return;
  state.plan = null;
  state.job = null;
  state.lint = null;
  $('theme').value = '';
  history.replaceState(null, '', location.pathname);
  renderAll();
}

/* ---------------- 启动 ---------------- */
(function boot(){
  const meta = state.meta;
  const job = state.job;
  const plan = (job && job.plan) || null;

  const params = (job && job.params) || {};
  $('theme').value = params.theme || '';
  $('duration').value = params.duration || (plan && plan.duration) || 60;
  if (params.aspectRatio) $('aspectRatio').value = params.aspectRatio;
  $('frameMegapixels').value = params.frameMegapixels || 8;
  $('megapixels').value = params.megapixels || 0.4;

  $('btn-plan').addEventListener('click', makePlan);
  $('btn-run').addEventListener('click', runAll);
  $('btn-resume').addEventListener('click', resume);
  $('btn-import').addEventListener('click', importPlan);
  $('btn-new').addEventListener('click', newProject);
  $('file-import').addEventListener('change', onImportFile);
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') closeDrawer(); });

  if (!state.meta) {
    api('/meta').then(function(m){ state.meta = m; renderTop(); }).catch(function(){});
  }
  if (!state.jobs.length) {
    api('/jobs?limit=20').then(function(out){ state.jobs = out.jobs || []; renderRail(); }).catch(function(){});
  }

  renderAll();
  schedule();
})();
</script>
</body>
</html>`;
}
