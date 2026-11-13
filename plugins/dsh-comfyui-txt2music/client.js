window.__ModuleLoader__.load({
  id: 'dsh-comfyui-txt2music',
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
      if (!res.ok) throw new Error((data && (data.message || data.error)) || ('HTTP ' + res.status));
      if (!data) throw new Error('接口返回空响应（HTTP ' + res.status + '）');
      return data;
    }

    const FORM_KEY = 'comfyui-txt2music.form.v1';

    const DEFAULTS = {
      style: 'Upbeat indie pop with warm female vocals, bright electric guitars, punchy drums, melodic bass',
      lyrics: '[Verse]\nMorning light across the window\nCity waking down below\n\n[Chorus]\nWe are running through the daylight\nNever looking back again',
      duration: 120,
      useAbc: true,
      mode: 'full',
      steps: 32,
      cfg: 1,
      seed: '',
      format: 'flac',
      quality: '',
    };

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

    function MusicIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20;
      const active = !!(props && props.active);
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: active ? 1.9 : 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('path', { key: 'a', d: 'M9 18V6l10-2v12' }),
        h('circle', { key: 'b', cx: '6.5', cy: '18', r: '2.5' }),
        h('circle', { key: 'c', cx: '16.5', cy: '16', r: '2.5' })
      );
    }

    function MusicPanel() {
      const [initial] = React.useState(function () { return loadForm(); });
      const [form, setForm] = React.useState(function () {
        return { ...DEFAULTS, ...(initial || {}) };
      });
      const [meta, setMeta] = React.useState(null);
      const [metaError, setMetaError] = React.useState('');
      const [job, setJob] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [polishing, setPolishing] = React.useState(false);
      const [prevStyle, setPrevStyle] = React.useState('');
      const [history, setHistory] = React.useState([]);
      const [outputs, setOutputs] = React.useState([]);

      React.useEffect(function () {
        try { window.localStorage.setItem(FORM_KEY, JSON.stringify(form)); } catch { /* 忽略 */ }
      }, [form]);

      const loadMeta = React.useCallback(async function (attempt) {
        const tries = typeof attempt === 'number' ? attempt : 0;
        try {
          const data = await api('/api/comfyui-txt2music/meta');
          setMeta(data);
          setOutputs(Array.isArray(data.outputs) ? data.outputs : []);
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
        api('/api/comfyui-txt2music/jobs')
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
        const timer = setInterval(refreshHistory, 5000);
        return function () { clearInterval(timer); };
      }, [loadMeta, refreshHistory]);

      React.useEffect(function () {
        if (!job || (job.status !== 'queued' && job.status !== 'running')) return undefined;
        const timer = setInterval(function () {
          api('/api/comfyui-txt2music/job?id=' + encodeURIComponent(job.id))
            .then(function (next) {
              setJob(next);
              if (next.status === 'done' || next.status === 'failed') refreshHistory();
            })
            .catch(function () {});
        }, 2000);
        return function () { clearInterval(timer); };
      }, [job, refreshHistory]);

      function set(key, value) {
        setForm(function (prev) { return { ...prev, [key]: value }; });
      }

      async function polish() {
        setError('');
        if (!String(form.style || '').trim()) { setError('先写一点曲风描述，再润化'); return; }
        setPolishing(true);
        try {
          const data = await api('/api/comfyui-txt2music/polish', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ style: form.style }),
          });
          setPrevStyle(form.style);
          set('style', data.text || form.style);
        } catch (err) {
          setError('润化失败：' + String((err && err.message) || err));
        } finally {
          setPolishing(false);
        }
      }

      async function generate() {
        setError('');
        if (!String(form.style || '').trim()) { setError('曲风描述不能为空'); return; }
        if (!String(form.lyrics || '').trim()) { setError('歌词不能为空'); return; }
        setBusy('正在提交…');
        try {
          const body = { ...form };
          if (body.seed === '' || body.seed === undefined) delete body.seed;
          const data = await api('/api/comfyui-txt2music/run', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          setJob({ id: data.job.id, status: data.job.status });
          refreshHistory();
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy('');
        }
      }

      const online = meta && meta.comfyui && meta.comfyui.online;
      const vram = meta && meta.comfyui ? meta.comfyui.vramFreeGB : null;
      const active = job && (job.status === 'queued' || job.status === 'running');
      const audioSrc = job && job.status === 'done' ? '/api/comfyui-txt2music/media?id=' + encodeURIComponent(job.id) : null;

      function num(label, key, min, max, step, width) {
        return h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
          label,
          h('input', {
            type: 'number', min, max, step, value: form[key],
            onChange: function (e) {
              const v = e.target.value;
              set(key, key === 'seed' ? v : Number(v));
            },
            style: { width: width || '80px' },
          })
        );
      }

      return h('div', { style: { padding: '18px 20px', maxWidth: '1000px' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' } },
          h('h2', { style: { margin: 0, fontSize: '18px' } }, '文生音乐'),
          h('span', { style: { fontSize: '12px', opacity: 0.65 } },
            online
              ? 'YuE2 3B · ComfyUI ' + meta.comfyui.version + ' · ' + meta.comfyui.device + (vram !== null ? ' · 空闲 ' + vram + ' GB' : '')
              : metaError ? '状态未知：' + metaError
              : !meta ? '正在连接 ComfyUI…'
              : 'ComfyUI 离线'),
          online ? null : h('button', {
            className: 'cfl-chip', style: { fontSize: '11px' },
            onClick: function () { loadMeta(0); },
          }, '重试连接')
        ),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '4px' } },
          h('span', { style: { fontSize: '12px', opacity: 0.65 } },
            '曲风描述：写清流派、乐器、人声、情绪，例如「Upbeat indie pop, warm female vocals, bright guitars」'),
          h('button', {
            className: 'cfl-chip', disabled: polishing, onClick: polish, style: { fontSize: '12px' },
            title: '用当前会话的模型把曲风描述写得更专业',
          }, polishing ? '润化中…' : '✨ AI 润化'),
          prevStyle
            ? h('button', {
                className: 'cfl-chip', style: { fontSize: '12px' },
                onClick: function () { set('style', prevStyle); setPrevStyle(''); },
              }, '↩ 撤销润化')
            : null
        ),
        h('textarea', {
          value: form.style,
          onChange: function (e) { set('style', e.target.value); },
          rows: 2,
          style: { width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '13px', marginBottom: '10px' },
        }),

        h('div', { style: { fontSize: '12px', opacity: 0.65, marginBottom: '4px' } },
          '歌词：用 [Verse] / [Chorus] 分段，每行一句；空白行会被当成段落分隔'),
        h('textarea', {
          value: form.lyrics,
          onChange: function (e) { set('lyrics', e.target.value); },
          rows: 8,
          style: { width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '13px' },
        }),
        h('div', { style: { fontSize: '11px', opacity: 0.5, marginTop: '2px' } },
          String(form.lyrics || '').length + ' 字符 · ' + String(form.lyrics || '').split('\n').filter(function (l) { return l.trim(); }).length + ' 行'),

        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-end', marginTop: '12px' } },
          num('最长时长(秒)', 'duration', 10, 600, 10, '92px'),
          num('步数', 'steps', 8, 80, 1, '68px'),
          num('CFG', 'cfg', 1, 10, 0.1, '68px'),
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
            '种子',
            h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
              h('input', {
                type: 'number', placeholder: '随机', value: form.seed,
                onChange: function (e) { set('seed', e.target.value); },
                style: { width: '92px' },
              }),
              h('button', {
                className: 'cfl-chip', title: '随机一个种子',
                onClick: function () { set('seed', String(Math.floor(Math.random() * 2 ** 31))); },
              }, '🎲')
            )
          ),
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
            '格式',
            h('select', {
              value: form.format,
              onChange: function (e) { set('format', e.target.value); },
              style: { fontSize: '12px' },
            }, ['flac', 'mp3', 'opus'].map(function (f) { return h('option', { key: f, value: f }, f); }))
          ),
          form.format !== 'flac'
            ? h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
                '码率',
                h('select', {
                  value: form.quality,
                  onChange: function (e) { set('quality', e.target.value); },
                  style: { fontSize: '12px' },
                },
                  h('option', { value: '' }, '默认'),
                  (form.format === 'mp3' ? ['V0', '128k', '320k'] : ['64k', '96k', '128k', '192k', '320k'])
                    .map(function (q) { return h('option', { key: q, value: q }, q); })
                )
              )
            : null,
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' } },
            h('input', {
              type: 'checkbox', checked: form.useAbc,
              onChange: function (e) { set('useAbc', e.target.checked); },
            }),
            '先写曲式'
          ),
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
            '模式',
            h('select', {
              value: form.mode,
              onChange: function (e) { set('mode', e.target.value); },
              style: { fontSize: '12px' },
            },
              h('option', { value: 'full' }, '旋律+和弦'),
              h('option', { value: 'melody' }, '仅旋律')
            )
          ),
          h('button', {
            className: 'cfl-chip', onClick: generate, disabled: busy !== '' || active,
            style: { fontWeight: 600 },
          }, active ? '生成中…' : '开始生成')
        ),

        error ? h('div', { style: { color: '#e05c5c', fontSize: '13px', marginTop: '10px' } }, error) : null,
        busy ? h('div', { style: { opacity: 0.7, fontSize: '12px', marginTop: '8px' } }, busy) : null,

        job
          ? h('div', { style: { marginTop: '16px' } },
              h('div', { style: { fontSize: '12px', marginBottom: '8px' } },
                job.id + ' · ' + job.status
                + (job.elapsedSeconds ? ' · ' + job.elapsedSeconds + 's' : '')
                + (job.summary && job.summary.duration ? ' · 上限 ' + Math.round(job.summary.duration) + 's' : '')
                + (job.summary && job.summary.seed !== undefined ? ' · 种子 ' + job.summary.seed : '')),
              job.error ? h('div', { style: { color: '#e05c5c', fontSize: '12px', marginBottom: '8px' } }, job.error) : null,
              audioSrc
                ? h('div', null,
                    h('audio', { src: audioSrc, controls: true, style: { width: '100%', maxWidth: '620px' } }),
                    h('div', { style: { display: 'flex', gap: '12px', marginTop: '6px', fontSize: '12px' } },
                      h('a', { href: audioSrc, download: '', style: { color: '#7aa2ff' } }, '下载音频'),
                      job.summary && job.summary.style
                        ? h('span', { style: { opacity: 0.6 } }, job.summary.style.slice(0, 60))
                        : null
                    )
                  )
                : null
            )
          : null,

        history.length
          ? h('div', { style: { marginTop: '20px' } },
              h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px' } }, '最近生成'),
              history.slice(0, 10).map(function (item) {
                return h('button', {
                  key: item.id,
                  onClick: function () { setJob(item); },
                  style: { all: 'unset', cursor: 'pointer', display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '6px', width: '100%' },
                },
                  h('span', {
                    style: {
                      width: '28px', height: '28px', borderRadius: '14px', flex: '0 0 auto',
                      background: item.status === 'done' ? 'rgba(120,160,255,0.25)' : 'rgba(128,128,128,0.15)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px',
                    },
                  }, item.status === 'done' ? '▶' : '·'),
                  h('span', { style: { fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
                    h('span', null, new Date(item.createdAt).toLocaleString()),
                    h('span', { style: { opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      item.status
                      + (item.summary && item.summary.duration ? ' · ' + Math.round(item.summary.duration) + 's' : '')
                      + (item.summary && item.summary.style ? ' · ' + String(item.summary.style).slice(0, 30) : '')
                      + (item.error ? ' · ' + item.error : ''))
                  )
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
          id: 'comfyui-txt2music',
          order: 7,
          label: () => '文生音乐',
        }, MusicIcon));

        ctx.slots.inject('main', () => {
          const disposers = [
            ctx.slots.register({ name: 'main', key: 'comfyui-txt2music' }, MusicPanel),
          ];
          return function disposeMain() { disposers.forEach(function (d) { d(); }); };
        });
      },
    };
  },
});
