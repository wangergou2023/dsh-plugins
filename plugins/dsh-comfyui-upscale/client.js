window.__ModuleLoader__.load({
  id: 'dsh-comfyui-upscale',
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

    const FORM_KEY = 'comfyui-upscale.form.v1';
    const CFG_DEFAULTS = {
      scale: 4,
      tileSize: 512,
      overlap: 128,
      seed: '',
      colorCorrection: 'none',
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

    function UpIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20;
      const active = !!(props && props.active);
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: active ? 1.9 : 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('rect', { key: 'a', x: 3.4, y: 8.6, width: 8.4, height: 8.4, rx: 1.4 }),
        h('path', { key: 'b', d: 'M14.6 3.4h6v6' }),
        h('path', { key: 'c', d: 'M20.6 3.4 13 11' }),
        h('path', { key: 'd', d: 'M4 6.6v-2.2h2.2' })
      );
    }

        /** 全屏查看器：以光标为锚点缩放、拖动平移、1:1 / 适应窗口切换。 */
    function Lightbox(props) {
      const src = props.src;
      const onClose = props.onClose;
      const [natural, setNatural] = React.useState({ w: 0, h: 0 });
      const [zoom, setZoom] = React.useState(1);
      const [tx, setTx] = React.useState(0);
      const [ty, setTy] = React.useState(0);
      const wrapRef = React.useRef(null);

      const fitZoom = function () {
        if (!natural.w || !natural.h) return 1;
        return Math.min((window.innerWidth * 0.94) / natural.w, (window.innerHeight * 0.82) / natural.h, 1);
      };

      const resetTo = function (z) {
        setZoom(z);
        setTx(0);
        setTy(0);
      };

      /** 以视口内某个点为锚点缩放到 nextZoom。 */
      const zoomAt = function (clientX, clientY, nextZoom) {
        const wrap = wrapRef.current;
        if (!wrap) return;
        const rect = wrap.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        setZoom(function (prevZoom) {
          const z = prevZoom || 1;
          const clamp = Math.min(8, Math.max(0.05, nextZoom));
          setTx(function (prevTx) {
            const px = (clientX - cx - prevTx) / z;
            return clientX - cx - px * clamp;
          });
          setTy(function (prevTy) {
            const py = (clientY - cy - prevTy) / z;
            return clientY - cy - py * clamp;
          });
          return clamp;
        });
      };

      const stepAt = function (clientX, clientY, factor) {
        zoomAt(clientX, clientY, (zoom || 1) * factor);
      };

      React.useEffect(function () {
        const wrap = wrapRef.current;
        if (!wrap) return undefined;
        const onWheel = function (e) {
          e.preventDefault();
          stepAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
        };
        wrap.addEventListener('wheel', onWheel, { passive: false });
        const onKey = function (e) {
          const cx = window.innerWidth / 2;
          const cy = window.innerHeight / 2;
          if (e.key === 'Escape') onClose();
          else if (e.key === '+' || e.key === '=') stepAt(cx, cy, 1.25);
          else if (e.key === '-' || e.key === '_') stepAt(cx, cy, 1 / 1.25);
          else if (e.key === '0') { setZoom(fitZoom()); setTx(0); setTy(0); }
          else if (e.key === '1') { setZoom(1); setTx(0); setTy(0); }
        };
        window.addEventListener('keydown', onKey);
        return function () {
          wrap.removeEventListener('wheel', onWheel);
          window.removeEventListener('keydown', onKey);
        };
      }, [onClose, zoom, natural.w, natural.h]);

      const drag = React.useRef({ active: false, x: 0, y: 0, tx: 0, ty: 0 });

      function onPointerDown(e) {
        drag.current = { active: true, x: e.clientX, y: e.clientY, tx: tx, ty: ty };
        if (e.currentTarget.setPointerCapture) e.currentTarget.setPointerCapture(e.pointerId);
      }
      function onPointerMove(e) {
        if (!drag.current.active) return;
        setTx(drag.current.tx + (e.clientX - drag.current.x));
        setTy(drag.current.ty + (e.clientY - drag.current.y));
      }
      function onPointerUp() { drag.current.active = false; }

      const chip = function (label, onClick, title) {
        return h('button', {
          key: label,
          onClick: function (e) { e.stopPropagation(); onClick(); },
          title: title || label,
          style: {
            all: 'unset', cursor: 'pointer', padding: '4px 10px', borderRadius: '6px',
            background: 'rgba(255,255,255,0.12)', color: '#fff', fontSize: '13px',
          },
        }, label);
      };

      return h('div', {
        ref: wrapRef,
        onClick: function (e) { if (e.target === e.currentTarget) onClose(); },
        style: {
          position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.92)',
          overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
        },
      },
        h('img', {
          src: src,
          alt: 'preview',
          draggable: false,
          onLoad: function (e) {
            const nw = e.target.naturalWidth;
            const nh = e.target.naturalHeight;
            setNatural({ w: nw, h: nh });
            const z = Math.min((window.innerWidth * 0.94) / nw, (window.innerHeight * 0.82) / nh, 1);
            setZoom(z);
            setTx(0);
            setTy(0);
          },
          onPointerDown: onPointerDown,
          onPointerMove: onPointerMove,
          onPointerUp: onPointerUp,
          onPointerCancel: onPointerUp,
          onDoubleClick: function () { resetTo(zoom >= 0.999 ? fitZoom() : 1); },
          style: {
            display: 'block',
            width: natural.w ? natural.w + 'px' : 'auto',
            maxWidth: 'none',
            maxHeight: 'none',
            transform: 'translate(' + tx + 'px, ' + ty + 'px) scale(' + zoom + ')',
            transformOrigin: 'center center',
            cursor: drag.current.active ? 'grabbing' : 'grab',
            userSelect: 'none',
            willChange: 'transform',
          },
        }),
        h('div', {
          onClick: function (e) { e.stopPropagation(); },
          style: {
            position: 'fixed', bottom: '18px', left: 0, right: 0,
            display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'center',
            flexWrap: 'wrap', zIndex: 10000,
          },
        },
          chip('适应', function () { resetTo(fitZoom()); }, '适应窗口（0）'),
          chip('1:1', function () { resetTo(1); }, '原始像素（1）'),
          chip('−', function () { stepAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.25); }, '缩小（-）'),
          chip('＋', function () { stepAt(window.innerWidth / 2, window.innerHeight / 2, 1.25); }, '放大（+）'),
          chip('新标签', function () { window.open(src, '_blank'); }),
          chip('下载', function () {
            const a = document.createElement('a');
            a.href = src;
            a.download = '';
            document.body.appendChild(a);
            a.click();
            a.remove();
          }),
          h('span', { style: { color: 'rgba(255,255,255,0.6)', fontSize: '12px' } },
            Math.round(zoom * 100) + '%'
            + (natural.w ? ' · ' + natural.w + '×' + natural.h : '')
            + ' · 滚轮以光标为中心缩放，拖动平移，双击切 1:1'),
          chip('关闭', onClose, '关闭（Esc）')
        )
      );
    }

    function UpPanel() {
      const [initial] = React.useState(function () { return loadForm(); });
      const [meta, setMeta] = React.useState(null);
      const [modelValues, setModelValues] = React.useState({});
      const [metaError, setMetaError] = React.useState('');
      const [image, setImage] = React.useState((initial && initial.image) || '');
      const [cfg, setCfg] = React.useState(function () {
        return { ...CFG_DEFAULTS, ...((initial && initial.cfg) || {}) };
      });
      const [job, setJob] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [outputs, setOutputs] = React.useState([]);
      const [outputsRoot, setOutputsRoot] = React.useState('');
      const [viewer, setViewer] = React.useState(null);
      const [history, setHistory] = React.useState([]);

      React.useEffect(function () {
        try {
          window.localStorage.setItem(FORM_KEY, JSON.stringify({ image, cfg }));
        } catch { /* 忽略 */ }
      }, [image, cfg]);

      const refreshHistory = React.useCallback(function () {
        api('/api/comfyui-upscale/jobs')
          .then(function (d) {
            if (!d || !Array.isArray(d.jobs)) return;
            setHistory(d.jobs);
            setJob(function (current) { return current || d.jobs[0] || null; });
          })
          .catch(function () {});
      }, []);

      const loadMeta = React.useCallback(async function (attempt) {
        const tries = typeof attempt === 'number' ? attempt : 0;
        try {
          const data = await api('/api/comfyui-upscale/meta');
          setMeta(data);
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

      React.useEffect(function () {
        loadMeta(0);
        refreshHistory();
        loadOutputs();
        const timer = setInterval(refreshHistory, 5000);
        return function () { clearInterval(timer); };
      }, [loadMeta, refreshHistory]);

      React.useEffect(function () {
        if (!job || (job.status !== 'queued' && job.status !== 'running')) return undefined;
        const timer = setInterval(function () {
          api('/api/comfyui-upscale/job?id=' + encodeURIComponent(job.id))
            .then(function (next) {
              setJob(next);
              if (next.status === 'done' || next.status === 'failed') refreshHistory();
            })
            .catch(function () {});
        }, 2000);
        return function () { clearInterval(timer); };
      }, [job, refreshHistory]);

      React.useEffect(function () {
        if (!viewer) return undefined;
        const onKey = function (e) { if (e.key === 'Escape') setViewer(null); };
        window.addEventListener('keydown', onKey);
        return function () { window.removeEventListener('keydown', onKey); };
      }, [viewer]);

      function pickFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = async function () {
          if (!input.files || input.files.length === 0) return;
          setError('');
          setBusy('正在上传…');
          try {
            const form = new FormData();
            form.append('file', input.files[0], input.files[0].name);
            const data = await api('/api/comfyui-upscale/upload', { method: 'POST', body: form });
            setImage(data.files[0].name);
          } catch (err) {
            setError(String((err && err.message) || err));
          } finally {
            setBusy('');
          }
        };
        input.click();
      }

      async function loadOutputs() {
        try {
          const data = await api('/api/comfyui-upscale/outputs?limit=150');
          setOutputs(Array.isArray(data.files) ? data.files : []);
          setOutputsRoot(data.root || '');
        } catch (err) {
          setOutputs([]);
          setError('读取 output 目录失败：' + String((err && err.message) || err));
        }
      }

      /** 选中 output 里的图 → 复制进 input，再当输入用。 */
      async function importOutput(key) {
        const slash = key.indexOf('/');
        const subfolder = slash >= 0 ? key.slice(0, slash) : '';
        const name = slash >= 0 ? key.slice(slash + 1) : key;
        setError('');
        setBusy('正在导入…');
        try {
          const data = await api('/api/comfyui-upscale/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: name, subfolder: subfolder }),
          });
          setImage(data.name);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy('');
        }
      }

      function setModelValue(node, field, value) {
        setModelValues(function (prev) {
          const next = { ...prev };
          next[node] = { ...(prev[node] || {}), [field]: value };
          return next;
        });
      }

      async function generate() {
        setError('');
        if (!image) { setError('先上传一张图片，或从 input 目录里选一张'); return; }
        setBusy('正在提交…');
        try {
          const body = { ...cfg, image };
          if (body.seed === '' || body.seed === undefined) delete body.seed;
          const data = await api('/api/comfyui-upscale/run', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...body, models: modelValues }),
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
      const missing = meta && meta.comfyui && Array.isArray(meta.comfyui.missingModels) ? meta.comfyui.missingModels : [];
      const active = job && (job.status === 'queued' || job.status === 'running');
      const resultSrc = job && job.status === 'done' ? '/api/comfyui-upscale/media?id=' + encodeURIComponent(job.id) : null;
      const previewSrc = image ? '/api/comfyui-upscale/preview?filename=' + encodeURIComponent(image) + '&type=input' : null;

      function num(label, key, min, max, step, width) {
        return h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
          label,
          h('input', {
            type: 'number', min, max, step,
            value: cfg[key],
            onChange: function (e) {
              const v = e.target.value;
              setCfg(function (prev) { return { ...prev, [key]: key === 'seed' ? v : Number(v) }; });
            },
            style: { width: width || '80px' },
          })
        );
      }

      return h('div', { style: { padding: '18px 20px', maxWidth: '1100px' } },
        (meta && meta.models && meta.models.length
          ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', marginTop: '2px', marginBottom: '10px', fontSize: '12px' } },
              h('span', { style: { opacity: 0.6 } }, '模型：'),
              meta.models.map(function (m) {
                const current = (modelValues[m.node] && modelValues[m.node][m.field]) || m.value;
                return h('label', {
                  key: m.node + ':' + m.field,
                  title: m.class_type + ' · 节点 ' + m.node,
                  style: { display: 'flex', alignItems: 'center', gap: '4px' },
                },
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
          h('h2', { style: { margin: 0, fontSize: '18px' } }, '图片放大'),
          h('span', { style: { fontSize: '12px', opacity: 0.65 } },
            online
              ? 'SeedVR2 7B · ComfyUI ' + meta.comfyui.version + ' · ' + meta.comfyui.device + (vram !== null ? ' · 空闲 ' + vram + ' GB' : '')
              : metaError ? '状态未知：' + metaError
              : !meta ? '正在连接 ComfyUI…'
              : 'ComfyUI 离线'),
          online ? null : h('button', {
            className: 'cfl-chip', style: { fontSize: '11px' },
            onClick: function () { loadMeta(0); },
          }, '重试连接')
        ),

        missing.length
          ? h('div', { style: { fontSize: '12px', color: '#e05c5c', marginBottom: '10px', lineHeight: '1.6' } },
              '缺少模型，先下载并重启 ComfyUI：',
              ...missing.map(function (m) {
                return h('div', { key: m.name }, '· ' + m.name + '  →  models\\' + m.dir + '\\');
              }))
          : null,

        h('div', { style: { display: 'flex', gap: '14px', alignItems: 'flex-start', flexWrap: 'wrap' } },
          h('div', { style: { width: '220px' } },
            h('div', { style: { fontSize: '12px', opacity: 0.65, marginBottom: '4px' } }, '输入图片'),
            previewSrc
              ? h('img', {
                  src: previewSrc, alt: image,
                  style: { width: '220px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.25)', display: 'block' },
                })
              : h('div', {
                  style: {
                    width: '220px', height: '140px', borderRadius: '6px',
                    border: '1px dashed rgba(128,128,128,0.35)', display: 'flex',
                    alignItems: 'center', justifyContent: 'center', fontSize: '12px', opacity: 0.5,
                  },
                }, '还没有图片'),
            h('div', { style: { display: 'flex', gap: '6px', marginTop: '6px', flexWrap: 'wrap' } },
              h('button', { className: 'cfl-chip', onClick: pickFile, style: { fontSize: '12px' } }, '＋ 上传'),
              h('button', {
                className: 'cfl-chip', style: { fontSize: '12px' },
                title: '重新读取 ComfyUI 的 output 目录',
                onClick: function () { loadOutputs(); },
              }, '↻')
            ),
            h('div', { style: { fontSize: '11px', opacity: 0.6, marginTop: '6px' } }, '从已生成的图里选（' + outputs.length + '）'),
            h('select', {
              value: '',
              onChange: function (e) { if (e.target.value) importOutput(e.target.value); },
              style: { fontSize: '12px', width: '220px' },
            },
              h('option', { value: '' }, outputs.length ? '选择 output 里的图…' : '（output 里没有图片）'),
              ...outputs.map(function (item) {
                const key = (item.subfolder ? item.subfolder + '/' : '') + item.name;
                const ago = Math.round((Date.now() - item.mtime) / 60000);
                const when = ago < 60 ? ago + ' 分钟前' : Math.round(ago / 60) + ' 小时前';
                return h('option', { key: key, value: key }, item.name + ' · ' + when);
              })
            ),
            image ? h('div', { style: { fontSize: '11px', opacity: 0.6, marginTop: '4px', wordBreak: 'break-all' } }, image) : null
          ),
          h('div', { style: { flex: '1 1 420px', minWidth: '320px' } },
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-end' } },
              num('放大倍数', 'scale', 1, 8, 0.5),
              num('分块', 'tileSize', 256, 1024, 64),
              num('重叠', 'overlap', 0, 256, 16),
              h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
                '颜色校正',
                h('select', {
                  value: cfg.colorCorrection,
                  onChange: function (e) { setCfg(function (prev) { return { ...prev, colorCorrection: e.target.value }; }); },
                },
                  ['none', 'lab', 'adain'].map(function (v) { return h('option', { key: v, value: v }, v); })
                )
              ),
              h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
                '种子',
                h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
                  h('input', {
                    type: 'number', placeholder: '随机', value: cfg.seed,
                    onChange: function (e) { setCfg(function (prev) { return { ...prev, seed: e.target.value }; }); },
                    style: { width: '92px' },
                  }),
                  h('button', {
                    className: 'cfl-chip', title: '随机一个种子',
                    onClick: function () { setCfg(function (prev) { return { ...prev, seed: String(Math.floor(Math.random() * 2 ** 31)) }; }); },
                  }, '🎲')
                )
              ),
              h('button', {
                className: 'cfl-chip', onClick: generate, disabled: busy !== '' || active,
                style: { fontWeight: 600 },
              }, active ? '放大中…' : '开始放大')
            ),
            h('div', { style: { fontSize: '11px', opacity: 0.55, marginTop: '6px' } },
              '显存不够就调小「分块」（如 256）；倍数越高越慢，4× 一般够用。'),

            error ? h('div', { style: { color: '#e05c5c', fontSize: '13px', marginTop: '10px' } }, error) : null,
            busy ? h('div', { style: { opacity: 0.7, fontSize: '12px', marginTop: '8px' } }, busy) : null
          )
        ),

        job
          ? h('div', { style: { marginTop: '16px' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' } },
                h('span', { style: { fontSize: '12px' } },
                  job.id + ' · ' + job.status
                  + (job.elapsedSeconds ? ' · ' + job.elapsedSeconds + 's' : '')
                  + (job.summary && job.summary.seed !== undefined ? ' · 种子 ' + job.summary.seed : '')),
                              ),
              job.error ? h('div', { style: { color: '#e05c5c', fontSize: '12px', marginBottom: '8px' } }, job.error) : null,
              resultSrc
                ? h('div', {
                    onClick: function () { setViewer(resultSrc); },
                    title: '点击查看大图',
                    style: { display: 'inline-block', cursor: 'zoom-in', borderRadius: '6px', overflow: 'hidden', border: '1px solid rgba(128,128,128,0.25)' },
                  },
                    h('img', {
                      src: resultSrc, alt: 'upscaled',
                      style: {
                        maxWidth: '100%', maxHeight: '420px', objectFit: 'contain',
                        display: 'block', background: 'rgba(0,0,0,0.06)',
                      },
                    })
                  )
                : null
            )
          : null,

        history.length
          ? h('div', { style: { marginTop: '20px' } },
              h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px' } }, '最近放大'),
              history.slice(0, 10).map(function (item) {
                const cover = item.status === 'done'
                  ? h('img', {
                      src: '/api/comfyui-upscale/media?id=' + encodeURIComponent(item.id),
                      alt: item.id,
                      style: { width: '64px', height: '64px', objectFit: 'cover', borderRadius: '4px', display: 'block' },
                    })
                  : h('div', { style: { width: '64px', height: '64px', borderRadius: '4px', background: 'rgba(128,128,128,0.15)' } });
                return h('button', {
                  key: item.id,
                  onClick: function () { setJob(item); },
                  style: { all: 'unset', cursor: 'pointer', display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' },
                },
                  cover,
                  h('span', { style: { fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '2px' } },
                    h('span', null, new Date(item.createdAt).toLocaleString()),
                    h('span', { style: { opacity: 0.6 } },
                      item.status + (item.summary && item.summary.scale ? ' · ' + item.summary.scale + '×' : '') + (item.error ? ' · ' + item.error : ''))
                  )
                );
              })
            )
          : null,

        viewer
          ? h(Lightbox, { src: viewer, onClose: function () { setViewer(null); } })
          : null
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'comfyui-upscale',
          order: 6,
          label: () => '图片放大',
        }, UpIcon));

        ctx.slots.inject('main', () => {
          const disposers = [
            ctx.slots.register({ name: 'main', key: 'comfyui-upscale' }, UpPanel),
          ];
          return function disposeMain() { disposers.forEach(function (d) { d(); }); };
        });
      },
    };
  },
});
