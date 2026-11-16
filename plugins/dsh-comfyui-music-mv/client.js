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

    const CFG_DEFAULTS = {
      theme: '',
      duration: 60,
      aspectRatio: '16:9 (Widescreen)',
      megapixels: 0.4,
      style: '',
      tailLink: true,
      lipSync: true,
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
            setJob(function (cur) { return cur || d.jobs[0] || null; });
          })
          .catch(function () {});
      }, []);

      React.useEffect(function () {
        loadMeta(0);
        refreshHistory();
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
        setBusy('正在写剧本…');
        try {
          const data = await post('/api/comfyui-music-mv/plan', { theme: cfg.theme, duration: cfg.duration, style: cfg.style });
          setPlan(data.plan);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally { setBusy(''); }
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
            tailLink: cfg.tailLink,
            lipSync: cfg.lipSync,
            phase,
          });
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
        return h('label', { key: key, style: { display: 'flex', flexDirection: 'column', gap: '2px', ...small } },
          labelText,
          h('input', {
            type: 'number', min: min, max: max, step: step, value: cfg[key],
            onChange: function (e) { setCfg(function (p) { return { ...p, [key]: Number(e.target.value) }; }); },
            style: { width: '92px' },
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
      const stepper = h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', margin: '10px 0' } },
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
        ? h('div', { style: { marginTop: '12px', border: '1px solid rgba(128,128,128,0.22)', borderRadius: '10px', padding: '10px' } },
            h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
              h('div', { style: { fontSize: '15px', fontWeight: 600 } }, '《' + (plan.title || '未命名') + '》'),
              h('span', { style: muted }, plan.duration + 's · ' + (plan.shots || []).length + ' 镜')
            ),
            plan.story && plan.story.logline ? h('div', { style: { ...small, marginTop: '4px' } }, '故事：' + plan.story.logline) : null,
            plan.story && plan.story.arc ? h('div', { style: muted }, '情绪：' + plan.story.arc) : null,
            h('div', { style: { ...muted, marginTop: '8px' } }, '角色（每个角色一张定妆图，全片复用）'),
            ...planCharacters().map(function (c, i) {
              const list = planCharacters();
              return h('div', { key: i, style: { display: 'flex', gap: '6px', marginBottom: '4px', alignItems: 'flex-start' } },
                h('input', {
                  value: c.name || '',
                  placeholder: '名字',
                  onChange: function (e) {
                    const next = list.slice(); next[i] = { ...next[i], name: e.target.value }; setCharacters(next);
                  },
                  style: { width: '112px', fontSize: '12px' },
                }),
                h('textarea', {
                  value: c.look || '',
                  rows: 2,
                  placeholder: '外形：年龄性别、发型发色、五官特征、服装/铠甲/配饰',
                  onChange: function (e) {
                    const next = list.slice(); next[i] = { ...next[i], look: e.target.value }; setCharacters(next);
                  },
                  style: { flex: 1, resize: 'vertical', fontFamily: 'inherit', fontSize: '12px' },
                }),
                h('button', {
                  className: 'cfl-chip', style: { fontSize: '11px' }, title: '删掉这个角色',
                  onClick: function () { setCharacters(list.slice().filter(function (_, k) { return k !== i; })); },
                }, '✕')
              );
            }),
            h('button', {
              className: 'cfl-chip', style: { fontSize: '12px' }, onClick: function () {
                setCharacters(planCharacters().concat([{ name: '', look: '' }]));
              },
            }, '+ 添加角色'),
            h('div', { style: { ...muted, marginTop: '6px' } }, '曲风 / 歌词（喂给 YuE2）'),
            h('textarea', {
              value: plan.style || '', rows: 1,
              onChange: function (e) { patchPlan({ style: e.target.value }); },
              style: { width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '12px', marginBottom: '4px' },
            }),
            h('textarea', {
              value: plan.lyrics || '', rows: 8,
              onChange: function (e) { patchPlan({ lyrics: e.target.value }); },
              style: { width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '12px' },
            }),
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } },
              h('button', { className: 'cfl-chip', style: { fontWeight: 600 }, disabled: !!busy || running, onClick: function () { startRun('frames'); } }, '① 出歌 + 定妆 + 静帧'),
              job && job.status === 'paused' ? h('button', { className: 'cfl-chip', style: { fontWeight: 600 }, disabled: !!busy, onClick: function () { continueRun('videos'); } }, '② 出视频 + 合成') : null,
              h('button', { className: 'cfl-chip', disabled: !!busy || running, onClick: function () { startRun('all'); } }, '一键到底'),
              h('button', { className: 'cfl-chip', disabled: !job, title: '把剧本和参数存成 json', onClick: exportPlan }, '⇩ 导出方案'),
              h('button', { className: 'cfl-chip', title: '导入之前导出的方案', onClick: importPlan }, '⇧ 导入'),
              h('label', { style: { display: 'flex', alignItems: 'center', gap: '5px', ...small } },
                h('input', { type: 'checkbox', checked: cfg.tailLink, onChange: function (e) { setCfg(function (p) { return { ...p, tailLink: e.target.checked }; }); } }),
                '末帧接龙'
              ),
              h('label', { title: '有歌词的镜头会把歌切一段喂给模型，让它按这段歌声对口型', style: { display: 'flex', alignItems: 'center', gap: '5px', ...small } },
                h('input', { type: 'checkbox', checked: cfg.lipSync, onChange: function (e) { setCfg(function (p) { return { ...p, lipSync: e.target.checked }; }); } }),
                '对口型'
              )
            )
          )
        : null;

      // 根节点自己当滚动容器：宿主给的面板槽位不滚动，内容一多就被裁掉（滚轮完全不动）。
      return h('div', {
        style: {
          padding: '4px 2px',
          height: '100%',
          maxHeight: '100%',
          overflowY: 'auto',
          overflowX: 'hidden',
          boxSizing: 'border-box',
          overscrollBehavior: 'contain',
        },
      },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
          h('h2', { style: { margin: 0, fontSize: '18px' } }, '音乐 MV'),
          h('span', { style: muted },
            online ? 'ComfyUI ' + meta.comfyui.version + (vram !== null ? ' · 空闲 ' + vram + ' GB' : '')
              : metaError ? '状态未知：' + metaError
              : !meta ? '正在连接…' : 'ComfyUI 离线'),
          online ? null : h('button', { className: 'cfl-chip', style: { fontSize: '11px' }, onClick: function () { loadMeta(0); } }, '重试'),
          h('span', {
            style: {
              fontSize: '11px', padding: '2px 8px', borderRadius: '999px',
              border: '1px solid ' + (meta && meta.ffmpeg && meta.ffmpeg.ok ? 'rgba(90,190,140,0.6)' : 'rgba(128,128,128,0.3)'),
              color: meta && meta.ffmpeg && meta.ffmpeg.ok ? '#5abe8c' : undefined,
              opacity: meta && meta.ffmpeg && meta.ffmpeg.ok ? 1 : 0.6,
            },
            title: meta && meta.ffmpeg && meta.ffmpeg.ok ? String(meta.ffmpeg.version || '已检测到 ffmpeg') : '没找到 ffmpeg：镜头之间只能硬切',
          }, meta && meta.ffmpeg && meta.ffmpeg.ok ? '转场可用' : '转场不可用（硬切）')
        ),
        h('div', { style: { ...muted, marginTop: '2px' } }, '主题 → 剧本 → 出歌 → 定妆 → 每镜静帧（可改可重 roll）→ 末帧接龙出视频 → 拼成一支 MV'),
        stepper,

        // ① 主题
        h('div', { style: { marginTop: '4px' } },
          h('textarea', {
            value: cfg.theme,
            onChange: function (e) { setCfg(function (p) { return { ...p, theme: e.target.value }; }); },
            rows: 2,
            placeholder: '一句话说清想拍什么：失恋的男生在雨夜街头走了很久，最后在天亮时笑了一下',
            style: { width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '13px' },
          })
        ),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-end', marginTop: '8px' } },
          num('歌长(秒)', 'duration', 15, 600, 5),
          num('像素(MP)', 'megapixels', 0.2, 1.0, 0.05),
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', ...small } }, '比例',
            h('select', {
              value: cfg.aspectRatio,
              onChange: function (e) { setCfg(function (p) { return { ...p, aspectRatio: e.target.value }; }); },
            }, ASPECTS.map(function (a) { return h('option', { key: a[0], value: a[0] }, a[1]); }))),
          h('button', { className: 'cfl-chip', style: { fontWeight: 600 }, disabled: !!busy || running, onClick: makePlan },
            busy === '正在写剧本…' ? '写剧本中…' : '🎬 生成剧本'),
          h('button', { className: 'cfl-chip', title: '导入之前导出的方案 json', onClick: importPlan }, '⇧ 导入方案')
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
                  h('button', { style: { all: 'unset', cursor: 'pointer', opacity: 0.6 }, onClick: function () { setJob(item); } }, '↗')
                );
              })
            )
          : null
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
