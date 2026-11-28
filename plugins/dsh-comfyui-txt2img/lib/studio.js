// 文生图 web 工作台（单文件页面，数据走 /api/comfyui-txt2img/*）
import { page, escapeJson } from './studio-kit.js';

const ASPECTS = [
  ['1:1 (Square)', '1:1'],
  ['16:9 (Widescreen)', '16:9'],
  ['9:16 (Portrait)', '9:16'],
  ['4:3 (Standard)', '4:3'],
  ['3:4 (Portrait)', '3:4'],
  ['3:2 (Photo)', '3:2'],
  ['2:3 (Portrait Photo)', '2:3'],
  ['21:9 (Ultrawide)', '21:9'],
];

const DEFAULT_CFG = {
  aspectRatio: '1:1 (Square)',
  megapixels: 1,
  batchSize: 1,
  steps: 8,
  cfg: 1,
  seed: '',
  expand: true,
  loraEnabled: false,
  loraName: '',
  loraStrength: 0.8,
  suffixEnabled: false,
  styleSuffix: '',
};

function railHTML(meta, seed) {
  const loras = (meta && Array.isArray(meta.loras)) ? meta.loras : [];
  const loraOptions = loras.map((l) => `<option value="${l}">${l.replace('.safetensors', '')}</option>`).join('');
  const aspectOptions = ASPECTS.map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
  return `
  <div class="card">
    <h2>提示词</h2>
    <div class="field">
      <textarea id="prompt" placeholder="描述画面：主体、动作、场景、光线、材质、镜头。中文可以直接写。"></textarea>
    </div>
    <div class="actions">
      <button class="btn primary" id="btnGen">生成</button>
      <button class="btn" id="btnPolish">✨ 润化</button>
      <button class="btn ghost" id="btnUndo" disabled>↩ 撤销润化</button>
    </div>
    <div class="note" id="polishNote" style="margin-top:8px"></div>
  </div>

  <div class="card">
    <h2 class="fold"><span class="caret">▾</span>参数</h2>
    <div class="foldbody">
      <div class="row">
        <div class="field"><label>比例</label><select id="aspectRatio">${aspectOptions}</select></div>
        <div class="field"><label>像素(MP)</label><input type="number" id="megapixels" min="0.2" max="6" step="0.1"></div>
      </div>
      <div class="row">
        <div class="field"><label>张数</label><input type="number" id="batchSize" min="1" max="4" step="1"></div>
        <div class="field"><label>步数</label><input type="number" id="steps" min="1" max="40" step="1"></div>
      </div>
      <div class="row">
        <div class="field"><label>CFG</label><input type="number" id="cfg" min="0" max="10" step="0.1"></div>
        <div class="field"><label>种子</label>
          <div style="display:flex;gap:6px">
            <input type="text" id="seed" placeholder="随机">
            <button class="btn tiny" id="btnSeed" title="随机一个种子">🎲</button>
          </div>
        </div>
      </div>
      <div class="field"><label>LoRA</label>
        <select id="loraName"><option value="">不用 LoRA</option>${loraOptions}</select>
      </div>
      <div class="row">
        <div class="field"><label>LoRA 强度</label><input type="number" id="loraStrength" min="0" max="1.5" step="0.05"></div>
      </div>
      <label class="note" style="display:flex;gap:6px;align-items:center;margin:2px 0 8px">
        <input type="checkbox" id="suffixEnabled" style="width:auto"> 追加风格后缀
      </label>
      <div class="field"><input type="text" id="styleSuffix" placeholder="muted minimalist sketch style"></div>
      <label class="note" style="display:flex;gap:6px;align-items:center">
        <input type="checkbox" id="expand" style="width:auto"> AI 扩写提示词（ComfyUI 内）
      </label>
    </div>
  </div>

  <div class="card">
    <h2 class="fold"><span class="caret">▾</span>最近生成<span class="hint" id="histCount"></span></h2>
    <div class="foldbody"><div class="hist" id="hist"><div class="note">还没有任务</div></div></div>
  </div>
  <div class="note">ComfyUI <span id="cVer">—</span> · 空闲 <span id="cVram">—</span> GB</div>
  <div class="note" style="opacity:.7">改动会自动存在本机表单里；服务端改了要重启 DSH。</div>`;
}

const MAIN_HTML = `
  <div class="card" id="statusCard" style="display:none">
    <h2>任务 <span class="hint" id="jobId"></span></h2>
    <div class="kv" id="jobKv"></div>
  </div>
  <div id="gallery"></div>
  <div class="card" id="emptyCard">
    <h2>还没有图</h2>
    <div class="note">左边写好提示词，点「生成」。结果会出现在这里，点图看大图。</div>
  </div>`;

function scriptHTML(seed) {
  return `
const API = '/api/comfyui-txt2img';
const FORM_KEY = 'comfyui-txt2img.studio.form.v1';
const state = { id: '', job: null, busy: false, prevPrompt: '' };
const $ = (id) => document.getElementById(id);

function readForm() {
  return {
    prompt: $('prompt').value,
    aspectRatio: $('aspectRatio').value,
    megapixels: Number($('megapixels').value) || 1,
    batchSize: Number($('batchSize').value) || 1,
    steps: Number($('steps').value) || 8,
    cfg: Number($('cfg').value) || 1,
    seed: $('seed').value.trim(),
    loraName: $('loraName').value,
    loraStrength: Number($('loraStrength').value) || 0,
    loraEnabled: !!$('loraName').value,
    suffixEnabled: $('suffixEnabled').checked,
    styleSuffix: $('styleSuffix').value,
    expand: $('expand').checked,
  };
}

function writeForm(cfg) {
  const c = Object.assign({}, ${escapeJson(DEFAULT_CFG)}, cfg || {});
  $('aspectRatio').value = c.aspectRatio || '1:1 (Square)';
  $('megapixels').value = c.megapixels;
  $('batchSize').value = c.batchSize;
  $('steps').value = c.steps;
  $('cfg').value = c.cfg;
  $('seed').value = c.seed || '';
  $('loraName').value = c.loraName || '';
  $('loraStrength').value = c.loraStrength;
  $('suffixEnabled').checked = !!c.suffixEnabled;
  $('styleSuffix').value = c.styleSuffix || '';
  $('expand').checked = c.expand !== false;
  if (c.prompt) $('prompt').value = c.prompt;
}

function saveForm() {
  try {
    const form = readForm();
    window.localStorage.setItem(FORM_KEY, JSON.stringify(form));
  } catch (e) {}
}

function restoreForm() {
  try {
    const raw = window.localStorage.getItem(FORM_KEY);
    if (!raw) { writeForm({}); return; }
    writeForm(JSON.parse(raw) || {});
  } catch (e) { writeForm({}); }
}

function setBusy(on, text) {
  state.busy = on;
  $('btnGen').disabled = on;
  $('btnGen').textContent = on ? (text || '生成中…') : '生成';
}

async function loadMeta() {
  try {
    const meta = await MVK.api(API + '/meta');
    const c = meta.comfyui || {};
    $('cVer').textContent = c.version || (c.online === false ? '离线' : '—');
    $('cVram').textContent = c.vramFreeGB === undefined ? '—' : Number(c.vramFreeGB).toFixed(1);
  } catch (e) {
    $('cVer').textContent = '读取失败';
  }
}

function renderJob(job) {
  state.job = job;
  if (!job || !job.id) return;
  const status = String(job.status || '');
  $('statusCard').style.display = '';
  $('jobId').textContent = job.id + (job.elapsedSeconds ? ' · ' + MVK.fmt(job.elapsedSeconds) : '');
  const kv = [];
  kv.push('<b>状态</b><span>' + MVK.statusChip(status) + '</span>');
  if (job.error) kv.push('<b>错误</b><span style="color:#a12626">' + MVK.esc(job.error) + '</span>');
  $('jobKv').innerHTML = kv.join('');

  const gallery = $('gallery');
  const files = Array.isArray(job.files) ? job.files : [];
  if (!files.length) {
    $('emptyCard').style.display = '';
    gallery.innerHTML = '';
    return;
  }
  $('emptyCard').style.display = 'none';
  const seed = (job.params && job.params.seed) || '';
  gallery.innerHTML = '<div class="card"><h2>结果 <span class="hint">' + files.length + ' 张' + (seed !== '' ? ' · seed ' + MVK.esc(seed) : '') + '</span></h2><div class="grid" id="g"></div></div>';
  const g = $('g');
  files.forEach((f, i) => {
    const url = API + '/media?id=' + encodeURIComponent(job.id) + '&i=' + i;
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.innerHTML = '<div class="ph"><img loading="lazy" src="' + url + '" alt=""></div>' +
      '<div class="bd"><div class="meta"><span class="tag">#' + (i + 1) + '</span>' +
      (job.summary ? '<span class="tag">' + MVK.esc(job.summary.aspectRatio || '') + '</span><span class="tag">' + MVK.esc(job.summary.megapixels || '') + ' MP</span>' : '') +
      '</div><div class="actions"><button class="btn tiny" data-save="' + url + '">下载</button>' +
      '<button class="btn tiny" data-seed="' + MVK.esc(String(seed)) + '">用这个种子</button></div></div>';
    g.appendChild(tile);
    tile.querySelector('img').onclick = () => MVK.lightbox(url);
  });
  g.querySelectorAll('[data-save]').forEach((b) => {
    b.onclick = () => {
      const a = document.createElement('a');
      a.href = b.getAttribute('data-save');
      a.download = job.id + '-img.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
  });
  g.querySelectorAll('[data-seed]').forEach((b) => {
    b.onclick = () => { $('seed').value = b.getAttribute('data-seed'); saveForm(); MVK.toast('种子已填入'); };
  });
}

async function refreshJob() {
  if (!state.id) return;
  try {
    const job = await MVK.api(API + '/job?id=' + encodeURIComponent(state.id));
    renderJob(job);
    if (job.status === 'running' || job.status === 'queued') return;
    if (state.polling) { state.polling(); state.polling = null; }
    setBusy(false);
  } catch (e) { /* 忽略 */ }
}

async function generate() {
  if (state.busy) return;
  const form = readForm();
  if (!String(form.prompt || '').trim()) { MVK.toast('先写提示词', 'bad'); return; }
  saveForm();
  setBusy(true, '提交中…');
  try {
    const body = Object.assign({}, form);
    if (!body.seed) delete body.seed;
    if (!body.suffixEnabled) body.styleSuffix = '';
    if (!body.loraEnabled) body.loraName = '';
    const data = await MVK.api(API + '/run', { method: 'POST', body });
    state.id = data.job.id;
    setBusy(true, '生成中…');
    await refreshJob();
    if (state.polling) state.polling();
    state.polling = MVK.poll(refreshJob, 3000);
    loadHistory();
  } catch (e) {
    setBusy(false);
    MVK.toast(String(e.message || e), 'bad');
  }
}

async function polish() {
  const prompt = $('prompt').value.trim();
  if (!prompt) { MVK.toast('先写提示词', 'bad'); return; }
  $('btnPolish').disabled = true;
  $('polishNote').textContent = '润化中…';
  try {
    const data = await MVK.api(API + '/polish', { method: 'POST', body: { prompt, loraName: $('loraName').value } });
    const next = data.prompt || data.text || '';
    if (!next) throw new Error('润化没有返回内容');
    state.prevPrompt = prompt;
    $('prompt').value = next;
    $('btnUndo').disabled = false;
    $('polishNote').textContent = '已润化，可以再点一次继续，或者撤销。';
    saveForm();
  } catch (e) {
    $('polishNote').textContent = '';
    MVK.toast(String(e.message || e), 'bad');
  } finally {
    $('btnPolish').disabled = false;
  }
}

function undoPolish() {
  if (!state.prevPrompt) return;
  $('prompt').value = state.prevPrompt;
  state.prevPrompt = '';
  $('btnUndo').disabled = true;
  $('polishNote').textContent = '';
  saveForm();
}

async function loadHistory() {
  try {
    const data = await MVK.api(API + '/jobs');
    const jobs = (data.jobs || []).slice(0, 12);
    const box = $('hist');
    $('histCount').textContent = jobs.length ? jobs.length + ' 条' : '';
    if (!jobs.length) { box.innerHTML = '<div class="note">还没有任务</div>'; return; }
    box.innerHTML = '';
    jobs.forEach((j) => {
      const it = document.createElement('div');
      it.className = 'it' + (j.id === state.id ? ' on' : '');
      const first = j.files && j.files[0] ? API + '/media?id=' + encodeURIComponent(j.id) + '&i=0' : '';
      it.innerHTML = '<div style="display:flex;gap:8px;align-items:center">' +
        (first ? '<img src="' + first + '" style="width:44px;height:30px;object-fit:cover;border-radius:5px;background:#eee">' : '') +
        '<div style="min-width:0"><div class="t">' + MVK.esc(j.id) + ' · ' + MVK.esc(j.status) + '</div>' +
        '<div class="m">' + MVK.ago(j.createdAt) + (j.count ? ' · ' + j.count + ' 张' : '') + '</div></div></div>';
      it.onclick = () => { state.id = j.id; renderJob(j); loadHistory(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
      box.appendChild(it);
    });
  } catch (e) { /* 忽略 */ }
}

restoreForm();
MVK.bindFolds();
$('btnGen').onclick = generate;
$('btnPolish').onclick = polish;
$('btnUndo').onclick = undoPolish;
$('btnSeed').onclick = () => { $('seed').value = String(Math.floor(Math.random() * 1e9)); saveForm(); };
['prompt','aspectRatio','megapixels','batchSize','steps','cfg','seed','loraName','loraStrength','styleSuffix'].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener('change', saveForm);
});
$('suffixEnabled').addEventListener('change', saveForm);
$('expand').addEventListener('change', saveForm);
$('prompt').addEventListener('input', () => { clearTimeout(window.__sv); window.__sv = setTimeout(saveForm, 500); });
loadMeta();
loadHistory();
`;
}

export function renderStudio({ meta } = {}) {
  return page({
    title: '文生图',
    sub: 'Krea2 Turbo · 提示词 → 图',
    right: `<span class="chip" id="chipComfy">ComfyUI</span>`,
    rail: railHTML(meta, {}),
    main: MAIN_HTML,
    script: scriptHTML({}),
  });
}
