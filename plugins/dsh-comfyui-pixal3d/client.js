window.__ModuleLoader__.load({
  id: 'dsh-comfyui-pixal3d',
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

    const FORM_KEY = 'comfyui-pixal3d.form.v1';
    const DEFAULTS = {
      mode: 'single',
      fov: 20,
      layout: 'grid2x2',
      shapeSteps: 20,
      textureSteps: 12,
      resolution: 1536,
      remesh: 768,
      textureSize: 4096,
      threshold: 0.6,
      seed: '',
    };

    function loadForm() {
      try {
        const raw = window.localStorage.getItem(FORM_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : null;
      } catch { return null; }
    }

    function CubeIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20;
      const active = !!(props && props.active);
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: active ? 1.9 : 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('path', { key: 'a', d: 'M12 3 21 8v8l-9 5-9-5V8z' }),
        h('path', { key: 'b', d: 'M12 3v9M21 8l-9 5M3 8l9 5v8' })
      );
    }

    function P3dPanel() {
      const [initial] = React.useState(function () { return loadForm(); });
      const [form, setForm] = React.useState(function () { return { ...DEFAULTS, ...(initial || {}) }; });
      const [image, setImage] = React.useState((initial && initial.image) || '');
      const [meta, setMeta] = React.useState(null);
      const [metaError, setMetaError] = React.useState('');
      const [modelValues, setModelValues] = React.useState({});
      const [job, setJob] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [history, setHistory] = React.useState([]);
      const [images, setImages] = React.useState([]);
      const [viewer, setViewer] = React.useState(null);

      React.useEffect(function () {
        try { window.localStorage.setItem(FORM_KEY, JSON.stringify({ ...form, image })); } catch { /* 忽略 */ }
      }, [form, image]);

      React.useEffect(function () {
        if (!viewer) return undefined;
        const onKey = function (e) { if (e.key === 'Escape') setViewer(null); };
        window.addEventListener('keydown', onKey);
        return function () { window.removeEventListener('keydown', onKey); };
      }, [viewer]);

      const loadMeta = React.useCallback(async function (attempt) {
        const tries = typeof attempt === 'number' ? attempt : 0;
        try {
          const data = await api('/api/comfyui-pixal3d/meta');
          setMeta(data);
          setImages(Array.isArray(data.images) ? data.images : []);
          setMetaError('');
        } catch (err) {
          if (tries < 3) { setTimeout(function () { loadMeta(tries + 1); }, 600 * (tries + 1)); return; }
          setMeta({ comfyui: { online: false } });
          setMetaError(String((err && err.message) || err));
        }
      }, []);

      const refreshHistory = React.useCallback(function () {
        api('/api/comfyui-pixal3d/jobs')
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
          api('/api/comfyui-pixal3d/job?id=' + encodeURIComponent(job.id))
            .then(function (next) {
              setJob(next);
              if (next.status === 'done' || next.status === 'failed') refreshHistory();
            })
            .catch(function () {});
        }, 3000);
        return function () { clearInterval(timer); };
      }, [job, refreshHistory]);

      function set(key, value) {
        setForm(function (prev) { return { ...prev, [key]: value }; });
      }

      function setModelValue(node, field, value) {
        setModelValues(function (prev) {
          const next = { ...prev };
          next[node] = { ...(prev[node] || {}), [field]: value };
          return next;
        });
      }

      function pickFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = async function () {
          if (!input.files || input.files.length === 0) return;
          setError('');
          setBusy('正在上传…');
          try {
            const fd = new FormData();
            fd.append('file', input.files[0], input.files[0].name);
            const data = await api('/api/comfyui-pixal3d/upload', { method: 'POST', body: fd });
            setImage(data.files[0].name);
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
        if (!image) { setError('先选一张四视图转盘图'); return; }
        setBusy('正在提交…');
        try {
          const body = { ...form, image, models: modelValues };
          if (body.seed === '' || body.seed === undefined) delete body.seed;
          const data = await api('/api/comfyui-pixal3d/run', {
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
      const fileUrl = job && job.status === 'done' ? '/api/comfyui-pixal3d/media?id=' + encodeURIComponent(job.id) : null;
      const imgSrc = image ? '/api/comfyui-pixal3d/preview?filename=' + encodeURIComponent(image) + '&type=input' : null;

      function num(label, key, min, max, step, width) {
        return h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
          label,
          h('input', {
            type: 'number', min, max, step, value: form[key],
            onChange: function (e) { set(key, key === 'seed' ? e.target.value : Number(e.target.value)); },
            style: { width: width || '80px' },
          })
        );
      }

      return h('div', { style: { padding: '18px 20px', maxWidth: '1100px' } },
        (meta && meta.models && meta.models.length
          ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', marginBottom: '10px', fontSize: '12px' } },
              h('span', { style: { opacity: 0.6 } }, '模型：'),
              meta.models.map(function (m) {
                const current = (modelValues[m.node] && modelValues[m.node][m.field]) || m.value;
                return h('label', { key: m.node + ':' + m.field, title: m.class_type + ' · 节点 ' + m.node, style: { display: 'flex', alignItems: 'center', gap: '4px' } },
                  h('span', { style: { opacity: 0.55 } }, m.label),
                  h('select', {
                    value: current,
                    onChange: function (e) { setModelValue(m.node, m.field, e.target.value); },
                    style: { fontSize: '11px', maxWidth: '230px' },
                  }, m.options.map(function (o) { return h('option', { key: o, value: o }, o); }))
                );
              })
            )
          : null),

        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' } },
          h('h2', { style: { margin: 0, fontSize: '18px' } }, '3D 生成'),
          h('span', { style: { fontSize: '12px', opacity: 0.65 } },
            online
              ? 'Pixal3D + Trellis2 · ComfyUI ' + meta.comfyui.version + ' · ' + meta.comfyui.device + (vram !== null ? ' · 空闲 ' + vram + ' GB' : '')
              : metaError ? '状态未知：' + metaError
              : !meta ? '正在连接 ComfyUI…'
              : 'ComfyUI 离线'),
          online ? null : h('button', { className: 'cfl-chip', style: { fontSize: '11px' }, onClick: function () { loadMeta(0); } }, '重试连接')
        ),

        h('div', { style: { display: 'flex', gap: '14px', alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: '10px' } },
          h('div', { style: { width: '300px' } },
            h('div', { style: { fontSize: '12px', opacity: 0.65, marginBottom: '4px' } }, form.mode === 'single' ? '角色图（正面 / 半身，背景干净最佳）' : '四视图转盘图（前 / 左 / 后 / 右）'),
            imgSrc
              ? h('img', {
                  src: imgSrc, alt: image, onClick: function () { setViewer(imgSrc); },
                  style: { width: '300px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.25)', display: 'block', cursor: 'zoom-in' },
                })
              : h('div', {
                  style: {
                    width: '300px', height: '110px', borderRadius: '6px',
                    border: '1px dashed rgba(128,128,128,0.35)', display: 'flex',
                    alignItems: 'center', justifyContent: 'center', fontSize: '12px', opacity: 0.5,
                  },
                }, '空'),
            h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' } },
              h('button', { className: 'cfl-chip', onClick: pickFile, style: { fontSize: '12px' } }, '＋ 上传'),
              image ? h('button', { className: 'cfl-chip', onClick: function () { setImage(''); }, style: { fontSize: '12px' } }, '×') : null,
              h('button', { className: 'cfl-chip', onClick: function () { loadMeta(0); }, style: { fontSize: '12px' } }, '↻')
            ),
            h('select', {
              value: '',
              onChange: function (e) { if (e.target.value) setImage(e.target.value); },
              style: { fontSize: '12px', width: '300px', marginTop: '4px' },
            },
              h('option', { value: '' }, images.length ? '从 output 选…' : '（没有可选的图）'),
              images.map(function (item) {
                const key = (item.subfolder ? item.subfolder + '/' : '') + item.name;
                return h('option', { key, value: item.name }, item.name);
              })
            ),
            image ? h('div', { style: { fontSize: '11px', opacity: 0.6, marginTop: '4px', wordBreak: 'break-all' } }, image) : null
          ),
          h('div', { style: { flex: '1 1 380px', minWidth: '320px' } },
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-end' } },
              h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
                '输入模式',
                h('select', {
                  value: form.mode,
                  onChange: function (e) { set('mode', e.target.value); },
                  style: { fontSize: '12px' },
                },
                  h('option', { value: 'single' }, '单图直出'),
                  h('option', { value: 'sheet' }, '四视图转盘')
                )
              ),
              form.mode === 'sheet'
                ? h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
                    '切分方式',
                    h('select', {
                      value: form.layout,
                      onChange: function (e) { set('layout', e.target.value); },
                      style: { fontSize: '12px' },
                    },
                      h('option', { value: 'grid2x2' }, '2×2 四宫格'),
                      h('option', { value: 'quarters' }, '四联排（按宽度四等分）'),
                      h('option', { value: 'template' }, '模板坐标')
                    )
                  )
                : num('相机 FOV', 'fov', 10, 60, 1, '68px'),
              num('形状步数', 'shapeSteps', 4, 60, 1, '70px'),
              num('贴图步数', 'textureSteps', 4, 60, 1, '70px'),
              num('上采样', 'resolution', 512, 2048, 128, '82px'),
              num('重网格', 'remesh', 128, 1536, 64, '82px'),
              num('贴图尺寸', 'textureSize', 512, 4096, 256, '90px'),
              num('阈值', 'threshold', 0.1, 2, 0.05, '68px'),
              h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
                '种子',
                h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
                  h('input', {
                    type: 'number', placeholder: '随机', value: form.seed,
                    onChange: function (e) { set('seed', e.target.value); },
                    style: { width: '92px' },
                  }),
                  h('button', { className: 'cfl-chip', title: '随机一个种子', onClick: function () { set('seed', String(Math.floor(Math.random() * 2 ** 31))); } }, '🎲')
                )
              ),
              h('button', {
                className: 'cfl-chip', onClick: generate, disabled: busy !== '' || active,
                style: { fontWeight: 600 },
              }, active ? '生成中…' : '生成 3D')
            ),
            h('div', { style: { fontSize: '11px', opacity: 0.5, marginTop: '6px' } },
              form.mode === 'single'
                ? '单图直出：一张角色图即可，不用转盘图。FOV 越小越接近长焦（人脸更平），越大越广。'
                : '顺序：前 / 左 / 后 / 右。四宫格按 2×2 切（左上/右上/左下/右下）；四联排按宽度切；模板沿用工作流坐标。'),
            error ? h('div', { style: { color: '#e05c5c', fontSize: '13px', marginTop: '10px' } }, error) : null,
            busy ? h('div', { style: { opacity: 0.7, fontSize: '12px', marginTop: '8px' } }, busy) : null
          )
        ),

        job
          ? h('div', { style: { marginTop: '16px' } },
              h('div', { style: { fontSize: '12px', marginBottom: '8px' } },
                job.id + ' · ' + job.status
                + (job.elapsedSeconds ? ' · ' + job.elapsedSeconds + 's' : '')
                + (job.summary && job.summary.shapeSteps ? ' · ' + job.summary.shapeSteps + '/' + job.summary.textureSteps + ' 步' : '')
                + (job.bytes ? ' · ' + Math.round(job.bytes / 1024) + ' KB' : '')),
              job.error ? h('div', { style: { color: '#e05c5c', fontSize: '12px', marginBottom: '8px' } }, job.error) : null,
              fileUrl
                ? h('div', { style: { display: 'flex', gap: '12px', alignItems: 'center', fontSize: '13px' } },
                    h('a', { href: fileUrl, download: '', className: 'cfl-chip', style: { textDecoration: 'none' } }, '⬇ 下载 GLB'),
                    h('span', { style: { opacity: 0.6, fontSize: '12px' } }, job.filename || '')
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
                      width: '28px', height: '28px', borderRadius: '6px', flex: '0 0 auto',
                      background: item.status === 'done' ? 'rgba(120,160,255,0.25)' : 'rgba(128,128,128,0.15)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px',
                    },
                  }, item.status === 'done' ? '◈' : '·'),
                  h('span', { style: { fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
                    h('span', null, new Date(item.createdAt).toLocaleString()),
                    h('span', { style: { opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      item.status + (item.elapsedSeconds ? ' · ' + item.elapsedSeconds + 's' : '') + (item.filename ? ' · ' + item.filename : '') + (item.error ? ' · ' + item.error : ''))
                  )
                );
              })
            )
          : null,

        viewer
          ? h('div', {
              onClick: function () { setViewer(null); },
              style: { position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', cursor: 'zoom-out' },
            },
              h('img', { src: viewer, alt: 'preview', onClick: function (e) { e.stopPropagation(); }, style: { maxWidth: '94vw', maxHeight: '90vh', objectFit: 'contain' } })
            )
          : null
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'comfyui-pixal3d',
          order: 8,
          label: () => '3D 生成',
        }, CubeIcon));

        ctx.slots.inject('main', () => {
          const disposers = [ctx.slots.register({ name: 'main', key: 'comfyui-pixal3d' }, P3dPanel)];
          return function disposeMain() { disposers.forEach(function (d) { d(); }); };
        });
      },
    };
  },
});
