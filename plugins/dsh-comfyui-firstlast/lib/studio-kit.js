// studio-kit —— 所有 comfyui 插件 web 工作台共用的壳。
// 同步源：plugins/dsh-comfyui-txt2img/lib/studio-kit.js（改这里，然后复制到其它插件）。
// 设计约束：零构建、零依赖、单文件；服务端只出 HTML，交互全在前端原生 JS。

export function escapeJson(value) {
  return JSON.stringify(value === undefined ? null : value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export const KIT_CSS = `
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:#f4f5f7;color:#1b1d22;font:14px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
a{color:#3f5bd9;text-decoration:none}
.app{display:flex;flex-direction:column;height:100%;min-height:100%}
.top{display:flex;align-items:center;gap:10px;padding:10px 16px;background:#fff;border-bottom:1px solid #e6e8ec;position:sticky;top:0;z-index:30}
.top h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.2px}
.top .sub{color:#8a8f99;font-size:12px}
.top .right{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.chip{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;background:#eef0f4;color:#4a4f58;font-size:12px;white-space:nowrap}
.chip.ok{background:#e8f6ee;color:#1f7a45}
.chip.warn{background:#fdf1e3;color:#9a5b12}
.chip.bad{background:#fdeaea;color:#a12626}
.chip.acc{background:#e9edff;color:#3b4fd1}
.wrap{flex:1;display:grid;grid-template-columns:342px minmax(0,1fr);gap:18px;padding:16px;align-items:start;min-height:0}
.rail{display:flex;flex-direction:column;gap:12px;position:sticky;top:60px;max-height:calc(100vh - 76px);overflow:auto;padding-right:2px}
.main{display:flex;flex-direction:column;gap:14px;min-width:0}
.card{background:#fff;border:1px solid #e6e8ec;border-radius:12px;padding:14px}
.card h2{font-size:13px;margin:0 0 10px;font-weight:600;color:#2b2f36;display:flex;align-items:center;gap:8px}
.card h2 .hint{font-weight:400;color:#9aa0a8;font-size:12px}
.fold{cursor:pointer;user-select:none}
.fold .caret{color:#a8adb6;font-size:11px;transition:transform .15s}
.fold.closed .caret{transform:rotate(-90deg)}
.fold.closed + .foldbody{display:none}
.field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px}
.field > label{font-size:12px;color:#7b818b}
.row{display:flex;gap:8px}
.row > *{flex:1;min-width:0}
input[type=text],input[type=number],textarea,select{width:100%;padding:7px 9px;border:1px solid #dcdfe5;border-radius:8px;background:#fff;font:inherit;color:inherit;outline:none}
input:focus,textarea:focus,select:focus{border-color:#8fa2ff;box-shadow:0 0 0 3px rgba(91,107,255,.12)}
textarea{resize:vertical;min-height:76px;line-height:1.6}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:7px 12px;border-radius:8px;border:1px solid #dcdfe5;background:#fff;color:#333;font:inherit;cursor:pointer;white-space:nowrap}
.btn:hover{border-color:#c2c7d1;background:#fafbfc}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn.primary{background:#4f63e8;border-color:#4f63e8;color:#fff}
.btn.primary:hover{background:#4457d6;border-color:#4457d6}
.btn.ghost{border-color:transparent;background:#f2f3f6;color:#4b5058}
.btn.tiny{padding:4px 9px;font-size:12px;border-radius:7px}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.note{font-size:12px;color:#8a8f99;line-height:1.6}
.err{background:#fdeaea;color:#a12626;border-radius:8px;padding:8px 10px;font-size:12px;white-space:pre-wrap;word-break:break-word}
.ok{background:#e8f6ee;color:#1f7a45;border-radius:8px;padding:8px 10px;font-size:12px;word-break:break-all}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.tile{background:#fff;border:1px solid #e6e8ec;border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.tile .ph{position:relative;background:#0f1115;aspect-ratio:16/10;display:flex;align-items:center;justify-content:center;overflow:hidden}
.tile .ph img,.tile .ph video{width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in}
.tile .ph .ph-empty{color:#5d6470;font-size:12px}
.tile .bd{padding:10px;display:flex;flex-direction:column;gap:8px}
.tile .meta{font-size:12px;color:#6c727c;display:flex;gap:8px;flex-wrap:wrap}
.tile .body{font-size:13px;color:#2b2f36;line-height:1.55;max-height:4.6em;overflow:hidden}
.tag{display:inline-block;padding:1px 7px;border-radius:999px;background:#eef0f4;color:#4a4f58;font-size:11px}
.tag.acc{background:#e9edff;color:#3b4fd1}
.tag.warn{background:#fdf1e3;color:#9a5b12}
.kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px}
.kv b{font-weight:500;color:#7b818b;font-size:12px}
.kv span{color:#22262c;word-break:break-word}
.slots{display:flex;flex-direction:column;gap:8px}
.slot{display:flex;align-items:center;gap:8px;border:1px dashed #d7dbe2;border-radius:10px;padding:6px;background:#fafbfc}
.slot .thumb{width:56px;height:38px;border-radius:6px;background:#eceef2;object-fit:cover;flex:none}
.slot .grow{flex:1;min-width:0}
.slot .name{font-size:12px;color:#4a4f58;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.slot .acts{display:flex;gap:4px}
.hist{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow:auto}
.hist .it{display:flex;flex-direction:column;gap:2px;padding:7px 9px;border-radius:8px;cursor:pointer;border:1px solid transparent}
.hist .it:hover{background:#f6f7f9}
.hist .it.on{background:#eef2ff;border-color:#c9d3ff}
.hist .it .t{font-size:12px;color:#333}
.hist .it .m{font-size:11px;color:#9aa0a8}
.player{background:#0f1115;border-radius:12px;overflow:hidden}
.player video{width:100%;max-height:56vh;display:block;background:#000}
.audio{width:100%;margin-top:6px}
.lightbox{position:fixed;inset:0;background:rgba(9,10,12,.9);display:none;align-items:center;justify-content:center;z-index:100;cursor:zoom-out}
.lightbox.on{display:flex}
.lightbox img,.lightbox video{max-width:94vw;max-height:92vh;box-shadow:0 20px 60px rgba(0,0,0,.5);border-radius:6px}
.drawer{position:fixed;top:0;right:0;height:100%;width:420px;max-width:94vw;background:#fff;border-left:1px solid #e6e8ec;box-shadow:-12px 0 40px rgba(16,20,30,.12);transform:translateX(102%);transition:transform .18s ease;z-index:90;display:flex;flex-direction:column}
.drawer.on{transform:none}
.drawer .dh{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #eef0f3}
.drawer .dh b{font-size:13px}
.drawer .db{padding:14px;overflow:auto;flex:1}
.drawer .df{padding:12px 14px;border-top:1px solid #eef0f3;display:flex;gap:8px;justify-content:flex-end}
.toast{position:fixed;left:50%;bottom:26px;transform:translate(-50%,20px);background:#22262c;color:#fff;padding:9px 14px;border-radius:10px;font-size:13px;opacity:0;transition:.18s;z-index:120;max-width:80vw;word-break:break-word}
.toast.on{opacity:1;transform:translate(-50%,0)}
.toast.bad{background:#a12626}
.segbar{display:flex;gap:6px;overflow:auto}
.seg{border:1px solid #e6e8ec;background:#fff;border-radius:8px;padding:5px 8px;font-size:11px;color:#5b6169;white-space:nowrap}
.seg b{color:#22262c;font-weight:600}
.skeleton{height:12px;border-radius:6px;background:linear-gradient(90deg,#eef0f3,#f7f8fa,#eef0f3);background-size:200% 100%;animation:sk 1.2s infinite}
@keyframes sk{0%{background-position:0 0}100%{background-position:-200% 0}}
@media (max-width:1080px){.wrap{grid-template-columns:1fr}.rail{position:static;max-height:none}}
`;

export const KIT_JS = `
const MVK = (() => {
  async function api(path, opts) {
    const init = Object.assign({}, opts || {});
    if (init.body !== undefined && typeof init.body !== 'string') {
      init.body = JSON.stringify(init.body);
      init.headers = Object.assign({ 'content-type': 'application/json' }, init.headers || {});
    }
    const res = await fetch(path, init);
    const raw = await res.text();
    let data = null;
    if (raw) { try { data = JSON.parse(raw); } catch (e) { data = null; } }
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || ('HTTP ' + res.status);
      throw new Error(msg);
    }
    return data || {};
  }
  let toastTimer = 0;
  function toast(text, kind) {
    let el = document.querySelector('.toast');
    if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
    el.textContent = String(text || '');
    el.className = 'toast on' + (kind === 'bad' ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = 'toast'; }, kind === 'bad' ? 4200 : 2200);
  }
  function poll(fn, ms) {
    let stopped = false, timer = 0;
    async function tick() {
      if (stopped) return;
      try { await fn(); } catch (e) { /* 轮询失败不弹错 */ }
      if (!stopped) timer = setTimeout(tick, ms || 4000);
    }
    timer = setTimeout(tick, ms || 4000);
    return () => { stopped = true; clearTimeout(timer); };
  }
  function lightbox(src, kind) {
    let el = document.querySelector('.lightbox');
    if (!el) { el = document.createElement('div'); el.className = 'lightbox'; document.body.appendChild(el); }
    el.innerHTML = '';
    if (kind === 'video') {
      const v = document.createElement('video');
      v.src = src; v.controls = true; v.autoplay = true; v.playsInline = true;
      el.appendChild(v);
    } else {
      const img = document.createElement('img');
      img.src = src;
      el.appendChild(img);
    }
    el.classList.add('on');
    el.onclick = () => { el.classList.remove('on'); el.innerHTML = ''; };
  }
  function fmt(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(s / 60);
    return m ? m + ' 分 ' + (s % 60) + ' 秒' : s + ' 秒';
  }
  function ago(ts) {
    if (!ts) return '';
    const d = Math.max(0, Date.now() - ts) / 1000;
    if (d < 60) return '刚刚';
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
    if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
    return Math.floor(d / 86400) + ' 天前';
  }
  function esc(v) {
    return String(v === undefined || v === null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function bindFolds(root) {
    (root || document).querySelectorAll('.fold').forEach((el) => {
      el.onclick = () => el.classList.toggle('closed');
    });
  }
  function statusChip(status) {
    const s = String(status || '');
    const cls = s === 'done' ? 'ok' : (s === 'failed' ? 'bad' : (s === 'running' ? 'acc' : 'warn'));
    return '<span class="chip ' + cls + '">' + esc(s || '等待') + '</span>';
  }
  return { api, toast, poll, lightbox, fmt, ago, esc, bindFolds, statusChip };
})();
`;

// ---- 通用工作台：由一份 spec 生成「表单 + 素材槽 + 结果 + 历史」整页 ----
// spec = {
//   title, sub, apiBase,
//   fields: [{key,label,type:'text'|'textarea'|'number'|'select'|'check',options:[[v,label]],min,max,step,placeholder,default,hint}],
//   slots:  [{key,label,max,accept,upload:true,output:true,single:false}],
//   generate:{path:'/run', result:'video'|'image'|'audio'},
//   polish: {path:'/polish', field:'prompt'},
//   extra:  [{label:'生成歌词', path:'/lyrics', fill:'lyrics', body:{theme:'@lyricsTheme', style:'@style'}}],
//   note: '...'
// }
export function renderWorkbench(spec) {
  const s = spec || {};
  const fields = s.fields || [];
  const slots = s.slots || [];
  const gen = s.generate || { path: '/run', result: 'image' };
  const defaults = {};
  fields.forEach((f) => { defaults[f.key] = f.default; });
  const boot = {
    api: s.apiBase,
    fields: fields,
    slots: slots,
    gen: gen,
    polish: s.polish || null,
    extra: s.extra || [],
    defaults: defaults,
    formKey: 'studio.form.' + (s.apiBase || '').replace(/[^a-z0-9]+/gi, '.'),
  };
  const rail = `
  <div class="card">
    <h2>${s.railTitle || '输入'}</h2>
    <div id="form"></div>
    <div class="actions" id="formActions">
      <button class="btn primary" id="btnGen">生成</button>
    </div>
    <div class="note" id="formNote" style="margin-top:8px"></div>
  </div>
  <div class="card" id="slotCard" style="display:none">
    <h2 class="fold"><span class="caret">▾</span>素材</h2>
    <div class="foldbody" id="slotBox"></div>
  </div>
  <div class="card">
    <h2 class="fold"><span class="caret">▾</span>最近生成<span class="hint" id="histCount"></span></h2>
    <div class="foldbody"><div class="hist" id="hist"><div class="note">还没有任务</div></div></div>
  </div>
  <div class="note" id="envNote"></div>`;
  const main = `
  <div class="card" id="statusCard" style="display:none"><h2>任务 <span class="hint" id="jobId"></span></h2><div class="kv" id="jobKv"></div></div>
  <div id="resultBox"><div class="card"><h2>还没有结果</h2><div class="note">左边写好后点「生成」，产物会出现在这里；点图可以看大图。</div></div></div>`;
  const script = `
const BOOT = ${escapeJson(boot)};
const $ = (id) => document.getElementById(id);
const state = { id: '', job: null, busy: false, form: {}, slots: {}, prev: '' };
BOOT.slots.forEach((s) => { state.slots[s.key] = []; });

function defaultsForm() {
  const f = {};
  BOOT.fields.forEach((x) => { f[x.key] = x.default; });
  return f;
}
function loadForm() {
  state.form = defaultsForm();
  try {
    const raw = window.localStorage.getItem(BOOT.formKey);
    if (raw) Object.assign(state.form, JSON.parse(raw) || {});
  } catch (e) {}
}
function saveForm() {
  try { window.localStorage.setItem(BOOT.formKey, JSON.stringify(state.form)); } catch (e) {}
}

function fieldHTML(f) {
  const v = state.form[f.key];
  if (f.type === 'check') {
    return '<label class="note" style="display:flex;gap:6px;align-items:center;margin:0 0 10px">' +
      '<input type="checkbox" data-k="' + f.key + '" ' + (v ? 'checked' : '') + ' style="width:auto"> ' + MVK.esc(f.label) + '</label>';
  }
  let inner = '';
  if (f.type === 'select') {
    inner = '<select data-k="' + f.key + '">' + (f.options || []).map(([val, label]) =>
      '<option value="' + MVK.esc(val) + '"' + (String(v) === String(val) ? ' selected' : '') + '>' + MVK.esc(label || val) + '</option>').join('') + '</select>';
  } else if (f.type === 'textarea') {
    inner = '<textarea data-k="' + f.key + '" placeholder="' + MVK.esc(f.placeholder || '') + '">' + MVK.esc(v || '') + '</textarea>';
  } else if (f.type === 'number') {
    inner = '<input type="number" data-k="' + f.key + '" value="' + MVK.esc(v === undefined ? '' : v) + '"' +
      (f.min !== undefined ? ' min="' + f.min + '"' : '') + (f.max !== undefined ? ' max="' + f.max + '"' : '') +
      (f.step !== undefined ? ' step="' + f.step + '"' : '') + '>';
  } else {
    inner = '<input type="text" data-k="' + f.key + '" value="' + MVK.esc(v === undefined ? '' : v) + '" placeholder="' + MVK.esc(f.placeholder || '') + '">';
  }
  return '<div class="field"><label>' + MVK.esc(f.label) + '</label>' + inner + (f.hint ? '<span class="note">' + MVK.esc(f.hint) + '</span>' : '') + '</div>';
}

function renderForm() {
  const box = $('form');
  let html = '';
  let open = false;
  BOOT.fields.forEach((f) => {
    const wide = f.type === 'textarea' || f.type === 'check';
    if (wide) {
      if (open) { html += '</div>'; open = false; }
      html += fieldHTML(f);
      return;
    }
    if (!open) { html += '<div class="row" style="flex-wrap:wrap;gap:10px">'; open = true; }
    html += '<div style="flex:1 1 46%">' + fieldHTML(f) + '</div>';
  });
  if (open) html += '</div>';
  box.innerHTML = html;
  box.querySelectorAll('[data-k]').forEach((el) => {
    const k = el.getAttribute('data-k');
    const ev = (el.type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
    el.addEventListener(ev, () => {
      if (el.type === 'checkbox') state.form[k] = el.checked;
      else if (el.type === 'number') state.form[k] = el.value === '' ? '' : Number(el.value);
      else state.form[k] = el.value;
      saveForm();
    });
  });
}

function slotValue(slot) {
  const list = state.slots[slot.key] || [];
  return slot.single || slot.max === 1 ? (list[0] || '') : list.slice();
}

async function uploadFiles(slot, files) {
  if (!slot.upload) return;
  for (const file of files) {
    const fd = new FormData();
    fd.append('file', file, file.name);
    try {
      const data = await MVK.api(BOOT.api + '/upload', { method: 'POST', body: fd });
      const name = (data.name) || (data.files && data.files[0] && data.files[0].name) || (data.uploaded && data.uploaded[0] && data.uploaded[0].name);
      if (!name) throw new Error('上传没有返回文件名');
      if (slot.single || slot.max === 1) state.slots[slot.key] = [name];
      else if (state.slots[slot.key].length < slot.max) state.slots[slot.key].push(name);
      renderSlots();
    } catch (e) { MVK.toast(String(e.message || e), 'bad'); }
  }
}

async function pickOutput(slot, target) {
  if (!target) return;
  try {
    const data = await MVK.api(BOOT.api + '/import', { method: 'POST', body: { name: target } });
    const name = (data.name) || (data.files && data.files[0] && data.files[0].name);
    if (!name) throw new Error('导入没有返回文件名');
    if (slot.single || slot.max === 1) state.slots[slot.key] = [name];
    else state.slots[slot.key].push(name);
    renderSlots();
  } catch (e) { MVK.toast(String(e.message || e), 'bad'); }
}

async function loadOutputs(slot) {
  try {
    const data = await MVK.api(BOOT.api + '/outputs');
    const items = data.files || data.items || data.outputs || [];
    const names = items.map((x) => (typeof x === 'string' ? x : (x.key || (x.subfolder ? x.subfolder + '/' : '') + x.name))).filter(Boolean);
    return names.slice(0, 120);
  } catch (e) { return []; }
}

function slotPreviewURL(name) {
  return BOOT.api + '/preview?name=' + encodeURIComponent(name);
}

function renderSlots() {
  if (!BOOT.slots.length) return;
  $('slotCard').style.display = '';
  const box = $('slotBox');
  box.innerHTML = '';
  BOOT.slots.forEach((slot) => {
    const list = state.slots[slot.key] || [];
    const card = document.createElement('div');
    card.style.marginBottom = '12px';
    const head = document.createElement('div');
    head.className = 'note';
    head.style.marginBottom = '6px';
    head.textContent = slot.label + '（' + list.length + '/' + slot.max + '）';
    card.appendChild(head);
    const row = document.createElement('div');
    row.className = 'slots';
    list.forEach((name, i) => {
      const el = document.createElement('div');
      el.className = 'slot';
      el.innerHTML = '<img class="thumb" src="' + slotPreviewURL(name) + '" alt="">' +
        '<div class="grow"><div class="name">' + MVK.esc(name) + '</div></div>' +
        '<div class="acts"><button class="btn tiny ghost" data-del="' + i + '">移除</button></div>';
      row.appendChild(el);
      el.querySelector('[data-del]').onclick = () => { state.slots[slot.key].splice(i, 1); renderSlots(); };
      el.querySelector('img').onclick = () => MVK.lightbox(slotPreviewURL(name));
    });
    card.appendChild(row);
    const acts = document.createElement('div');
    acts.className = 'actions';
    acts.style.marginTop = '6px';
    if (slot.upload && (slot.single || list.length < slot.max)) {
      const label = document.createElement('label');
      label.className = 'btn tiny';
      label.textContent = '＋ 上传';
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = slot.accept || 'image/*';
      if (!slot.single && slot.max > 1) input.multiple = true;
      input.style.display = 'none';
      input.onchange = () => { uploadFiles(slot, Array.from(input.files || [])); input.value = ''; };
      label.appendChild(input);
      acts.appendChild(label);
    }
    if (slot.output && (slot.single || list.length < slot.max)) {
      const sel = document.createElement('select');
      sel.className = 'btn tiny';
      sel.style.maxWidth = '210px';
      sel.innerHTML = '<option value="">从 output 选…</option>';
      sel.onclick = async () => {
        if (sel.getAttribute('data-loaded')) return;
        const names = await loadOutputs(slot);
        names.forEach((n) => {
          const o = document.createElement('option');
          o.value = n; o.textContent = n;
          sel.appendChild(o);
        });
        sel.setAttribute('data-loaded', '1');
      };
      sel.onchange = () => pickOutput(slot, sel.value);
      acts.appendChild(sel);
    }
    card.appendChild(acts);
    box.appendChild(card);
  });
}

function readForm() {
  const out = Object.assign({}, state.form);
  Object.keys(out).forEach((k) => {
    if (out[k] === '') delete out[k];
  });
  return out;
}

async function generate() {
  if (state.busy) return;
  const body = readForm();
  const missing = BOOT.slots.filter((s) => s.required && !(state.slots[s.key] || []).length);
  if (missing.length) { MVK.toast('还缺：' + missing.map((m) => m.label).join('、'), 'bad'); return; }
  BOOT.slots.forEach((s) => { body[s.key] = slotValue(s); });
  setBusy(true, '提交中…');
  try {
    const data = await MVK.api(BOOT.api + BOOT.gen.path, { method: 'POST', body });
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

function setBusy(on, text) {
  state.busy = on;
  $('btnGen').disabled = on;
  $('btnGen').textContent = on ? (text || '生成中…') : '生成';
}

function renderResult(job) {
  const box = $('resultBox');
  const kind = BOOT.gen.result || 'image';
  const media = BOOT.api + '/media?id=' + encodeURIComponent(job.id) + '&t=' + (job.updatedAt || Date.now());
  const running = job.status === 'running' || job.status === 'queued';
  let html = '<div class="card"><h2>结果 <span class="hint">' + MVK.esc(job.id) + '</span></h2>';
  if (running) {
    html += '<div class="note">正在生成… ' + (job.elapsedSeconds ? MVK.fmt(job.elapsedSeconds) : '') + '</div>';
    html += '<div class="skeleton" style="margin-top:10px;height:14px;width:60%"></div>';
  } else if (job.status === 'failed') {
    html += '<div class="err">' + MVK.esc(job.error || '生成失败') + '</div>';
  } else if (job.file) {
    if (kind === 'video') html += '<div class="player"><video src="' + media + '" controls playsinline poster=""></video></div>';
    else if (kind === 'audio') html += '<audio class="audio" src="' + media + '" controls></audio>';
    else html += '<img src="' + media + '" style="width:100%;border-radius:10px;cursor:zoom-in" data-zoom="' + media + '">';
    html += '<div class="actions" style="margin-top:10px"><button class="btn" data-open="1">打开原文件</button><button class="btn ghost" data-save="1">下载</button></div>';
  } else {
    html += '<div class="note">还没有产物</div>';
  }
  html += '</div>';
  box.innerHTML = html;
  const zoom = box.querySelector('[data-zoom]');
  if (zoom) zoom.onclick = () => MVK.lightbox(zoom.getAttribute('data-zoom'));
  const open = box.querySelector('[data-open]');
  if (open) open.onclick = () => window.open(media, '_blank');
  const save = box.querySelector('[data-save]');
  if (save) save.onclick = () => { const a = document.createElement('a'); a.href = media; a.download = job.id; document.body.appendChild(a); a.click(); a.remove(); };
}

async function refreshJob() {
  if (!state.id) return;
  try {
    const job = await MVK.api(BOOT.api + '/job?id=' + encodeURIComponent(state.id));
    state.job = job;
    $('statusCard').style.display = '';
    $('jobId').textContent = job.id + (job.elapsedSeconds ? ' · ' + MVK.fmt(job.elapsedSeconds) : '');
    const kv = ['<b>状态</b><span>' + MVK.statusChip(job.status) + '</span>'];
    if (job.error) kv.push('<b>错误</b><span style="color:#a12626">' + MVK.esc(job.error) + '</span>');
    $('jobKv').innerHTML = kv.join('');
    renderResult(job);
    if (job.status !== 'running' && job.status !== 'queued') {
      if (state.polling) { state.polling(); state.polling = null; }
      setBusy(false);
    }
  } catch (e) {}
}

async function loadHistory() {
  try {
    const data = await MVK.api(BOOT.api + '/jobs');
    const jobs = (data.jobs || []).slice(0, 12);
    const box = $('hist');
    $('histCount').textContent = jobs.length ? jobs.length + ' 条' : '';
    if (!jobs.length) { box.innerHTML = '<div class="note">还没有任务</div>'; return; }
    box.innerHTML = '';
    jobs.forEach((j) => {
      const it = document.createElement('div');
      it.className = 'it' + (j.id === state.id ? ' on' : '');
      it.innerHTML = '<div class="t">' + MVK.esc(j.id) + ' · ' + MVK.esc(j.status) + '</div>' +
        '<div class="m">' + MVK.ago(j.createdAt) + (j.elapsedSeconds ? ' · ' + MVK.fmt(j.elapsedSeconds) : '') + '</div>';
      it.onclick = () => { state.id = j.id; refreshJob(); loadHistory(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
      box.appendChild(it);
    });
  } catch (e) {}
}

async function polish() {
  if (!BOOT.polish) return;
  const field = BOOT.polish.field || 'prompt';
  const val = state.form[field];
  if (!String(val || '').trim()) { MVK.toast('先写内容再润化', 'bad'); return; }
  const btn = $('btnPolish');
  if (btn) btn.disabled = true;
  $('formNote').textContent = '润化中…';
  try {
    const data = await MVK.api(BOOT.api + BOOT.polish.path, { method: 'POST', body: { [field]: val } });
    const next = data[field] || data.prompt || data.text || '';
    if (!next) throw new Error('润化没有返回内容');
    state.prev = val;
    state.form[field] = next;
    saveForm();
    renderForm();
    $('btnUndo').disabled = false;
    $('formNote').textContent = '已润化';
  } catch (e) {
    $('formNote').textContent = '';
    MVK.toast(String(e.message || e), 'bad');
  } finally { if (btn) btn.disabled = false; }
}

function undoPolish() {
  if (!state.prev) return;
  state.form[BOOT.polish.field || 'prompt'] = state.prev;
  state.prev = '';
  saveForm();
  renderForm();
  $('btnUndo').disabled = true;
  $('formNote').textContent = '';
}

async function runExtra(ex) {
  try {
    const body = {};
    Object.keys(ex.body || {}).forEach((k) => {
      const v = ex.body[k];
      body[k] = (typeof v === 'string' && v.charAt(0) === '@') ? state.form[v.slice(1)] : v;
    });
    const data = await MVK.api(BOOT.api + ex.path, { method: 'POST', body });
    if (ex.fill) {
      state.form[ex.fill] = data[ex.fill] || data.text || data.lyrics || data.prompt || '';
      saveForm();
      renderForm();
    }
    MVK.toast('完成');
  } catch (e) { MVK.toast(String(e.message || e), 'bad'); }
}

loadForm();
renderForm();
renderSlots();
MVK.bindFolds();
const acts = $('formActions');
if (BOOT.polish) {
  const b = document.createElement('button');
  b.className = 'btn'; b.id = 'btnPolish'; b.textContent = '✨ 润化';
  b.onclick = polish;
  const u = document.createElement('button');
  u.className = 'btn ghost'; u.id = 'btnUndo'; u.textContent = '↩ 撤销'; u.disabled = true;
  u.onclick = undoPolish;
  acts.appendChild(b); acts.appendChild(u);
}
(BOOT.extra || []).forEach((ex) => {
  const b = document.createElement('button');
  b.className = 'btn'; b.textContent = ex.label;
  b.onclick = () => runExtra(ex);
  acts.appendChild(b);
});
$('btnGen').onclick = generate;
MVK.api(BOOT.api + '/meta').then((m) => {
  const c = m.comfyui || {};
  $('envNote').textContent = 'ComfyUI ' + (c.version || (c.online === false ? '离线' : '—')) + ' · 空闲 ' +
    (c.vramFreeGB === undefined ? '—' : Number(c.vramFreeGB).toFixed(1)) + ' GB';
}).catch(() => { $('envNote').textContent = ''; });
loadHistory();
`;
  return page({
    title: s.title || '工作台',
    sub: s.sub || '',
    right: s.right || '',
    rail,
    main,
    script,
  });
}
export function page(opts) {
  const o = opts || {};
  const title = o.title || '工作台';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${KIT_CSS}${o.css || ''}</style>
</head>
<body>
<div class="app">
  <div class="top">
    <h1>${title}</h1>
    <span class="sub">${o.sub || ''}</span>
    <div class="right" id="topRight">${o.right || ''}</div>
  </div>
  <div class="wrap">
    <div class="rail" id="rail">${o.rail || ''}</div>
    <div class="main" id="main">${o.main || ''}</div>
  </div>
</div>
<div class="lightbox"></div>
<div class="drawer" id="drawer"><div class="dh"><b id="drawerTitle">详情</b><button class="btn tiny ghost" style="margin-left:auto" onclick="closeDrawer()">关闭</button></div><div class="db" id="drawerBody"></div><div class="df" id="drawerFoot"></div></div>
<script>${KIT_JS}</script>
<script>${o.script || ''}</script>
</body>
</html>`;
}
