window.__ModuleLoader__.load({
  id: 'dsh-comfyui-music-mv',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    async function api(url, init) {
      const res = await fetch(url, init);
      const raw = await res.text();
      let data = null;
      if (raw) {
        try { data = JSON.parse(raw); } catch { data = null; }
      }
      if (!res.ok) {
        const detail = (data && (data.message || data.error)) || ('HTTP ' + res.status);
        throw new Error(detail);
      }
      if (!data) throw new Error('接口返回空响应（HTTP ' + res.status + '）');
      return data;
    }

    const post = (url, body) => api(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });

    const ASPECTS = [
      ['16:9 (Widescreen)', '16:9'],
      ['9:16 (Portrait)', '9:16'],
      ['1:1 (Square)', '1:1'],
      ['4:3 (Standard)', '4:3'],
      ['3:4 (Portrait)', '3:4'],
      ['21:9 (Cinematic)', '21:9'],
    ];

    /** 面板样式：一次性注入，作用域限在 .mv 里，不去污染宿主。 */
const STYLE_ID = 'cfl-mv-style';

function ensureStyle() {
  const css = [
    '.mv { --mv-line: rgba(128,128,128,0.20); --mv-line-strong: rgba(128,128,128,0.32);',
    '  --mv-soft: rgba(128,128,128,0.06); --mv-softer: rgba(128,128,128,0.035);',
    '  --mv-dim: rgba(128,128,128,0.95); --mv-ink: currentColor;',
    '  height: 100%; overflow-y: auto; overflow-x: hidden; box-sizing: border-box; overscroll-behavior: contain; }',
    '.mv * { box-sizing: border-box; }',
    '.mv-wrap { max-width: 1040px; margin: 0 auto; padding: 14px 20px 40px; font-size: 13px; line-height: 1.6; }',
    /* header */
    '.mv-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }',
    '.mv-title { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: .2px; }',
    '.mv-sub { margin: 2px 0 0; font-size: 12px; color: var(--mv-dim); opacity: .72; }',
    '.mv-pill { font-size: 11px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--mv-line-strong);',
    '  color: var(--mv-dim); white-space: nowrap; }',
    '.mv-pill.ok { color: #5abe8c; border-color: rgba(90,190,140,.55); }',
    '.mv-pill.warn { opacity: .65; }',
    /* stepper */
    '.mv-steps { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin: 16px 0 18px; }',
    '.mv-step { font-size: 12px; padding: 4px 11px; border-radius: 999px; border: 1px solid var(--mv-line);',
    '  color: var(--mv-dim); font-variant-numeric: tabular-nums; }',
    '.mv-step.on { border-color: rgba(120,150,255,.65); color: rgba(120,150,255,1); background: rgba(120,150,255,.10); font-weight: 600; }',
    '.mv-sep { width: 10px; height: 1px; background: var(--mv-line); }',
    /* card */
    '.mv-card { border: 1px solid var(--mv-line); border-radius: 12px; padding: 14px 16px; margin-bottom: 14px;',
    '  background: var(--mv-softer); }',
    '.mv-card-h { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }',
    '.mv-card-t { font-size: 14px; font-weight: 650; }',
    '.mv-card-sub { font-size: 12px; color: var(--mv-dim); opacity: .75; }',
    '.mv-note { font-size: 12px; color: var(--mv-dim); opacity: .7; }',
    /* form */
    '.mv-field { display: flex; flex-direction: column; gap: 4px; }',
    '.mv-label { font-size: 11px; color: var(--mv-dim); opacity: .8; letter-spacing: .3px; }',
    '.mv-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(108px, 168px)); gap: 12px; align-items: end; margin-top: 14px; }',
    '.mv-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 12px; }',
    '.mv-actions .cfl-chip { font-size: 12.5px; padding: 5px 12px; border-radius: 8px; }',
    '.mv-subcard { margin-top: 16px; padding: 12px 14px; border: 1px solid var(--mv-line); border-radius: 10px;',
    '  background: var(--mv-soft); display: grid; gap: 10px; }',
    '.mv-subcard-t { font-size: 12px; font-weight: 600; letter-spacing: .3px; color: var(--mv-dim); }',
    '.mv-check { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--mv-dim);',
    '  padding: 4px 8px; border: 1px solid var(--mv-line); border-radius: 8px; cursor: pointer; }',
    '.mv-check input { margin: 0; }',
    '.mv-input, .mv-select, .mv-ta { width: 100%; font-size: 13px; padding: 6px 9px; border-radius: 8px;',
    '  border: 1px solid var(--mv-line-strong); background: transparent; color: inherit; font-family: inherit; }',
    '.mv-ta { resize: vertical; min-height: 58px; line-height: 1.55; }',
    '.mv-ta:focus, .mv-input:focus, .mv-select:focus { outline: none; border-color: rgba(120,150,255,.7); }',
    /* plan head */
    '.mv-plan-top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }',
    '.mv-plan-t { font-size: 16px; font-weight: 650; }',
    '.mv-logline { margin-top: 8px; font-size: 13px; line-height: 1.7; }',
    '.mv-arc { margin-top: 4px; font-size: 12.5px; color: var(--mv-dim); opacity: .8; line-height: 1.6; }',
    '.mv-lint { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; margin-top: 10px; }',
    '.mv-chip { font-size: 11px; padding: 1.5px 7px; border-radius: 999px; border: 1px solid var(--mv-line-strong);',
    '  color: var(--mv-dim); cursor: help; }',
    '.mv-chip.ok { color: rgba(90,190,140,.95); border-color: rgba(90,190,140,.35); }',
    '.mv-chip.bad { color: rgba(224,112,104,.98); border-color: rgba(224,112,104,.42); }',
    '.mv-score { font-size: 12px; font-weight: 650; margin-right: 4px; font-variant-numeric: tabular-nums; }',
    /* scenes */
    '.mv-scenes { margin-top: 10px; }',
    '.mv-scene { border: 1px solid var(--mv-line); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px;',
    '  background: var(--mv-soft); }',
    '.mv-scene-h { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }',
    '.mv-scene-no { font-size: 11px; font-weight: 650; letter-spacing: .5px; padding: 1px 7px; border-radius: 6px;',
    '  background: rgba(120,150,255,.14); color: rgba(120,150,255,1); }',
    '.mv-scene-hd { font-size: 12.5px; color: var(--mv-dim); }',
    '.mv-scene-body { margin-top: 7px; font-size: 13.5px; line-height: 1.85; }',
    '.mv-meta { margin-top: 9px; display: grid; gap: 5px; }',
    '.mv-meta-row { display: grid; grid-template-columns: 34px 1fr; gap: 8px; align-items: baseline; }',
    '.mv-meta-k { font-size: 10.5px; letter-spacing: .5px; color: var(--mv-dim); opacity: .7; padding-top: 2px; }',
    '.mv-meta-v { font-size: 12.5px; line-height: 1.7; }',
    '.mv-meta-row.perf .mv-meta-v { color: #c9a45c; }',
    '.mv-meta-row.sound .mv-meta-v { color: var(--mv-dim); opacity: .85; }',
    '.mv-meta-row.lyric .mv-meta-v { font-style: italic; color: var(--mv-dim); }',
    /* characters */
    '.mv-chars { display: grid; gap: 10px; margin-top: 6px; }',
    /* 用 flex 而不是 grid：没有定妆图时第一个子元素会缺一个，grid 会把名字挤进 auto 列、
       外观挤进 128px 列，看起来像文本框错位（就是这么错的）。 */
    '.mv-char { display: flex; gap: 10px; align-items: flex-start; flex-wrap: nowrap;',
    '  border: 1px solid var(--mv-line); border-radius: 10px; padding: 10px 12px; background: var(--mv-soft); }',
    '.mv-char > .mv-input { flex: 0 0 110px; }',
    '.mv-char > .mv-ta { flex: 1 1 auto; min-width: 0; min-height: 54px; }',
    '.mv-char > .cfl-chip { flex: 0 0 auto; }',
    '.mv-char-thumbs { display: flex; gap: 5px; }',
    '.mv-thumb { width: 56px; height: 56px; border-radius: 8px; object-fit: cover; cursor: zoom-in;',
    '  border: 1px solid var(--mv-line-strong); }',
    '.mv-thumb-empty { width: 56px; height: 56px; border-radius: 8px; border: 1px dashed var(--mv-line-strong);',
    '  display: flex; align-items: center; justify-content: center; font-size: 10px; color: var(--mv-dim); opacity: .6; }',
    '.mv-thumb-label { font-size: 9.5px; text-align: center; color: var(--mv-dim); opacity: .7; margin-top: 2px; }',
    '.mv-char-body { display: flex; flex-direction: column; gap: 6px; }',
    '@media (max-width: 720px) { .mv-char { flex-wrap: wrap; } .mv-char > .mv-ta { flex-basis: 100%; } .mv-wrap { padding: 12px; } }',
  ].join('\n');
  const old = document.getElementById(STYLE_ID);
  if (old) {
    if (old.textContent !== css) old.textContent = css;
    return;
  }
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}

/** 点缩略图看大图：自己搭一层遮罩，不依赖宿主有没有 lightbox。 */
function showZoom(src) {
  const mask = document.createElement('div');
  mask.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.86);display:flex;align-items:center;justify-content:center;cursor:zoom-out';
  const img = document.createElement('img');
  img.src = src;
  img.style.cssText = 'max-width:92vw;max-height:92vh;border-radius:6px;box-shadow:0 8px 40px rgba(0,0,0,0.6)';
  mask.appendChild(img);
  mask.addEventListener('click', function () { mask.remove(); });
  document.body.appendChild(mask);
}

/** Electron/webview 里 window.open 会被拦掉（点了没反应），统一用 fetch + blob 下载。 */
function downloadFile(url, fallbackName) {
  fetch(url).then(function (r) {
    if (!r.ok) return r.text().then(function (t) { throw new Error('HTTP ' + r.status + ' ' + String(t).slice(0, 120)); });
    const cd = r.headers.get('content-disposition') || '';
    const star = cd.match(/filename\*=UTF-8''([^;]+)/i);
    const name = star ? decodeURIComponent(star[1]) : fallbackName;
    return r.blob().then(function (blob) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      return true;
    });
  }).catch(function (e) {
    alert('下载失败：' + (e && e.message ? e.message : e));
  });
}

const STEPS = [
      { key: 'plan', label: '剧本' },
      { key: 'song', label: '出歌' },
      { key: 'hero', label: '定妆' },
      { key: 'frames', label: '静帧' },
      { key: 'videos', label: '视频' },
      { key: 'stitch', label: '合成' },
    ];

    const FORM_KEY = 'comfyui-music-mv.form.v2';

    function loadForm() {
      try {
        const raw = window.localStorage.getItem(FORM_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch {
        return null;
      }
    }

    /**
     * 写剧本是 20–60 秒的请求。面板一切走就卸载组件，result 回了也没人接，
     * 于是"点了生成剧本然后离开，回来状态就没了"。
     * 把这次请求挂在模块作用域（不随组件卸载），完成时直接写进 localStorage，
     * 回来时从模块或 localStorage 捞回来。
     */
    const PLAN_RUN_KEY = 'comfyui-music-mv.planrun.v2';   // 现在存的是服务端 taskId
    const JOB_KEY = 'comfyui-music-mv.job.v1';               // 面板上正在看哪个任务

    function stashPlan(plan, lint) {
      try {
        const raw = window.localStorage.getItem(FORM_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        parsed.plan = plan;
        window.localStorage.setItem(FORM_KEY, JSON.stringify(parsed));
        window.localStorage.setItem(PLAN_RUN_KEY, JSON.stringify({ done: true, at: Date.now() }));
      } catch { /* ignore */ }
      return { plan, lint };
    }

    function takeStashedPlan() {
      try {
        const flag = JSON.parse(window.localStorage.getItem(PLAN_RUN_KEY) || 'null');
        if (flag && flag.done) {
          const form = JSON.parse(window.localStorage.getItem(FORM_KEY) || 'null');
          window.localStorage.removeItem(PLAN_RUN_KEY);
          if (form && form.plan) return { plan: form.plan, lint: null };
        }
      } catch { /* ignore */ }
      return null;
    }


    const CFG_DEFAULTS = {
      theme: '',
      duration: 60,
      aspectRatio: '16:9 (Widescreen)',
      megapixels: 0.4,
      frameMegapixels: 8,
      style: '',
      tailLink: true,
      lipSync: true,
      grade: true,
    };

    const small = { fontSize: '12px' };
    const muted = { fontSize: '12px', opacity: 0.62 };
    const card = { border: '1px solid rgba(128,128,128,0.22)', borderRadius: '10px', overflow: 'hidden', background: 'rgba(128,128,128,0.04)' };

    function MvIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20;
      const active = !!(props && props.active);
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: active ? 1.9 : 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('rect', { key: 'a', x: 2.4, y: 4.6, width: 19.2, height: 14.8, rx: 2 }),
        h('path', { key: 'b', d: 'M8.2 15.6V9.2l4.4 3.2-4.4 3.2z' }),
        h('path', { key: 'c', d: 'M16 9.6v4.2' }),
        h('circle', { key: 'd', cx: 16, cy: 15.4, r: 1.2 })
      );
    }

    function MvPanel() {
      ensureStyle();
      const [initial] = React.useState(function () { return loadForm(); });
      const [meta, setMeta] = React.useState(null);
      const [metaError, setMetaError] = React.useState('');
      const [cfg, setCfg] = React.useState(function () { return { ...CFG_DEFAULTS, ...((initial && initial.cfg) || {}) }; });
      const [plan, setPlan] = React.useState((initial && initial.plan) || null);
      const [job, setJob] = React.useState(null);
      const [history, setHistory] = React.useState([]);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [openShot, setOpenShot] = React.useState(null);
      const [scriptOpen, setScriptOpen] = React.useState(true);
      const [lint, setLint] = React.useState(null);
      const [bust, setBust] = React.useState(0);
      const [nowTime, setNowTime] = React.useState(0);
      const audioRef = React.useRef(null);

      React.useEffect(function () {
        try { window.localStorage.setItem(FORM_KEY, JSON.stringify({ cfg, plan })); } catch { /* ignore */ }
      }, [cfg, plan]);

      const refreshJob = React.useCallback(function (id) {
        if (!id) return Promise.resolve(null);
        return api('/api/comfyui-music-mv/job?id=' + encodeURIComponent(id))
          .then(function (next) { setJob(next); return next; })
          .catch(function () { return null; });
      }, []);

      const loadMeta = React.useCallback(async function (attempt) {
        const tries = typeof attempt === 'number' ? attempt : 0;
        try {
          setMeta(await api('/api/comfyui-music-mv/meta'));
          setMetaError('');
        } catch (err) {
          if (tries < 3) { setTimeout(function () { loadMeta(tries + 1); }, 700 * (tries + 1)); return; }
          setMeta({ comfyui: { online: false } });
          setMetaError(String((err && err.message) || err));
        }
      }, []);

      const refreshHistory = React.useCallback(function () {
        api('/api/comfyui-music-mv/jobs')
          .then(function (d) {
            if (!d || !Array.isArray(d.jobs)) return;
            setHistory(d.jobs);
          })
          .catch(function () {});
      }, []);

      /** 面板上正在看哪个任务，记下来；用户点「新建」就把指针清掉，之后不再自动挂接。 */
      const pinJob = React.useCallback(function (id) {
        try {
          if (id) window.localStorage.setItem(JOB_KEY, String(id));
          else window.localStorage.removeItem(JOB_KEY);
        } catch { /* ignore */ }
      }, []);

      /**
       * 写剧本走服务端任务：POST 立刻返回 taskId，再轮询 /plan-task。
       * 面板切走、插件重载都没关系——taskId 存在 localStorage，回来接着轮询。
       */
      const pollPlanTask = React.useCallback(function (taskId) {
        const started = Date.now();
        setBusy('正在写剧本…');
        const tick = async function () {
          try {
            const data = await api('/api/comfyui-music-mv/plan-task?id=' + encodeURIComponent(taskId));
            if (data && data.status === 'done') {
              stashPlan(data.plan || null, data.lint || null);
              try { window.localStorage.removeItem(PLAN_RUN_KEY); } catch { /* ignore */ }
              setPlan(data.plan);
              setLint(data.lint || null);
              // 上一部片的任务还挂着的话清掉，不然分镜板/定妆还是旧的。
              setJob(function (cur) {
                if (!cur) return null;
                if (cur.status === 'running' || cur.status === 'queued') return cur;
                return null;
              });
              setBusy('');
              return;
            }
            if (data && data.status === 'failed') {
              try { window.localStorage.removeItem(PLAN_RUN_KEY); } catch { /* ignore */ }
              setError(String(data.error || '写剧本失败'));
              setBusy('');
              return;
            }
          } catch (err) {
            // 服务端重启会 404：超过 3 分钟就当失败，别无限转。
            if (Date.now() - started > 3 * 60 * 1000) {
              try { window.localStorage.removeItem(PLAN_RUN_KEY); } catch { /* ignore */ }
              setError(String((err && err.message) || err));
              setBusy('');
              return;
            }
          }
          setTimeout(tick, 1500);
        };
        tick();
      }, []);

      React.useEffect(function () {
        const back = takeStashedPlan();
        if (back && back.plan) {
          setPlan(back.plan);
          if (back.lint) setLint(back.lint);
        }
        // 上次那个任务还没写完？接着轮询它。
        try {
          const pending = JSON.parse(window.localStorage.getItem(PLAN_RUN_KEY) || 'null');
          if (pending && pending.taskId && Date.now() - (pending.at || 0) < 30 * 60 * 1000) {
            pollPlanTask(pending.taskId);
          }
        } catch { /* ignore */ }
      }, [pollPlanTask]);

      React.useEffect(function () {
        loadMeta(0);
        refreshHistory();
        // 恢复面板上正在看的任务：优先 localStorage 指针；没有指针就不擅自挂最近那个。
        let wantId = '';
        try { wantId = window.localStorage.getItem(JOB_KEY) || ''; } catch { /* ignore */ }
        api('/api/comfyui-music-mv/jobs')
          .then(function (d) {
            const list = (d && Array.isArray(d.jobs)) ? d.jobs : [];
            const target = list.filter(function (j) { return j.id === wantId; })[0]
              || list.filter(function (j) { return j.status === 'running' || j.status === 'queued'; })[0]
              || null;
            if (target) setJob(function (cur) { return cur || target; });
          })
          .catch(function () {});
        const timer = setInterval(refreshHistory, 10000);
        return function () { clearInterval(timer); };
      }, [loadMeta, refreshHistory]);

      const running = !!(job && (job.status === 'queued' || job.status === 'running'));

      React.useEffect(function () {
        if (!running || !job) return undefined;
        const timer = setInterval(function () {
          refreshJob(job.id).then(function (next) {
            if (next && next.status !== 'running' && next.status !== 'queued') refreshHistory();
          });
        }, 2500);
        return function () { clearInterval(timer); };
      }, [running, job, refreshJob, refreshHistory]);

      const vocab = (meta && meta.vocab) || { sizes: [], horizontals: [], elevations: [], moves: [], lights: [], dofs: [], transitions: [] };
      const online = !!(meta && meta.comfyui && meta.comfyui.online);
      const vram = meta && meta.comfyui && typeof meta.comfyui.vramFreeGB === 'number' ? meta.comfyui.vramFreeGB : null;

      async function makePlan() {
        setError('');
        if (!String(cfg.theme || '').trim()) { setError('先写一个主题'); return; }
        try {
          const started = await post('/api/comfyui-music-mv/plan-async', { theme: cfg.theme, duration: cfg.duration, style: cfg.style });
          if (!started || !started.taskId) throw new Error('没有拿到任务号');
          try { window.localStorage.setItem(PLAN_RUN_KEY, JSON.stringify({ taskId: started.taskId, at: Date.now() })); } catch { /* ignore */ }
          pollPlanTask(started.taskId);
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      }

      async function startRun(phase) {
        setError('');
        if (!plan) { setError('先生成剧本'); return; }
        setBusy(phase === 'all' ? '一键到底：正在排队…' : '出静帧：正在排队…');
        try {
          const data = await post('/api/comfyui-music-mv/run', {
            plan,
            theme: cfg.theme,
            duration: plan.duration,
            aspectRatio: cfg.aspectRatio,
            megapixels: cfg.megapixels,
            frameMegapixels: cfg.frameMegapixels,
            tailLink: cfg.tailLink,
            lipSync: cfg.lipSync,
            grade: cfg.grade,
            crop: cfg.grade,
            phase,
          });
          pinJob(data.job.id);
          setJob({ id: data.job.id, status: 'queued', plan, shots: [] });
          refreshJob(data.job.id);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally { setBusy(''); }
      }

      async function continueRun(phase) {
        if (!job) return;
        setError('');
        setBusy(phase === 'videos' ? '正在出视频…' : '继续…');
        try {
          await post('/api/comfyui-music-mv/continue', { id: job.id, phase });
          refreshJob(job.id);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally { setBusy(''); }
      }

      async function restitch() {
        if (!job) return;
        setError('');
        setBusy('正在重新合成…');
        try {
          await post('/api/comfyui-music-mv/stitch', { id: job.id });
          await refreshJob(job.id);
          setBust(Date.now());
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally { setBusy(''); }
      }

      async function regenFrame(index) {
        if (!job) return;
        setError('');
        setBusy('正在重出一张静帧…');
        try {
          await post('/api/comfyui-music-mv/frame', { id: job.id, index });
          await refreshJob(job.id);
          setBust(Date.now());
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally { setBusy(''); }
      }

      async function saveShot(index, patch) {
        if (!job) return;
        try {
          const data = await post('/api/comfyui-music-mv/shot', { id: job.id, index, patch });
          setJob(function (prev) {
            if (!prev) return prev;
            const shots = prev.shots.map(function (s) { return s.index === index ? data.shot : s; });
            return { ...prev, shots };
          });
        } catch (err) {
          setError(String((err && err.message) || err));
        }
      }

      function patchPlan(patch) { setPlan(function (p) { return p ? { ...p, ...patch } : p; }); }

      function planCharacters() {
        if (!plan) return [];
        if (Array.isArray(plan.characters) && plan.characters.length) return plan.characters;
        if (plan.character) return [{ name: '主角', look: plan.character }];
        return [];
      }

      function setCharacters(list) {
        patchPlan({ characters: list, character: '' });
      }

      function exportPlan() {
        if (!job) { setError('这个任务还没生成方案，导不了'); return; }
        window.open('/api/comfyui-music-mv/export?id=' + encodeURIComponent(job.id), '_blank');
      }

      function importPlan() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.onchange = async function () {
          const file = input.files && input.files[0];
          if (!file) return;
          setError('');
          try {
            const data = await post('/api/comfyui-music-mv/import', { project: JSON.parse(await file.text()) });
            setPlan(data.plan);
            const p = data.params || {};
            setCfg(function (prev) {
              const next = { ...prev };
              if (p.aspectRatio) next.aspectRatio = p.aspectRatio;
              if (typeof p.megapixels === 'number') next.megapixels = p.megapixels;
              if (typeof p.tailLink === 'boolean') next.tailLink = p.tailLink;
              if (typeof p.lipSync === 'boolean') next.lipSync = p.lipSync;
              return next;
            });
          } catch (err) {
            setError(String((err && err.message) || err));
          }
        };
        input.click();
      }

      function num(labelText, key, min, max, step) {
        return h('label', { key: key, className: 'mv-field' },
          h('span', { className: 'mv-label' }, labelText),
          h('input', {
            type: 'number', min: min, max: max, step: step, value: cfg[key],
            className: 'mv-input',
            onChange: function (e) { setCfg(function (p) { return { ...p, [key]: Number(e.target.value) }; }); },
          })
        );
      }

      function sel(key, options, value, onChange) {
        return h('select', {
          value: value || '',
          onChange: function (e) { onChange(e.target.value); },
          style: { fontSize: '12px' },
        }, (options || []).map(function (o) { return h('option', { key: o.key, value: o.key }, o.zh); }));
      }

      /* ---------------- 步骤条 ---------------- */
      const stageIndex = job ? STEPS.findIndex(function (s) { return s.key === job.stage; }) : -1;
      const stepper = h('div', { className: 'mv-steps' },
        STEPS.map(function (s, i) {
          const active = job && job.stage === s.key;
          const passed = job && (stageIndex > i || job.status === 'done');
          return h('span', {
            key: s.key,
            style: {
              ...small, padding: '3px 10px', borderRadius: '999px',
              border: '1px solid ' + (active ? 'rgba(120,170,255,0.8)' : 'rgba(128,128,128,0.3)'),
              background: active ? 'rgba(120,170,255,0.18)' : 'transparent',
              opacity: passed ? 0.55 : 1, fontWeight: active ? 600 : 400,
            },
          }, (passed ? '✓ ' : '') + s.label);
        })
      );

      /* ---------------- 时间轴带 ---------------- */
      function timelineStrip(jobShots, totalSeconds) {
        if (!jobShots || !jobShots.length) return null;
        const total = Number(totalSeconds) || jobShots.reduce(function (a, s) { return a + (Number(s.seconds) || 0); }, 0) || 1;
        return h('div', {
          style: {
            display: 'flex', gap: '2px', height: '46px', marginTop: '10px',
            borderRadius: '8px', overflow: 'hidden', border: '1px solid rgba(128,128,128,0.25)',
          },
        }, jobShots.map(function (shot) {
          const w = ((Number(shot.seconds) || 1) / total) * 100;
          const active = nowTime >= (Number(shot.start) || 0) && nowTime < (Number(shot.end) || 0);
          const url = job && shot.frameFile
            ? '/api/comfyui-music-mv/frame-img?id=' + encodeURIComponent(job.id) + '&index=' + shot.index + '&v=' + bust
            : null;
          return h('div', {
            key: shot.index,
            title: (shot.index + 1) + '. ' + (shot.label || '') + ' ' + shot.start + '-' + shot.end + 's',
            style: {
              flex: '0 0 ' + w + '%', position: 'relative', cursor: 'pointer',
              backgroundImage: url ? 'url("' + url + '")' : 'none',
              backgroundSize: 'cover', backgroundPosition: 'center',
              backgroundColor: 'rgba(0,0,0,0.35)',
              outline: active ? '2px solid #7ab0ff' : 'none', outlineOffset: '-2px',
              opacity: shot.videoStatus === 'done' ? 1 : 0.7,
            },
            onClick: function () {
              const el = audioRef.current;
              if (el) { try { el.currentTime = Number(shot.start) || 0; el.play(); } catch { /* ignore */ } }
            },
          },
            h('div', {
              style: {
                position: 'absolute', left: '4px', bottom: '2px', fontSize: '10px', color: '#fff',
                textShadow: '0 1px 2px rgba(0,0,0,0.9)',
              },
            }, String(shot.index + 1))
          );
        }));
      }

      /* ---------------- 分镜卡片 ---------------- */
      function shotCard(shot) {
        const open = openShot === shot.index;
        const frameUrl = job && shot.frameFile
          ? '/api/comfyui-music-mv/frame-img?id=' + encodeURIComponent(job.id) + '&index=' + shot.index + '&v=' + bust
          : null;
        const videoUrl = job && shot.video
          ? '/api/comfyui-music-mv/clip?id=' + encodeURIComponent(job.id) + '&index=' + shot.index + '&v=' + bust
          : null;
        const badge = shot.videoStatus === 'done' ? '🎬 视频' : shot.videoStatus === 'running' ? '⏳ 出视频'
          : shot.frameStatus === 'done' ? '🖼 静帧' : shot.frameStatus === 'running' ? '⏳ 出静帧' : '· 待生成';
        return h('div', { key: shot.index, style: { ...card } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 8px', borderBottom: '1px solid rgba(128,128,128,0.16)' } },
            h('div', { style: { ...small, fontWeight: 600 } }, (shot.index + 1) + '. ' + (shot.label || '')),
            h('span', { style: { ...small, opacity: 0.7 } }, badge)
          ),
          h('div', {
            style: { position: 'relative', aspectRatio: '16/9', background: 'rgba(0,0,0,0.25)', cursor: 'pointer' },
            onClick: function () { setOpenShot(open ? null : shot.index); },
          },
            frameUrl ? h('img', { src: frameUrl, alt: '', style: { width: '100%', height: '100%', objectFit: 'cover', display: 'block' } }) : null,
            !frameUrl ? h('div', { style: { ...muted, position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' } }, '还没有静帧') : null,
            shot.frameFromTail ? h('span', { style: { position: 'absolute', left: '6px', top: '6px', fontSize: '11px', padding: '1px 6px', borderRadius: '999px', background: 'rgba(0,0,0,0.55)', color: '#9ecbff' } }, '末帧接龙') : null
          ),
          h('div', { style: { padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: '4px' } },
            h('div', { style: { ...small, opacity: 0.75 } }, shot.start + '-' + shot.end + 's · ' + (shot.section || '')),
            h('div', { style: { ...muted } },
              [shot.size, shot.elevation, shot.horizontal].filter(Boolean).join('·') + ' ｜ ' + (shot.move || '') + ' ｜ ' + (shot.light || '')),
            h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
              h('button', { className: 'cfl-chip', style: { fontSize: '11px' }, disabled: !!busy || running || !job, onClick: function () { regenFrame(shot.index); } }, '🔄 换一张'),
              videoUrl ? h('button', {
                className: 'cfl-chip', style: { fontSize: '11px' },
                onClick: function () { window.open(videoUrl, '_blank'); },
              }, '▶ 看这段') : null,
              h('button', { className: 'cfl-chip', style: { fontSize: '11px' }, onClick: function () { setOpenShot(open ? null : shot.index); } }, open ? '收起' : '参数')
            )
          ),
          open
            ? h('div', { style: { padding: '8px', borderTop: '1px solid rgba(128,128,128,0.16)', display: 'flex', flexDirection: 'column', gap: '6px' } },
                h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                  h('label', { style: { ...small, display: 'flex', flexDirection: 'column' } }, '景别',
                    sel('size', vocab.sizes, shot.size, function (v) { saveShot(shot.index, { size: v }); })),
                  h('label', { style: { ...small, display: 'flex', flexDirection: 'column' } }, '俯仰',
                    sel('elevation', vocab.elevations, shot.elevation, function (v) { saveShot(shot.index, { elevation: v }); })),
                  h('label', { style: { ...small, display: 'flex', flexDirection: 'column' } }, '机位',
                    sel('horizontal', vocab.horizontals, shot.horizontal, function (v) { saveShot(shot.index, { horizontal: v }); })),
                  h('label', { style: { ...small, display: 'flex', flexDirection: 'column' } }, '运镜',
                    sel('move', vocab.moves, shot.move, function (v) { saveShot(shot.index, { move: v }); })),
                  h('label', { style: { ...small, display: 'flex', flexDirection: 'column' } }, '灯光',
                    sel('light', vocab.lights, shot.light, function (v) { saveShot(shot.index, { light: v }); })),
                  h('label', { style: { ...small, display: 'flex', flexDirection: 'column' } }, '景深',
                    sel('dof', vocab.dofs, shot.dof, function (v) { saveShot(shot.index, { dof: v }); })),
                  h('label', { style: { ...small, display: 'flex', flexDirection: 'column' } }, '转场',
                    sel('transition', vocab.transitions, shot.transition, function (v) { saveShot(shot.index, { transition: v }); }))
                ),
                h('div', { style: { ...small, opacity: 0.65 } }, '场景'),
                h('textarea', {
                  value: shot.scene || '', rows: 2,
                  onChange: function (e) { saveShot(shot.index, { scene: e.target.value }); },
                  style: { width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '12px' },
                }),
                h('div', { style: { ...small, opacity: 0.65 } }, '表演（手/眼/呼吸的微动作，不是形容词）'),
                h('textarea', {
                  value: shot.performance || '', rows: 2,
                  placeholder: '先做什么 → 停在哪里 → 最后做什么',
                  onChange: function (e) { saveShot(shot.index, { performance: e.target.value }); },
                  style: { width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '12px' },
                }),
                h('div', { style: { ...small, opacity: 0.65 } }, '动作（只写画面）'),
                h('textarea', {
                  value: shot.action || '', rows: 3,
                  onChange: function (e) { saveShot(shot.index, { action: e.target.value }); },
                  style: { width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '12px' },
                }),
                shot.framePromptText ? h('div', { style: { ...muted, fontStyle: 'italic' } }, '静帧提示词：' + shot.framePromptText.slice(0, 160)) : null
              )
            : null
        );
      }

      /* ---------------- 渲染 ---------------- */
      const planBody = plan
        ? h('div', { className: 'mv-card' },
            h('div', { className: 'mv-card-h' },
              h('div', { className: 'mv-plan-t' }, '《' + (plan.title || '未命名') + '》'),
              h('span', { className: 'mv-card-sub' }, plan.duration + 's · ' + (plan.shots || []).length + ' 镜 · ' + ((plan.scenes || []).length) + ' 场'),
              lint ? h('span', {
                className: 'mv-score',
                style: { marginLeft: 'auto', color: lint.score >= 85 ? '#4a9d63' : (lint.score >= 70 ? '#c9a45c' : '#c0574f') },
              }, '体检 ' + lint.score) : null
            ),
            lint ? h('div', { className: 'mv-lint' },
              ...lint.checks.map(function (c, i) {
                return h('span', {
                  key: 'lk' + i, title: c.label + '：' + c.detail,
                  className: 'mv-chip ' + (c.ok ? 'ok' : 'bad'),
                }, (c.ok ? '✓ ' : '✗ ') + c.label);
              })
            ) : null,
            plan.story && plan.story.logline ? h('div', { className: 'mv-logline' }, plan.story.logline) : null,
            plan.story && plan.story.arc ? h('div', { className: 'mv-arc' }, '情绪线　' + plan.story.arc) : null,
            (plan.scenes && plan.scenes.length)
              ? h('div', { style: { marginTop: '14px' } },
                  h('div', { className: 'mv-card-h', style: { marginBottom: '8px' } },
                    h('div', { className: 'mv-card-t' }, '剧本'),
                    h('span', { className: 'mv-card-sub' }, plan.scenes.length + ' 场'),
                    h('button', {
                      className: 'cfl-chip', style: { fontSize: '11px', marginLeft: 'auto' },
                      onClick: function () { setScriptOpen(!scriptOpen); },
                    }, scriptOpen ? '收起' : '展开')
                  ),
                  scriptOpen ? h('div', { className: 'mv-scenes' },
                    ...plan.scenes.map(function (s, i) {
                      const meta = function (kind, label, value) {
                        if (!value) return null;
                        return h('div', { className: 'mv-meta-row ' + kind },
                          h('div', { className: 'mv-meta-k' }, label),
                          h('div', { className: 'mv-meta-v' }, value)
                        );
                      };
                      return h('div', { key: 'sc' + i, className: 'mv-scene' },
                        h('div', { className: 'mv-scene-h' },
                          h('span', { className: 'mv-scene-no' }, '场' + (s.no || i + 1)),
                          s.heading ? h('span', { className: 'mv-scene-hd' }, s.heading) : null
                        ),
                        s.action ? h('div', { className: 'mv-scene-body' }, s.action) : null,
                        (s.performance || s.sound || s.lyric)
                          ? h('div', { className: 'mv-meta' },
                              meta('perf', '表演', s.performance),
                              meta('sound', '声音', s.sound),
                              meta('lyric', '唱', s.lyric)
                            )
                          : null
                      );
                    })
                  ) : null
                )
              : null,
            h('div', { className: 'mv-card-h', style: { marginTop: '16px', marginBottom: '2px' } },
              h('div', { className: 'mv-card-t' }, '角色定妆'),
              h('span', { className: 'mv-card-sub' }, '每个角色一张，全片复用')
            ),
            h('div', { className: 'mv-chars' },
            ...planCharacters().map(function (c, i) {
              const list = planCharacters();
              // 旧项目的定妆图不能挂到新剧本的角色上：只有 job 与当前 plan 对得上时才显示。
              const jobMatchesPlan = !!(job && plan && job.plan
                && job.plan.title === plan.title
                && (job.shots || []).length === (plan.shots || []).length);
              const hero = jobMatchesPlan && Array.isArray(job.heroes) ? job.heroes[i] : null;
              const hasBeastLook = String((c && c.beast) || '').trim().length > 0;
              const thumb = function (kind, label) {
                if (!hero) return null;
                const has = kind === 'human' ? hero.humanFile : kind === 'trans' ? hero.transFile : hero.file;
                if (!has) return null;
                if (kind === 'human' && hero.file && hero.file === hero.humanFile) return null;
                const url = '/api/comfyui-music-mv/hero-img?id=' + encodeURIComponent(job.id)
                  + '&index=' + i + '&kind=' + kind + '&v=' + encodeURIComponent(String(has).slice(-16));
                return h('div', { key: kind, style: { display: 'flex', flexDirection: 'column', alignItems: 'center' } },
                  h('img', {
                    src: url,
                    title: label,
                    className: 'mv-thumb',
                    onClick: function () { showZoom(url); },
                  }),
                  h('div', { className: 'mv-thumb-label' }, label)
                );
              };
              // 有本体（神兽/骨架）才展示三套；纯人类角色只有一张定妆，别给他编一个"本体"。
              const thumbs = hero
                ? (hasBeastLook
                  ? [thumb('file', '本体'), thumb('human', '人形'), thumb('trans', '过渡')]
                  : [hero.humanFile ? thumb('human', '定妆') : thumb('file', '定妆')])
                : (job
                  ? [h('div', {
                    title: '这个角色还没出定妆图',
                    className: 'mv-thumb-empty',
                  }, '未定妆')]
                  : []);
              return h('div', { key: i, className: 'mv-char' },
                h('div', { className: 'mv-char-thumbs' }, ...thumbs),
                h('input', {
                  value: c.name || '',
                  placeholder: '名字',
                  onChange: function (e) {
                    const next = list.slice(); next[i] = { ...next[i], name: e.target.value }; setCharacters(next);
                  },
                  className: 'mv-input',
                }),
                h('textarea', {
                  value: c.look || '',
                  rows: 2,
                  placeholder: '外形：年龄性别、发型发色、五官特征、服装/铠甲/配饰',
                  onChange: function (e) {
                    const next = list.slice(); next[i] = { ...next[i], look: e.target.value }; setCharacters(next);
                  },
                  className: 'mv-ta', style: { flex: 1, minHeight: '52px' },
                }),
                h('button', {
                  className: 'cfl-chip', style: { fontSize: '11px' }, title: '删掉这个角色',
                  onClick: function () { setCharacters(list.slice().filter(function (_, k) { return k !== i; })); },
                }, '✕')
              );
            })
            ),
            h('button', {
              className: 'cfl-chip', style: { fontSize: '12px' }, onClick: function () {
                setCharacters(planCharacters().concat([{ name: '', look: '' }]));
              },
            }, '+ 添加角色'),
            job ? h('button', {
              className: 'cfl-chip', style: { fontSize: '12px' }, disabled: !!busy,
              title: '按「原形 / 人形」各出一张重做定妆图，不动已经出好的静帧',
              onClick: async function () {
                setBusy('正在重出定妆图…'); setError('');
                try {
                  const r = await fetch('/api/comfyui-music-mv/heroes', {
                    method: 'POST', headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ id: job.id }),
                  });
                  const j = await r.json();
                  if (!r.ok) throw new Error(j.message || j.error || ('HTTP ' + r.status));
                  await refreshJob(job.id);
                } catch (e) { setError(String(e && e.message || e)); } finally { setBusy(''); }
              },
            }, '♻ 重出定妆') : null,
            h('div', { className: 'mv-subcard' },
              h('div', { className: 'mv-subcard-t' }, '画面与声音'),
              h('div', { className: 'mv-field' },
                h('div', { className: 'mv-label' }, '视觉基调（只喂画面：胶片感、调色、镜头、光线）'),
                h('textarea', {
                  value: plan.look || '', rows: 2, className: 'mv-ta',
                  placeholder: '例如：35mm 胶片颗粒，低饱和青橙调色，浅景深，逆光边缘光',
                  onChange: function (e) { patchPlan({ look: e.target.value }); },
                })
              ),
              h('div', { className: 'mv-field' },
                h('div', { className: 'mv-label' }, '曲风（喂给 YuE2）'),
                h('textarea', {
                  value: plan.style || '', rows: 1, className: 'mv-ta',
                  onChange: function (e) { patchPlan({ style: e.target.value }); },
                })
              ),
              h('div', { className: 'mv-field' },
                h('div', { className: 'mv-label' }, '歌词（YuE2 按段落标记唱）'),
                h('textarea', {
                  value: plan.lyrics || '', rows: 8, className: 'mv-ta',
                  onChange: function (e) { patchPlan({ lyrics: e.target.value }); },
                })
              )
            ),
            h('div', { className: 'mv-actions' },
              h('button', { className: 'cfl-chip', style: { fontWeight: 600 }, disabled: !!busy || running, onClick: function () { startRun('frames'); } }, '① 出歌 + 定妆 + 静帧'),
              job && job.status === 'paused' ? h('button', { className: 'cfl-chip', style: { fontWeight: 600 }, disabled: !!busy, onClick: function () { continueRun('videos'); } }, '② 出视频 + 合成') : null,
              job && job.status === 'interrupted' ? h('button', { className: 'cfl-chip', style: { fontWeight: 600 }, disabled: !!busy, onClick: function () { continueRun(job.shots && job.shots.some(function (s) { return s.frame; }) ? 'videos' : 'frames'); } }, '↻ 续跑（进程重启过）') : null,
              h('button', { className: 'cfl-chip', disabled: !!busy || running, onClick: function () { startRun('all'); } }, '一键到底'),
              h('button', { className: 'cfl-chip', disabled: !job, title: '把剧本和参数存成 json', onClick: exportPlan }, '⇩ 导出方案'),
              job ? h('button', {
                className: 'cfl-chip', title: '把定妆、节奏、剧本、分镜板导成可打印的导演本',
                onClick: function () { downloadFile('/api/comfyui-music-mv/book?download=1&id=' + encodeURIComponent(job.id), '导演本.html'); },
              }, '📖 导演本') : null,
              job ? h('button', {
                className: 'cfl-chip', title: '把已出好的静帧拼成一张 PNG 分镜板',
                onClick: function () { downloadFile('/api/comfyui-music-mv/board?download=1&id=' + encodeURIComponent(job.id), '分镜板.png'); },
              }, '🖼 分镜板') : null,
              h('button', { className: 'cfl-chip', title: '导入之前导出的方案', onClick: importPlan }, '⇧ 导入'),
              h('label', { className: 'mv-check' },
                h('input', { type: 'checkbox', checked: cfg.tailLink, onChange: function (e) { setCfg(function (p) { return { ...p, tailLink: e.target.checked }; }); } }),
                '末帧接龙'
              ),
              h('label', { className: 'mv-check', title: '有歌词的镜头会把歌切一段喂给模型，让它按这段歌声对口型' },
                h('input', { type: 'checkbox', checked: cfg.lipSync, onChange: function (e) { setCfg(function (p) { return { ...p, lipSync: e.target.checked }; }); } }),
                '对口型'
              ),
              h('label', { className: 'mv-check', title: '合成后再过一遍：2.35:1 遮幅 + 调色 + 暗角 + 胶片颗粒 + 片名（需要 ffmpeg）' },
                h('input', { type: 'checkbox', checked: cfg.grade, onChange: function (e) { setCfg(function (p) { return { ...p, grade: e.target.checked }; }); } }),
                '电影质感'
              )
            )
          )
        : null;

      // 根节点自己当滚动容器：宿主给的面板槽位不滚动，内容一多就被裁掉（滚轮完全不动）。
      return h('div', { className: 'mv' },
        h('div', { className: 'mv-wrap' },
        h('div', { className: 'mv-head' },
          h('h2', { className: 'mv-title' }, '音乐 MV'),
          h('span', { style: muted },
            online ? 'ComfyUI ' + meta.comfyui.version + (vram !== null ? ' · 空闲 ' + vram + ' GB' : '')
              : metaError ? '状态未知：' + metaError
              : !meta ? '正在连接…' : 'ComfyUI 离线'),
          online ? null : h('button', { className: 'cfl-chip', style: { fontSize: '11px' }, onClick: function () { loadMeta(0); } }, '重试'),
          h('span', {
            className: 'mv-pill ' + (meta && meta.ffmpeg && meta.ffmpeg.ok ? 'ok' : 'warn'),
            title: meta && meta.ffmpeg && meta.ffmpeg.ok ? String(meta.ffmpeg.version || '已检测到 ffmpeg') : '没找到 ffmpeg：镜头之间只能硬切',
          }, meta && meta.ffmpeg && meta.ffmpeg.ok ? '转场可用' : '转场不可用（硬切）')
        ),
        h('div', { className: 'mv-sub' }, '主题 → 剧本 → 出歌 → 定妆 → 每镜静帧（可改可重 roll）→ 末帧接龙出视频 → 拼成一支 MV'),
        stepper,

        h('div', { className: 'mv-card' },
          h('div', { className: 'mv-card-h' },
            h('div', { className: 'mv-card-t' }, '主题'),
            h('div', { className: 'mv-card-sub' }, '一句话就够，越具体越好')
          ),
          h('textarea', {
            className: 'mv-ta',
            value: cfg.theme,
            onChange: function (e) { setCfg(function (p) { return { ...p, theme: e.target.value }; }); },
            rows: 2,
            placeholder: '一句话说清想拍什么：失恋的男生在雨夜街头走了很久，最后在天亮时笑了一下',
          }),
        h('div', { className: 'mv-grid' },
          num('歌长(秒)', 'duration', 15, 600, 5),
          num('静帧(MP)', 'frameMegapixels', 1, 16, 0.5),
          num('视频(MP)', 'megapixels', 0.2, 1.0, 0.05),
          h('label', { className: 'mv-field' },
            h('span', { className: 'mv-label' }, '比例'),
            h('select', {
              className: 'mv-select',
              value: cfg.aspectRatio,
              onChange: function (e) { setCfg(function (p) { return { ...p, aspectRatio: e.target.value }; }); },
            }, ASPECTS.map(function (a) { return h('option', { key: a[0], value: a[0] }, a[1]); }))),
        ),
          h('div', { className: 'mv-actions' },
            h('button', { className: 'cfl-chip', style: { fontWeight: 600 }, disabled: !!busy || running, onClick: makePlan },
              busy ? '写剧本中…' : '🎬 生成剧本'),
            h('button', { className: 'cfl-chip', title: '导入之前导出的方案 json', onClick: importPlan }, '⇧ 导入方案'),
            h('button', {
              className: 'cfl-chip',
              title: '清空当前的剧本、定妆与静帧引用，从零开始',
              onClick: function () {
                if (plan && !window.confirm('新建会清掉当前剧本和面板里的任务，确定？')) return;
                setPlan(null); setLint(null); setJob(null); setOpenShot(null); setError('');
                setCfg(function (p) { return { ...p, theme: '', style: '' }; });
                pinJob('');
                try {
                  window.localStorage.removeItem(PLAN_RUN_KEY);
                  window.localStorage.removeItem(JOB_KEY);
                  window.localStorage.setItem(FORM_KEY, JSON.stringify({ cfg: { ...CFG_DEFAULTS }, plan: null }));
                } catch { /* ignore */ }
              },
            }, '＋ 新建')
          )
        ),

        error ? h('div', { style: { color: '#e05c5c', fontSize: '13px', marginTop: '8px' } }, error) : null,
        busy ? h('div', { style: { ...muted, marginTop: '6px' } }, busy) : null,

        planBody,

        job
          ? h('div', { style: { marginTop: '14px' } },
              h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
                h('span', { style: { fontSize: '13px', fontWeight: 600 } }, job.id),
                h('span', { style: small }, job.status + (job.stageLabel ? ' · ' + job.stageLabel : '')),
                job.song && job.song.duration ? h('span', { style: muted }, '歌 ' + Math.round(job.song.duration) + 's') : null,
                job.song && job.song.file ? h('audio', {
                  ref: audioRef,
                  src: '/api/comfyui-music-mv/song?id=' + encodeURIComponent(job.id) + '&v=' + bust,
                  controls: true,
                  onTimeUpdate: function (e) { setNowTime(e.target.currentTime); },
                  style: { height: '30px', maxWidth: '320px' },
                }) : null
              ),
              job.error ? h('div', { style: { color: '#e05c5c', fontSize: '12px', marginTop: '4px' } }, job.error) : null,

              // 从历史里点回来时，本地没有 plan 状态，这里给一份只读的剧本摘要
              job.plan && !plan
                ? h('div', { style: { ...small, marginTop: '6px', opacity: 0.8 } },
                    '《' + (job.plan.title || '未命名') + '》',
                    job.plan.story && job.plan.story.logline ? ' · ' + job.plan.story.logline : '')
                : null,

              timelineStrip(job.shots, job.plan && job.plan.duration),

              job.shots && job.shots.length
                ? h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '10px', marginTop: '10px' } },
                    job.shots.map(shotCard))
                : null,

              job.status === 'done' && job.file
                ? h('div', { style: { marginTop: '12px' } },
                    h('video', { src: '/api/comfyui-music-mv/media?id=' + encodeURIComponent(job.id) + '&v=' + bust, controls: true, style: { width: '100%', maxWidth: '760px', borderRadius: '8px' } }),
                    h('div', { style: { ...small, marginTop: '4px' } },
                      h('a', { href: '/api/comfyui-music-mv/media?id=' + encodeURIComponent(job.id), target: '_blank', rel: 'noreferrer' }, '打开原文件'),
                      h('button', { className: 'cfl-chip', style: { fontSize: '11px', marginLeft: '8px' }, disabled: !!busy, onClick: restitch }, '重新合成'),
                      job.stitchMode ? h('span', { style: { ...muted, marginLeft: '8px' } }, job.stitchMode) : null
                    )
                  )
                : null
            )
          : null,

        history.length
          ? h('div', { style: { marginTop: '18px' } },
              h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px' } }, '最近生成'),
              history.slice(0, 8).map(function (item) {
                return h('div', { key: item.id, style: { display: 'flex', gap: '8px', alignItems: 'center', ...small, padding: '3px 0' } },
                  h('span', { style: { opacity: 0.6 } }, new Date(item.createdAt).toLocaleString()),
                  h('span', null, item.status),
                  h('span', { style: { opacity: 0.7 } }, (item.plan && item.plan.title ? '《' + item.plan.title + '》' : '') + (item.stageLabel ? ' · ' + item.stageLabel : '')),
                  h('button', { style: { all: 'unset', cursor: 'pointer', opacity: 0.6 }, onClick: function () { pinJob(item.id); setJob(item); } }, '↗')
                );
              })
            )
          : null
        )
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'comfyui-music-mv',
          order: 5,
          label: () => '音乐 MV',
        }, MvIcon));

        ctx.slots.inject('main', () => {
          const disposers = [
            ctx.slots.register({ name: 'main', key: 'comfyui-music-mv' }, MvPanel),
          ];
          return function disposeMain() { disposers.forEach(function (d) { d(); }); };
        });
      },
    };
  },
});
