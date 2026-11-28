window.__ModuleLoader__.load({
  id: 'dsh-comfyui-firstlast',
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

    const ASPECTS = [
      ['16:9 (Widescreen)', '16:9 横屏'],
      ['9:16 (Portrait Widescreen)', '9:16 竖屏'],
      ['1:1 (Square)', '1:1 方形'],
      ['4:3 (Standard)', '4:3'],
      ['3:4 (Portrait Standard)', '3:4'],
      ['21:9 (Ultrawide)', '21:9 宽银幕'],
      ['3:2 (Photo)', '3:2 照片'],
      ['2:3 (Portrait Photo)', '2:3 竖照片'],
    ];

    const FORM_KEY = 'comfyui-firstlast.form.v1';

    const DEFAULTS = {
      aspectRatio: '16:9 (Widescreen)',
      megapixels: 0.4,
      durationSeconds: 5,
      seed: '',
      lightning: true,
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

    function FirstLastIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20;
      const active = !!(props && props.active);
      const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: active ? 1.9 : 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' };
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true }, [
        h('rect', { key: 'a', x: 2.2, y: 5.2, width: 6.4, height: 13.6, rx: 1.6, ...stroke }),
        h('rect', { key: 'b', x: 15.4, y: 5.2, width: 6.4, height: 13.6, rx: 1.6, ...stroke }),
        h('path', { key: 'c', d: 'M9.4 12h5.2M12.9 9.8l2.2 2.2-2.2 2.2', ...stroke }),
      ]);
    }

    function FrameSlot(props) {
      const { title, hint, value, onPick, onClear, onPreview } = props;
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('div', { style: { fontSize: '12px', opacity: 0.75 } }, title),
        value
          ? h('div', { style: { position: 'relative', width: '190px' } },
              h('img', {
                src: '/api/comfyui-firstlast/frames?name=' + encodeURIComponent(value),
                alt: title,
                onClick: onPreview,
                style: { width: '190px', height: '108px', objectFit: 'cover', borderRadius: '8px', border: '1px solid rgba(128,128,128,0.3)', cursor: 'zoom-in', display: 'block' },
              }),
              h('button', {
                onClick: onClear,
                title: '移除',
                style: { all: 'unset', position: 'absolute', top: '4px', right: '6px', cursor: 'pointer', background: 'rgba(0,0,0,0.55)', color: '#fff', borderRadius: '50%', width: '18px', height: '18px', fontSize: '12px', textAlign: 'center', lineHeight: '18px' },
              }, '×'),
              h('div', { style: { fontSize: '11px', opacity: 0.55, marginTop: '3px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, value)
            )
          : h('button', {
              onClick: onPick,
              style: { width: '190px', height: '108px', borderRadius: '8px', border: '1px dashed rgba(128,128,128,0.45)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: '12px', opacity: 0.85 },
            }, hint)
      );
    }

    function FirstLastPanel() {
      const [initial] = React.useState(function () { return loadForm(); });
      const [meta, setMeta] = React.useState(null);
      const [first, setFirst] = React.useState((initial && initial.first) || '');
      const [last, setLast] = React.useState((initial && initial.last) || '');
      const [prompt, setPrompt] = React.useState((initial && initial.prompt) || '');
      const [cfg, setCfg] = React.useState(function () { return { ...DEFAULTS, ...((initial && initial.cfg) || {}) }; });
      const [job, setJob] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [history, setHistory] = React.useState([]);
      const [zoom, setZoom] = React.useState('');

      React.useEffect(function () {
        try {
          window.localStorage.setItem(FORM_KEY, JSON.stringify({ first, last, prompt, cfg }));
        } catch { /* 隐私模式忽略 */ }
      }, [first, last, prompt, cfg]);

      const refreshHistory = React.useCallback(function () {
        api('/api/comfyui-firstlast/jobs')
          .then(function (d) {
            if (!d || !Array.isArray(d.jobs)) return;
            setHistory(d.jobs);
            setJob(function (current) { return current || d.jobs[0] || null; });
          })
          .catch(function () {});
      }, []);

      React.useEffect(function () {
        api('/api/comfyui-firstlast/meta').then(setMeta).catch(function () { setMeta({ alive: null }); });
        refreshHistory();
        const timer = setInterval(refreshHistory, 5000);
        return function () { clearInterval(timer); };
      }, [refreshHistory]);

      React.useEffect(function () {
        if (!job || (job.status !== 'queued' && job.status !== 'running')) return undefined;
        const timer = setInterval(function () {
          api('/api/comfyui-firstlast/job?id=' + encodeURIComponent(job.id))
            .then(function (next) {
              setJob(next);
              if (next.status === 'done' || next.status === 'failed') {
                setBusy('');
                refreshHistory();
              }
            })
            .catch(function () {});
        }, 2000);
        return function () { clearInterval(timer); };
      }, [job, refreshHistory]);

      function pick(setter, label) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = async function () {
          if (!input.files || !input.files[0]) return;
          setError('');
          setBusy('正在上传' + label + '…');
          try {
            const form = new FormData();
            form.append('file', input.files[0]);
            const data = await api('/api/comfyui-firstlast/upload', { method: 'POST', body: form });
            setter(data.name);
          } catch (err) {
            setError(String((err && err.message) || err));
          } finally {
            setBusy('');
          }
        };
        input.click();
      }

      async function generate() {
        setError('');
        if (!prompt.trim()) { setError('先写一句：从首帧到尾帧之间发生了什么'); return; }
        if (!first) { setError('首帧是必填的——没有起点，模型不知道该从哪里动'); return; }
        setBusy('已提交，排队中…');
        try {
          const data = await api('/api/comfyui-firstlast/run', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              prompt: prompt.trim(),
              firstFrame: first,
              lastFrame: last || '',
              aspectRatio: cfg.aspectRatio,
              megapixels: Number(cfg.megapixels) || 0.4,
              durationSeconds: Number(cfg.durationSeconds) || 5,
              seed: cfg.seed === '' ? undefined : Number(cfg.seed),
              lightning: !!cfg.lightning,
            }),
          });
          if (data && data.job) setJob(data.job);
        } catch (err) {
          setError(String((err && err.message) || err));
          setBusy('');
        }
      }

      const running = !!(job && (job.status === 'queued' || job.status === 'running'));
      const done = !!(job && job.status === 'done');
      const active = running || busy !== '';
      const online = meta && meta.alive;

      return h('div', {
        style: {
          padding: '18px 20px', maxWidth: '1080px', height: '100%', overflowY: 'auto', overflowX: 'hidden',
          boxSizing: 'border-box', overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column', gap: '14px',
        },
      },
        h('div', null,
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
            h('div', { style: { fontSize: '19px', fontWeight: 600 } }, '首尾帧生视频'),
            h('div', { style: { fontSize: '12px', opacity: 0.6 } },
              meta == null ? '连接中…'
                : online ? 'ComfyUI ' + (online.version || '') + ' · 空闲 ' + (online.vramFreeGB || '?') + ' GB'
                : 'ComfyUI 离线')
          ),
          h('div', { style: { fontSize: '12px', opacity: 0.6, marginTop: '4px' } },
            '给起点和终点两张图，描述中间发生了什么，模型补出过程；只给首帧也能跑')
        ),

        h('div', { style: { display: 'flex', gap: '18px', flexWrap: 'wrap' } },
          h(FrameSlot, {
            title: '首帧（必填）', hint: '点击上传首帧', value: first,
            onPick: function () { pick(setFirst, '首帧'); },
            onClear: function () { setFirst(''); },
            onPreview: function () { setZoom(first); },
          }),
          h(FrameSlot, {
            title: '尾帧（可选）', hint: '点击上传尾帧', value: last,
            onPick: function () { pick(setLast, '尾帧'); },
            onClear: function () { setLast(''); },
            onPreview: function () { setZoom(last); },
          })
        ),

        h('textarea', {
          value: prompt,
          onChange: function (e) { setPrompt(e.target.value); },
          rows: 3,
          placeholder: '例：他把伞收拢，抬手抹掉玻璃上的水汽；雨渐小，门外的女孩抬起头看过来',
          style: { width: '100%', boxSizing: 'border-box', padding: '10px 12px', borderRadius: '8px', border: '1px solid rgba(128,128,128,0.3)', background: 'transparent', color: 'inherit', fontSize: '13px', resize: 'vertical', lineHeight: 1.6 },
        }),

        h('div', { style: { display: 'flex', gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap' } },
          h('label', { style: { fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '4px' } },
            '比例',
            h('select', {
              value: cfg.aspectRatio,
              onChange: function (e) { setCfg(function (p) { return { ...p, aspectRatio: e.target.value }; }); },
              style: { padding: '5px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.3)', background: 'transparent', color: 'inherit' },
            }, ASPECTS.map(function (a) { return h('option', { key: a[0], value: a[0] }, a[1]); }))
          ),
          h('label', { style: { fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '4px' } },
            '像素(MP)',
            h('input', {
              type: 'number', min: 0.2, max: 1, step: 0.1, value: cfg.megapixels,
              onChange: function (e) { setCfg(function (p) { return { ...p, megapixels: e.target.value }; }); },
              style: { width: '80px', padding: '5px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.3)', background: 'transparent', color: 'inherit' },
            })
          ),
          h('label', { style: { fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '4px' } },
            '时长(秒)',
            h('input', {
              type: 'number', min: 2, max: 15, step: 1, value: cfg.durationSeconds,
              onChange: function (e) { setCfg(function (p) { return { ...p, durationSeconds: e.target.value }; }); },
              style: { width: '80px', padding: '5px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.3)', background: 'transparent', color: 'inherit' },
            })
          ),
          h('label', { style: { fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '4px' } },
            '种子',
            h('input', {
              type: 'text', value: cfg.seed, placeholder: '随机',
              onChange: function (e) { setCfg(function (p) { return { ...p, seed: e.target.value }; }); },
              style: { width: '96px', padding: '5px 8px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.3)', background: 'transparent', color: 'inherit' },
            })
          ),
          h('label', { style: { fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px', paddingBottom: '5px' } },
            h('input', {
              type: 'checkbox', checked: cfg.lightning,
              onChange: function (e) { setCfg(function (p) { return { ...p, lightning: e.target.checked }; }); },
            }),
            '闪电加速'
          ),
          h('button', {
            onClick: generate,
            disabled: active,
            style: { padding: '7px 18px', borderRadius: '7px', border: '1px solid rgba(128,128,128,0.35)', background: active ? 'transparent' : 'rgba(120,140,255,0.16)', color: 'inherit', cursor: active ? 'default' : 'pointer', fontWeight: 600, fontSize: '13px' },
          }, active ? '生成中…' : '生成')
        ),

        error ? h('div', { style: { color: '#e05c5c', fontSize: '13px' } }, error) : null,
        busy ? h('div', { style: { opacity: 0.7, fontSize: '12px' } }, busy) : null,

        job
          ? h('div', { style: { padding: '10px 12px', border: '1px solid rgba(128,128,128,0.25)', borderRadius: '8px' } },
              h('div', { style: { fontSize: '12px', opacity: 0.75, marginBottom: '6px' } },
                job.id + ' · ' + job.status
                  + (job.elapsedSeconds ? ' · ' + job.elapsedSeconds + 's' : '')
                  + (job.summary && job.summary.frames ? ' · ' + job.summary.frames + ' 帧' : '')
                  + (job.summary && job.summary.durationSeconds ? ' / ' + job.summary.durationSeconds + 's' : '')
              ),
              job.warning ? h('div', { style: { fontSize: '12px', color: '#d9a441', marginBottom: '6px' } }, job.warning) : null,
              job.error ? h('div', { style: { fontSize: '12px', color: '#e05c5c' } }, job.error) : null,
              done
                ? h('video', { src: '/api/comfyui-firstlast/media?id=' + encodeURIComponent(job.id), controls: true, style: { width: '100%', maxWidth: '720px', borderRadius: '6px' } })
                : null
            )
          : null,

        history.length
          ? h('div', null,
              h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px' } }, '最近生成'),
              history.slice(0, 10).map(function (item) {
                return h('div', { key: item.id, style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px', padding: '3px 0' } },
                  h('span', { style: { opacity: 0.6 } }, new Date(item.createdAt).toLocaleString()),
                  h('span', null, item.status),
                  item.status === 'done'
                    ? h('a', { href: '/api/comfyui-firstlast/media?id=' + encodeURIComponent(item.id), target: '_blank', rel: 'noreferrer', style: { color: 'inherit' } }, '打开')
                    : h('span', { style: { opacity: 0.5 } }, item.error || ''),
                  h('button', {
                    onClick: function () { setJob(item); },
                    style: { all: 'unset', cursor: 'pointer', opacity: 0.6 },
                    title: '查看',
                  }, '↗')
                );
              })
            )
          : null,

        zoom
          ? h('div', {
              onClick: function () { setZoom(''); },
              style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, cursor: 'zoom-out' },
            }, h('img', { src: '/api/comfyui-firstlast/frames?name=' + encodeURIComponent(zoom), alt: '预览', style: { maxWidth: '92vw', maxHeight: '92vh', borderRadius: '8px' } }))
          : null
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'comfyui-firstlast',
          order: 5,
          label: () => '首尾帧视频',
        }, FirstLastIcon));

        ctx.slots.inject('main', () => {
          const disposers = [
            ctx.slots.register({ name: 'main', key: 'comfyui-firstlast' }, FirstLastPanel),
          ];
          return function disposeMain() { disposers.forEach(function (d) { d(); }); };
        });
      },
    };
  },
});
