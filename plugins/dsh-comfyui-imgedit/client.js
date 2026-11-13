window.__ModuleLoader__.load({
  id: 'dsh-comfyui-imgedit',
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

    const FORM_KEY = 'comfyui-imgedit.form.v1';
    const CFG_DEFAULTS = {
      negative: '',
      enhance: false,
      steps: 25,
      cfg: 1,
      seed: '',
      fixedSize: false,
      width: 1024,
      height: 1024,
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

    function EditIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20;
      const active = !!(props && props.active);
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: active ? 1.9 : 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('path', { key: 'a', d: 'M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3z' }),
        h('path', { key: 'b', d: 'M14.5 6.5 17.5 9.5' })
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

    function EditPanel() {
      const [initial] = React.useState(function () { return loadForm(); });
      const [meta, setMeta] = React.useState(null);
      const [metaError, setMetaError] = React.useState('');
      const [refs, setRefs] = React.useState(Array.isArray(initial && initial.refs) ? initial.refs : []);
      const [prompt, setPrompt] = React.useState((initial && initial.prompt) || '');
      const [cfg, setCfg] = React.useState(function () {
        return { ...CFG_DEFAULTS, ...((initial && initial.cfg) || {}) };
      });
      const [job, setJob] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [polishing, setPolishing] = React.useState(false);
      const [polishNote, setPolishNote] = React.useState('');
      const [prevPrompt, setPrevPrompt] = React.useState('');
      const [outputs, setOutputs] = React.useState([]);
      const [viewer, setViewer] = React.useState(null);
      const [history, setHistory] = React.useState([]);

      React.useEffect(function () {
        try {
          window.localStorage.setItem(FORM_KEY, JSON.stringify({ refs, prompt, cfg }));
        } catch { /* 忽略 */ }
      }, [refs, prompt, cfg]);

      React.useEffect(function () {
        if (!viewer) return undefined;
        const onKey = function (e) { if (e.key === 'Escape') setViewer(null); };
        window.addEventListener('keydown', onKey);
        return function () { window.removeEventListener('keydown', onKey); };
      }, [viewer]);

      const refreshHistory = React.useCallback(function () {
        api('/api/comfyui-imgedit/jobs')
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
          const data = await api('/api/comfyui-imgedit/meta');
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

      React.useEffect(function () {
        loadMeta(0);
        refreshHistory();
        const timer = setInterval(refreshHistory, 5000);
        return function () { clearInterval(timer); };
      }, [loadMeta, refreshHistory]);

      React.useEffect(function () {
        if (!job || (job.status !== 'queued' && job.status !== 'running')) return undefined;
        const timer = setInterval(function () {
          api('/api/comfyui-imgedit/job?id=' + encodeURIComponent(job.id))
            .then(function (next) {
              setJob(next);
              if (next.status === 'done' || next.status === 'failed') refreshHistory();
            })
            .catch(function () {});
        }, 2000);
        return function () { clearInterval(timer); };
      }, [job, refreshHistory]);

      async function polishPrompt() {
        setError('');
        if (!prompt.trim()) { setError('先写一点编辑要求，再点润化'); return; }
        setPolishing(true);
        try {
          const data = await api('/api/comfyui-imgedit/polish', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              prompt: prompt,
              images: refs.filter(function (x) { return x && x.trim(); }),
            }),
          });
          setPrevPrompt(prompt);
          setPrompt(data.text || prompt);
          {
            const bits = [data.vision ? '已读图（' + data.imagesAttached + ' 张）' : '未读图，纯文字改写'];
            if (data.coverage && data.coverage.missing && data.coverage.missing.length) {
              bits.push('⚠ 漏了第 ' + data.coverage.missing.join('/') + ' 张');
            }
            setPolishNote(bits.join(' · '));
          }
        } catch (err) {
          setError('润化失败：' + String((err && err.message) || err));
        } finally {
          setPolishing(false);
        }
      }

      function addRef() {
        setRefs(function (prev) { return prev.concat(['']); });
      }
      function setRefAt(i, v) {
        setRefs(function (prev) {
          const next = prev.slice();
          next[i] = v;
          return next;
        });
      }
      function removeRef(i) {
        setRefs(function (prev) { return prev.filter(function (_, k) { return k !== i; }); });
      }

      /** 多选上传：选几张就追加几张（填到空位，再往后加）。 */
      function uploadMany() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.multiple = true;
        input.onchange = async function () {
          const files = Array.from(input.files || []);
          if (files.length === 0) return;
          setError('');
          setBusy('正在上传 ' + files.length + ' 张…');
          try {
            const names = [];
            for (const file of files) {
              const form = new FormData();
              form.append('file', file, file.name);
              const data = await api('/api/comfyui-imgedit/upload', { method: 'POST', body: form });
              names.push(data.files[0].name);
            }
            setRefs(function (prev) {
              const next = prev.slice();
              for (const name of names) {
                const empty = next.findIndex(function (x) { return !x || !String(x).trim(); });
                if (empty >= 0) next[empty] = name;
                else if (next.length < 10) next.push(name);
              }
              return next.slice(0, 10);
            });
          } catch (err) {
            setError(String((err && err.message) || err));
          } finally {
            setBusy('');
          }
        };
        input.click();
      }

      function refCard(i, name) {
        const src = name ? '/api/comfyui-imgedit/preview?filename=' + encodeURIComponent(name) + '&type=input' : null;
        return h('div', {
          key: 'ref' + i,
          style: {
            display: 'flex', alignItems: 'center', gap: '8px', padding: '6px',
            border: '1px solid rgba(128,128,128,0.25)', borderRadius: '6px',
            minWidth: '230px', maxWidth: '330px',
          },
        },
          src
            ? h('img', {
                src: src,
                onClick: function () { setViewer(src); },
                title: '点击查看大图',
                style: { width: '56px', height: '56px', objectFit: 'cover', borderRadius: '4px', cursor: 'zoom-in', flex: '0 0 auto' },
              })
            : h('div', { style: { width: '56px', height: '56px', borderRadius: '4px', background: 'rgba(128,128,128,0.15)', flex: '0 0 auto' } }),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0, flex: 1 } },
            h('span', { style: { fontSize: '12px', fontWeight: 600 } }, '第 ' + (i + 1) + ' 张'),
            h('span', {
              style: { fontSize: '11px', opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
              title: name || '',
            }, name || '（空位）')
          ),
          h('button', {
            style: { all: 'unset', cursor: 'pointer', opacity: 0.6, padding: '0 4px', fontSize: '14px' },
            title: '删除这一张',
            onClick: function () { removeRef(i); },
          }, '×')
        );
      }

      /** 从 output 选一张：导入后追加到列表末尾（填空位优先）。 */
      async function importOutputAppend(key) {
        const slash = key.indexOf('/');
        const subfolder = slash >= 0 ? key.slice(0, slash) : '';
        const name = slash >= 0 ? key.slice(slash + 1) : key;
        setError('');
        setBusy('正在导入…');
        try {
          const data = await api('/api/comfyui-imgedit/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: name, subfolder: subfolder }),
          });
          setRefs(function (prev) {
            const next = prev.slice();
            const empty = next.findIndex(function (x) { return !x || !String(x).trim(); });
            if (empty >= 0) next[empty] = data.name;
            else if (next.length < 10) next.push(data.name);
            return next;
          });
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy('');
        }
      }

      function pickFile(setter) {
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
            const data = await api('/api/comfyui-imgedit/upload', { method: 'POST', body: form });
            setter(data.files[0].name);
          } catch (err) {
            setError(String((err && err.message) || err));
          } finally {
            setBusy('');
          }
        };
        input.click();
      }

      async function importOutput(setter, key) {
        const slash = key.indexOf('/');
        const subfolder = slash >= 0 ? key.slice(0, slash) : '';
        const name = slash >= 0 ? key.slice(slash + 1) : key;
        setError('');
        setBusy('正在导入…');
        try {
          const data = await api('/api/comfyui-imgedit/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: name, subfolder: subfolder }),
          });
          setter(data.name);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy('');
        }
      }

      async function generate() {
        setError('');
        if (!refs.filter(function (x) { return x && x.trim(); }).length) { setError('至少传一张图'); return; }
        if (!prompt.trim()) { setError('写一句编辑指令，说明要改什么'); return; }
        setBusy('正在提交…');
        try {
          const body = { ...cfg, images: refs.filter(function (x) { return x && x.trim(); }), prompt: prompt };
          if (body.seed === '' || body.seed === undefined) delete body.seed;
          const data = await api('/api/comfyui-imgedit/run', {
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
      const resultSrc = job && job.status === 'done' ? '/api/comfyui-imgedit/media?id=' + encodeURIComponent(job.id) : null;

      function num(label, key, min, max, step, width) {
        return h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
          label,
          h('input', {
            type: 'number', min, max, step, value: cfg[key],
            onChange: function (e) {
              const v = e.target.value;
              setCfg(function (prev) { return { ...prev, [key]: key === 'seed' ? v : Number(v) }; });
            },
            style: { width: width || '80px' },
          })
        );
      }

      return h('div', { style: { padding: '18px 20px', maxWidth: '1100px' } },
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' } },
          h('h2', { style: { margin: 0, fontSize: '18px' } }, '图片编辑'),
          h('span', { style: { fontSize: '12px', opacity: 0.65 } },
            online
              ? 'Qwen-Image 2.1 · ComfyUI ' + meta.comfyui.version + ' · ' + meta.comfyui.device + (vram !== null ? ' · 空闲 ' + vram + ' GB' : '')
              : metaError ? '状态未知：' + metaError
              : !meta ? '正在连接 ComfyUI…'
              : 'ComfyUI 离线'),
          online ? null : h('button', {
            className: 'cfl-chip', style: { fontSize: '11px' },
            onClick: function () { loadMeta(0); },
          }, '重试连接')
        ),

        h('div', { style: { marginBottom: '10px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' } },
            h('span', { style: { fontWeight: 600, fontSize: '13px' } },
              '参考图（' + refs.filter(function (x) { return x && x.trim(); }).length + '/10）'),
            h('button', { className: 'cfl-chip', onClick: uploadMany, style: { fontSize: '12px' } }, '＋ 上传'),
            h('select', {
              value: '',
              onChange: function (e) { if (e.target.value) importOutputAppend(e.target.value); },
              style: { fontSize: '12px', maxWidth: '230px' },
            },
              h('option', { value: '' }, outputs.length ? '从 output 选…' : '（output 里没有图片）'),
              ...outputs.map(function (item) {
                const key = (item.subfolder ? item.subfolder + '/' : '') + item.name;
                const mins = Math.round((Date.now() - item.mtime) / 60000);
                const when = mins < 60 ? mins + ' 分钟前' : Math.round(mins / 60) + ' 小时前';
                return h('option', { key: key, value: key }, item.name + ' · ' + when);
              })
            ),
            h('button', {
              className: 'cfl-chip',
              title: '重新读取 ComfyUI 的 output 目录',
              onClick: function () { loadOutputs(); },
              style: { fontSize: '12px' },
            }, '↻')
          ),

          refs.length === 0
            ? h('div', { style: { fontSize: '12px', opacity: 0.55 } }, '空')
            : h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } },
                refs.map(function (name, i) { return refCard(i, name); })
              )
        ),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '4px' } },
          h('span', { style: { fontSize: '12px', opacity: 0.65 } },
            '编辑指令：说清每张图提供什么、成品要什么样，例如「用第 2 张的女生、第 3 张的电竞房场景合成一张画面」；输出比例跟随第 1 张图'),
          h('button', {
            className: 'cfl-chip',
            disabled: polishing,
            title: '用当前会话的模型改写编辑指令（不会加 <Picture N> 标签）',
            onClick: polishPrompt,
            style: { fontSize: '12px' },
          }, polishing ? '改写中…' : '✨ 改写指令'),
          prevPrompt
            ? h('button', {
                className: 'cfl-chip',
                title: '恢复润化前的指令',
                onClick: function () { setPrompt(prevPrompt); setPrevPrompt(''); },
                style: { fontSize: '12px' },
              }, '↩ 撤销')
            : null
          , polishNote
            ? h('span', { style: { fontSize: '11px', opacity: 0.55 } }, polishNote)
            : null
        ),
        h('textarea', {
          value: prompt,
          onChange: function (e) { setPrompt(e.target.value); },
          rows: 3,
          placeholder: 'Replace costumes for the character',
          style: { width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '13px' },
        }),

        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-end', marginTop: '10px' } },
          num('步数', 'steps', 4, 60, 1, '64px'),
          num('CFG', 'cfg', 1, 10, 0.1, '64px'),
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
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' } },
            h('input', {
              type: 'checkbox', checked: cfg.enhance,
              onChange: function (e) { setCfg(function (prev) { return { ...prev, enhance: e.target.checked }; }); },
            }),
            '提示词增强'
          ),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' } },
            h('input', {
              type: 'checkbox', checked: cfg.fixedSize,
              onChange: function (e) { setCfg(function (prev) { return { ...prev, fixedSize: e.target.checked }; }); },
            }),
            '固定尺寸'
          ),
          cfg.fixedSize ? num('宽', 'width', 256, 2048, 64, '72px') : null,
          cfg.fixedSize ? num('高', 'height', 256, 2048, 64, '72px') : null,
          h('button', {
            className: 'cfl-chip', onClick: generate, disabled: busy !== '' || active,
            style: { fontWeight: 600 },
          }, active ? '编辑中…' : '开始编辑')
        ),

        error ? h('div', { style: { color: '#e05c5c', fontSize: '13px', marginTop: '10px' } }, error) : null,
        busy ? h('div', { style: { opacity: 0.7, fontSize: '12px', marginTop: '8px' } }, busy) : null,

        job
          ? h('div', { style: { marginTop: '16px' } },
              h('div', { style: { fontSize: '12px', marginBottom: '8px' } },
                job.id + ' · ' + job.status
                + (job.elapsedSeconds ? ' · ' + job.elapsedSeconds + 's' : '')
                + (job.summary && job.summary.seed !== undefined ? ' · 种子 ' + job.summary.seed : '')),
              job.error ? h('div', { style: { color: '#e05c5c', fontSize: '12px', marginBottom: '8px' } }, job.error) : null,
              resultSrc
                ? h('div', {
                    onClick: function () { setViewer(resultSrc); },
                    title: '点击查看大图',
                    style: { display: 'inline-block', cursor: 'zoom-in', borderRadius: '6px', overflow: 'hidden', border: '1px solid rgba(128,128,128,0.25)' },
                  },
                    h('img', {
                      src: resultSrc, alt: 'edited',
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
              h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px' } }, '最近编辑'),
              history.slice(0, 10).map(function (item) {
                const cover = item.status === 'done'
                  ? h('img', {
                      src: '/api/comfyui-imgedit/media?id=' + encodeURIComponent(item.id),
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
                      item.status + (item.summary && item.summary.prompt ? ' · ' + String(item.summary.prompt).slice(0, 24) : '') + (item.error ? ' · ' + item.error : ''))
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
          id: 'comfyui-imgedit',
          order: 6,
          label: () => '图片编辑',
        }, EditIcon));

        ctx.slots.inject('main', () => {
          const disposers = [
            ctx.slots.register({ name: 'main', key: 'comfyui-imgedit' }, EditPanel),
          ];
          return function disposeMain() { disposers.forEach(function (d) { d(); }); };
        });
      },
    };
  },
});
