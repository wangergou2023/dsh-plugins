window.__ModuleLoader__.load({
  id: 'dsh-comfyui-music-mv',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 统一调用：空响应 / 非 JSON 都给能看懂的错误。 */
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

    const ASPECTS = [
      ['16:9 (Widescreen)', '16:9'],
      ['9:16 (Portrait)', '9:16'],
      ['1:1 (Square)', '1:1'],
      ['4:3 (Standard)', '4:3'],
      ['3:4 (Portrait)', '3:4'],
      ['21:9 (Cinematic)', '21:9'],
    ];

    const STAGES = [
      ['song', '出歌'],
      ['plan', '排分镜'],
      ['hero', '定妆图'],
      ['render', '渲染镜头'],
      ['stitch', '拼接压曲'],
    ];

    const FORM_KEY = 'comfyui-music-mv.form.v1';

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
      autoHero: true,
    };

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

    const small = { fontSize: '12px' };
    const mutedText = { fontSize: '12px', opacity: 0.65 };
    const box = { padding: '10px', border: '1px solid rgba(128,128,128,0.25)', borderRadius: '8px' };
    const row = { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-end' };

    function MvPanel() {
      const [initial] = React.useState(function () { return loadForm(); });
      const [meta, setMeta] = React.useState(null);
      const [metaError, setMetaError] = React.useState('');
      const [cfg, setCfg] = React.useState(function () { return { ...CFG_DEFAULTS, ...((initial && initial.cfg) || {}) }; });
      const [plan, setPlan] = React.useState((initial && initial.plan) || null);
      const [planModel, setPlanModel] = React.useState('');
      const [job, setJob] = React.useState(null);
      const [history, setHistory] = React.useState([]);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [openShot, setOpenShot] = React.useState(null);

      React.useEffect(function () {
        try {
          window.localStorage.setItem(FORM_KEY, JSON.stringify({ cfg, plan }));
        } catch { /* 隐私模式写不进去就算了 */ }
      }, [cfg, plan]);

      const loadMeta = React.useCallback(async function (attempt) {
        const tries = typeof attempt === 'number' ? attempt : 0;
        try {
          setMeta(await api('/api/comfyui-music-mv/meta'));
          setMetaError('');
        } catch (err) {
          if (tries < 3) {
            setTimeout(function () { loadMeta(tries + 1); }, 600 * (tries + 1));
            return;
          }
          setMeta({ comfyui: { online: false } });
          setMetaError(String((err && err.message) || err));
        }
      }, []);

      const refreshHistory = React.useCallback(function () {
        api('/api/comfyui-music-mv/jobs')
          .then(function (d) {
            if (!d || !Array.isArray(d.jobs)) return;
            setHistory(d.jobs);
            setJob(function (current) { return current || d.jobs[0] || null; });
          })
          .catch(function () {});
      }, []);

      React.useEffect(function () {
        loadMeta(0);
        refreshHistory();
        const timer = setInterval(refreshHistory, 8000);
        return function () { clearInterval(timer); };
      }, [loadMeta, refreshHistory]);

      // 后台任务轮询：只在跑的时候每 3 秒问一次
      React.useEffect(function () {
        if (!job || (job.status !== 'queued' && job.status !== 'running')) return undefined;
        const timer = setInterval(function () {
          api('/api/comfyui-music-mv/job?id=' + encodeURIComponent(job.id))
            .then(function (next) {
              setJob(next);
              if (next.status === 'done' || next.status === 'failed') refreshHistory();
            })
            .catch(function () {});
        }, 3000);
        return function () { clearInterval(timer); };
      }, [job, refreshHistory]);

      const running = !!(job && (job.status === 'queued' || job.status === 'running'));

      async function makePlan() {
        setError('');
        if (!String(cfg.theme || '').trim()) { setError('先写一个主题'); return; }
        setBusy('正在写剧本…');
        try {
          const data = await api('/api/comfyui-music-mv/plan', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              theme: cfg.theme,
              duration: cfg.duration,
              style: cfg.style,
            }),
          });
          setPlan(data.plan);
          setPlanModel(data.model || '');
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy('');
        }
      }

      async function start() {
        setError('');
        if (!plan) { setError('先生成剧本'); return; }
        if (!String(plan.lyrics || '').trim()) { setError('歌词是空的，出不了歌'); return; }
        setBusy('正在排队…');
        try {
          const data = await api('/api/comfyui-music-mv/run', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              plan,
              theme: cfg.theme,
              duration: plan.duration,
              aspectRatio: cfg.aspectRatio,
              megapixels: cfg.megapixels,
              autoHero: cfg.autoHero,
            }),
          });
          setJob(data.job);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy('');
        }
      }

      function patchPlan(patch) {
        setPlan(function (prev) { return prev ? { ...prev, ...patch } : prev; });
      }

      function patchShot(index, patch) {
        setPlan(function (prev) {
          if (!prev) return prev;
          const shots = prev.shots.map(function (s) { return s.index === index ? { ...s, ...patch } : s; });
          return { ...prev, shots };
        });
      }

      function num(labelText, key, min, max, step) {
        return h('label', { key: key, style: { display: 'flex', flexDirection: 'column', gap: '2px', ...small } },
          labelText,
          h('input', {
            type: 'number', min: min, max: max, step: step, value: cfg[key],
            onChange: function (e) { setCfg(function (prev) { return { ...prev, [key]: Number(e.target.value) }; }); },
            style: { width: '92px' },
          })
        );
      }

      const online = !!(meta && meta.comfyui && meta.comfyui.online);
      const vram = meta && meta.comfyui && typeof meta.comfyui.vramFreeGB === 'number' ? meta.comfyui.vramFreeGB : null;
      const story = (plan && plan.story) || {};
      const shotTotal = plan && Array.isArray(plan.shots) ? plan.shots.length : 0;

      const progressBar = (function () {
        if (!job) return null;
        const done = Array.isArray(job.shots) ? job.shots.filter(function (s) { return s.status === 'done'; }).length : 0;
        const total = job.total || (Array.isArray(job.shots) ? job.shots.length : 0);
        const stageIndex = STAGES.findIndex(function (s) { return s[0] === job.stage; });
        return h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', margin: '8px 0' } },
          STAGES.map(function (s, i) {
            const active = job.stage === s[0];
            const passed = stageIndex > i || job.status === 'done';
            return h('span', {
              key: s[0],
              style: {
                ...small,
                padding: '2px 8px',
                borderRadius: '999px',
                border: '1px solid rgba(128,128,128,0.35)',
                background: active ? 'rgba(120,170,255,0.22)' : 'transparent',
                opacity: passed ? 0.55 : active ? 1 : 0.8,
                fontWeight: active ? 600 : 400,
              },
            }, (passed ? '✓ ' : '') + s[1]);
          }),
          total ? h('span', { style: { ...small, opacity: 0.7 } }, '镜头 ' + done + '/' + total) : null
        );
      })();

      return h('div', { style: { padding: '4px 2px' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px', flexWrap: 'wrap' } },
          h('h2', { style: { margin: 0, fontSize: '18px' } }, '音乐 MV'),
          h('span', { style: mutedText },
            online
              ? 'ComfyUI ' + meta.comfyui.version + ' · ' + meta.comfyui.device + (vram !== null ? ' · 空闲 ' + vram + ' GB' : '')
              : metaError ? '状态未知：' + metaError
              : !meta ? '正在连接 ComfyUI…'
              : 'ComfyUI 离线'),
          online ? null : h('button', { className: 'cfl-chip', style: { fontSize: '11px' }, onClick: function () { loadMeta(0); } }, '重试连接')
        ),
        h('div', { style: { ...small, opacity: 0.6, marginBottom: '10px' } },
          '主题 → 剧本歌词 → 每镜 ' + ((meta && meta.limits && meta.limits.shotMinSeconds) || 5) + '–' + ((meta && meta.limits && meta.limits.shotMaxSeconds) || 15) + ' 秒视频 → 拼成一支 MV，音轨压整首原曲'),

        // 1. 主题
        h('div', null,
          h('div', { style: { ...small, opacity: 0.7, marginBottom: '4px' } }, '① 主题：一句话说清想拍什么'),
          h('textarea', {
            value: cfg.theme,
            onChange: function (e) { setCfg(function (prev) { return { ...prev, theme: e.target.value }; }); },
            rows: 2,
            placeholder: '例如：失恋的男生在雨夜街头走了很久，最后在天亮时笑了一下',
            style: { width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '13px' },
          })
        ),

        h('div', { style: { ...row, marginTop: '10px' } },
          num('歌长(秒)', 'duration', 15, 600, 5),
          num('像素(MP)', 'megapixels', 0.2, 1.0, 0.05),
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', ...small } },
            '比例',
            h('select', {
              value: cfg.aspectRatio,
              onChange: function (e) { setCfg(function (prev) { return { ...prev, aspectRatio: e.target.value }; }); },
            }, ASPECTS.map(function (a) { return h('option', { key: a[0], value: a[0] }, a[1]); }))
          ),
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', ...small } },
            '曲风（选填）',
            h('input', {
              type: 'text',
              value: cfg.style,
              placeholder: '留空让 AI 定',
              onChange: function (e) { setCfg(function (prev) { return { ...prev, style: e.target.value }; }); },
              style: { width: '220px' },
            })
          ),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', ...small } },
            h('input', {
              type: 'checkbox',
              checked: cfg.autoHero,
              onChange: function (e) { setCfg(function (prev) { return { ...prev, autoHero: e.target.checked }; }); },
            }),
            '自动生成主角定妆图'
          ),
          h('button', {
            className: 'cfl-chip',
            disabled: busy !== '' || running,
            onClick: makePlan,
            style: { fontWeight: 600 },
          }, busy === '正在写剧本…' ? '写剧本中…' : '🎬 生成剧本')
        ),

        error ? h('div', { style: { color: '#e05c5c', fontSize: '13px', marginTop: '10px' } }, error) : null,
        busy && busy !== '正在写剧本…' ? h('div', { style: { ...small, opacity: 0.7, marginTop: '8px' } }, busy) : null,

        // 2. 剧本
        plan
          ? h('div', { style: { marginTop: '14px', ...box } },
              h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
                h('div', { style: { fontSize: '15px', fontWeight: 600 } }, '《' + (plan.title || '未命名') + '》'),
                h('span', { style: mutedText }, plan.duration + 's · ' + shotTotal + ' 个镜头' + (planModel ? ' · ' + planModel : ''))
              ),
              story.logline ? h('div', { style: { ...small, marginTop: '6px' } }, '故事：' + story.logline) : null,
              story.arc ? h('div', { style: mutedText }, '情绪：' + story.arc) : null,
              story.ending ? h('div', { style: mutedText }, '结尾：' + story.ending) : null,
              story.notes ? h('div', { style: { ...mutedText, fontStyle: 'italic' } }, '阐述：' + story.notes) : null,

              h('div', { style: { marginTop: '10px', ...small, opacity: 0.7 } }, '主角（全片同一个人，可改）'),
              h('textarea', {
                value: plan.character || '',
                onChange: function (e) { patchPlan({ character: e.target.value }); },
                rows: 2,
                style: { width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '12px' },
              }),

              h('div', { style: { marginTop: '10px', ...small, opacity: 0.7 } }, '曲风 + 歌词（会直接喂给 YuE2，可改）'),
              h('textarea', {
                value: plan.style || '',
                onChange: function (e) { patchPlan({ style: e.target.value }); },
                rows: 1,
                style: { width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '12px', marginBottom: '4px' },
              }),
              h('textarea', {
                value: plan.lyrics || '',
                onChange: function (e) { patchPlan({ lyrics: e.target.value }); },
                rows: 10,
                style: { width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '12px' },
              }),

              h('div', { style: { marginTop: '12px', ...small, opacity: 0.7 } }, '分镜表（点开可改画面描述）'),
              ...(plan.shots || []).map(function (s) {
                const open = openShot === s.index;
                return h('div', { key: s.index, style: { borderTop: s.index === 0 ? 'none' : '1px solid rgba(128,128,128,0.18)', padding: '6px 0' } },
                  h('div', {
                    style: { display: 'flex', gap: '8px', alignItems: 'baseline', cursor: 'pointer', ...small },
                    onClick: function () { setOpenShot(open ? null : s.index); },
                  },
                    h('span', { style: { opacity: 0.55, minWidth: '58px' } }, s.start + '-' + s.end + 's'),
                    h('span', { style: { fontWeight: 600 } }, (s.index + 1) + '. ' + (s.label || '')),
                    s.section ? h('span', { style: { opacity: 0.55 } }, '对位 ' + s.section) : null,
                    s.beat ? h('span', { style: { opacity: 0.55 } }, '· ' + s.beat) : null,
                    h('span', { style: { marginLeft: 'auto', opacity: 0.5 } }, open ? '收起' : '展开')
                  ),
                  open
                    ? h('div', { style: { marginTop: '4px' } },
                        s.camera || s.transition
                          ? h('div', { style: { ...mutedText, marginBottom: '4px' } },
                              '运镜：' + (s.camera || '—') + (s.transition ? ' ｜ 转场：' + s.transition : ''))
                          : null,
                        h('textarea', {
                          value: s.prompt || '',
                          onChange: function (e) { patchShot(s.index, { prompt: e.target.value }); },
                          rows: 3,
                          style: { width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '12px' },
                        })
                      )
                    : h('div', { style: { ...mutedText, paddingLeft: '58px' } }, s.prompt)
                );
              }),

              h('div', { style: { ...row, marginTop: '12px' } },
                h('button', {
                  className: 'cfl-chip',
                  disabled: busy !== '' || running,
                  onClick: start,
                  style: { fontWeight: 600 },
                }, running ? '生成中…' : '🎥 开始生成 MV'),
                h('span', { style: mutedText }, '整支要跑很久（每镜可能十几分钟），可以关掉页面，任务在后台跑')
              )
            )
          : null,

        // 3. 进度
        job
          ? h('div', { style: { marginTop: '14px', ...box } },
              h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
                h('span', { style: { fontSize: '13px', fontWeight: 600 } }, job.id),
                h('span', { style: small }, job.status + (job.stageLabel ? ' · ' + job.stageLabel : '') + (job.elapsedSeconds ? ' · ' + job.elapsedSeconds + 's' : '')),
                job.song && job.song.duration ? h('span', { style: mutedText }, '歌 ' + Math.round(job.song.duration) + 's') : null
              ),
              progressBar,
              job.error ? h('div', { style: { color: '#e05c5c', fontSize: '12px' } }, job.error) : null,

              job.song && job.song.file
                ? h('div', { style: { marginTop: '6px' } },
                    h('div', { style: { ...small, opacity: 0.6 } }, '歌：'),
                    h('audio', { src: '/api/comfyui-music-mv/song?id=' + encodeURIComponent(job.id), controls: true, style: { width: '100%', maxWidth: '520px' } })
                  )
                : null,

              Array.isArray(job.shots) && job.shots.length
                ? h('div', { style: { marginTop: '8px' } },
                    job.shots.map(function (s) {
                      const color = s.status === 'done' ? '#4caf7d' : s.status === 'failed' ? '#e05c5c' : s.status === 'running' ? '#e0a030' : undefined;
                      return h('div', { key: s.index, style: { display: 'flex', gap: '8px', alignItems: 'center', ...small, padding: '2px 0' } },
                        h('span', { style: { opacity: 0.5, minWidth: '58px' } }, s.start + '-' + s.end + 's'),
                        h('span', { style: { color, minWidth: '64px' } }, s.status),
                        h('span', { style: { flex: 1, opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.label || s.prompt || ''),
                        s.error ? h('span', { style: { color: '#e05c5c' } }, s.error) : null,
                        s.status === 'done'
                          ? h('button', {
                              className: 'cfl-chip',
                              style: { fontSize: '11px' },
                              onClick: function () {
                                window.open('/api/comfyui-music-mv/clip?id=' + encodeURIComponent(job.id) + '&index=' + s.index, '_blank');
                              },
                            }, '看这一段')
                          : null
                      );
                    })
                  )
                : null,

              job.status === 'done' && job.file
                ? h('div', { style: { marginTop: '10px' } },
                    h('video', { src: '/api/comfyui-music-mv/media?id=' + encodeURIComponent(job.id), controls: true, style: { width: '100%', maxWidth: '720px', borderRadius: '6px' } }),
                    h('a', {
                      href: '/api/comfyui-music-mv/media?id=' + encodeURIComponent(job.id),
                      target: '_blank', rel: 'noreferrer', style: { ...small, marginLeft: '8px' },
                    }, '打开原文件')
                  )
                : null
            )
          : null,

        // 4. 历史
        history.length
          ? h('div', { style: { marginTop: '18px' } },
              h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px' } }, '最近生成'),
              history.slice(0, 10).map(function (item) {
                return h('div', {
                  key: item.id,
                  style: { display: 'flex', gap: '8px', alignItems: 'center', ...small, padding: '3px 0' },
                },
                  h('span', { style: { opacity: 0.6 } }, new Date(item.createdAt).toLocaleString()),
                  h('span', null, item.status),
                  h('span', { style: { opacity: 0.7 } }, (item.plan && item.plan.title ? '《' + item.plan.title + '》' : '') + (item.stageLabel ? ' · ' + item.stageLabel : '')),
                  item.status === 'done'
                    ? h('a', { href: '/api/comfyui-music-mv/media?id=' + encodeURIComponent(item.id), target: '_blank', rel: 'noreferrer' }, '打开')
                    : h('span', { style: { opacity: 0.5 } }, item.error || ''),
                  h('button', {
                    style: { all: 'unset', cursor: 'pointer', opacity: 0.6 },
                    title: '查看',
                    onClick: function () { setJob(item); },
                  }, '↗')
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
