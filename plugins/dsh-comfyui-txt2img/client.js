window.__ModuleLoader__.load({
  id: 'dsh-comfyui-txt2img',
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

    const ASPECTS = [
      ['1:1 (Square)', '1:1'],
      ['16:9 (Widescreen)', '16:9'],
      ['9:16 (Portrait)', '9:16'],
      ['4:3 (Standard)', '4:3'],
      ['3:4 (Portrait)', '3:4'],
      ['3:2 (Photo)', '3:2'],
      ['2:3 (Portrait Photo)', '2:3'],
    ];

    const FORM_KEY = 'comfyui-txt2img.form.v2';
    const CFG_DEFAULTS = {
      aspectRatio: '1:1 (Square)',
      megapixels: 1,
      batchSize: 1,
      steps: 8,
      cfg: 1,
      seed: '',
      expand: true,
      loraEnabled: false,
      loraName: 'krea2_darkbrush.safetensors',
      loraStrength: 0.8,
      suffixEnabled: false,
      styleSuffix: '',
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

    function T2IIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20;
      const active = !!(props && props.active);
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: active ? 1.9 : 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('rect', { key: 'a', x: 3, y: 4.5, width: 18, height: 15, rx: 2 }),
        h('circle', { key: 'b', cx: 8.4, cy: 9.6, r: 1.4 }),
        h('path', { key: 'c', d: 'M4.2 17.4l4.8-4.6 3.6 3.4 3-2.8 4.2 4' })
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

    function T2IPanel() {
      const [initial] = React.useState(function () { return loadForm(); });
      const [meta, setMeta] = React.useState(null);
      const [modelValues, setModelValues] = React.useState(function () {
        try {
          const raw = window.localStorage.getItem('comfyui-txt2img.models.v1');
          const parsed = raw ? JSON.parse(raw) : null;
          return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
          return {};
        }
      });
      const [metaError, setMetaError] = React.useState('');
      const [prompt, setPrompt] = React.useState((initial && initial.prompt) || '');
      const [cfg, setCfg] = React.useState(function () {
        return { ...CFG_DEFAULTS, ...((initial && initial.cfg) || {}) };
      });
      const [job, setJob] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [polishing, setPolishing] = React.useState(false);
      const [prevForm, setPrevForm] = React.useState(null);
      const [viewer, setViewer] = React.useState(null);
      const [history, setHistory] = React.useState([]);

      React.useEffect(function () {
        try {
          window.localStorage.setItem(FORM_KEY, JSON.stringify({ prompt, cfg }));
        } catch { /* 忽略 */ }
      }, [prompt, cfg]);

      const refreshHistory = React.useCallback(function () {
        api('/api/comfyui-txt2img/jobs')
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
          const data = await api('/api/comfyui-txt2img/meta');
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
        const timer = setInterval(refreshHistory, 5000);
        return function () { clearInterval(timer); };
      }, [loadMeta, refreshHistory]);

      React.useEffect(function () {
        if (!job || (job.status !== 'queued' && job.status !== 'running')) return undefined;
        const timer = setInterval(function () {
          api('/api/comfyui-txt2img/job?id=' + encodeURIComponent(job.id))
            .then(function (next) {
              setJob(next);
              if (next.status === 'done' || next.status === 'failed') refreshHistory();
            })
            .catch(function () {});
        }, 1500);
        return function () { clearInterval(timer); };
      }, [job, refreshHistory]);

      React.useEffect(function () {
        if (!viewer) return undefined;
        const onKey = function (e) { if (e.key === 'Escape') setViewer(null); };
        window.addEventListener('keydown', onKey);
        return function () { window.removeEventListener('keydown', onKey); };
      }, [viewer]);

      function setModelValue(node, field, value) {
        setModelValues(function (prev) {
          const next = { ...prev };
          next[node] = { ...(prev[node] || {}), [field]: value };
          try { window.localStorage.setItem('comfyui-txt2img.models.v1', JSON.stringify(next)); } catch { /* 忽略 */ }
          return next;
        });
      }

      function resetModels() {
        try { window.localStorage.removeItem('comfyui-txt2img.models.v1'); } catch { /* 忽略 */ }
        setModelValues({});
      }

      function applyTurnaroundPreset() {
        setPrompt('character turnaround sheet, the same character shown in four separate views arranged in a 2x2 grid: top-left front view, top-right left side view, bottom-left back view, bottom-right right side view, full body, standing, neutral A-pose, consistent proportions, consistent costume and colors across all four views, plain light gray background, soft even studio lighting, no text, no watermark');
        setCfg(function (prev) {
          return {
            ...prev,
            loraEnabled: true,
            loraName: 'QuadView_krea2_v1.safetensors',
            loraStrength: 0.9,
            aspectRatio: '1:1 (Square)',
          };
        });
      }

      async function generate() {
        setError('');
        if (!prompt.trim()) { setError('先写提示词'); return; }
        setBusy('正在提交…');
        try {
          const body = { ...cfg, prompt };
          if (body.seed === '' || body.seed === undefined) delete body.seed;
          if (!body.suffixEnabled) body.styleSuffix = '';
          const data = await api('/api/comfyui-txt2img/run', {
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

      async function polishPrompt() {
        setError('');
        if (!prompt.trim()) { setError('先写一点描述，再点润化'); return; }
        setPolishing(true);
        try {
          const data = await api('/api/comfyui-txt2img/polish', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: prompt, loraName: cfg.loraEnabled ? cfg.loraName : '' }),
          });
          setPrevForm({ prompt: prompt, styleSuffix: cfg.styleSuffix, suffixEnabled: cfg.suffixEnabled });
          setPrompt(data.prompt || prompt);
          const suffix = String(data.suffix || '').trim();
          setCfg(function (prev) { return { ...prev, styleSuffix: suffix, suffixEnabled: suffix !== '' }; });
        } catch (err) {
          setError('润化失败：' + String((err && err.message) || err));
        } finally {
          setPolishing(false);
        }
      }

      const online = meta && meta.comfyui && meta.comfyui.online;
      const vram = meta && meta.comfyui ? meta.comfyui.vramFreeGB : null;
      const loras = meta && Array.isArray(meta.loras) ? meta.loras : [];
      const active = job && (job.status === 'queued' || job.status === 'running');
      const files = job && Array.isArray(job.files) ? job.files : [];

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

      return h('div', { style: { padding: '18px 20px', maxWidth: '1080px' } },
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
              }),
              h('button', {
                className: 'cfl-chip',
                style: { fontSize: '11px' },
                title: '清掉手动选择，回到工作流模板里的默认模型',
                onClick: resetModels,
              }, '↺ 恢复默认')
            )
          : null),
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' } },
          h('h2', { style: { margin: 0, fontSize: '18px' } }, '文生图'),
          h('span', { style: { fontSize: '12px', opacity: 0.65 } },
            online
              ? 'Krea2 Turbo · ComfyUI ' + meta.comfyui.version + ' · ' + meta.comfyui.device + (vram !== null ? ' · 空闲 ' + vram + ' GB' : '')
              : metaError ? '状态未知：' + metaError
              : !meta ? '正在连接 ComfyUI…'
              : 'ComfyUI 离线' + (meta.comfyui && meta.comfyui.probe
                  ? '：' + (meta.comfyui.probe.error || ('HTTP ' + meta.comfyui.probe.status)) + '（' + meta.comfyui.probe.host + '）'
                  : '')),
          online ? null : h('button', {
            className: 'cfl-chip', style: { fontSize: '11px' },
            onClick: function () { loadMeta(0); },
          }, '重试连接')
        ),

        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '4px' } },
          h('span', { style: { fontSize: '12px', opacity: 0.65 } },
            '提示词：点润化可让 AI 改写，并顺带生成风格后缀'),
          h('button', {
            className: 'cfl-chip',
            disabled: polishing,
            title: '用当前会话的模型改写提示词，并生成配套的风格后缀',
            onClick: polishPrompt,
            style: { fontSize: '12px' },
          }, polishing ? '润化中…' : '✨ AI 润化'),
          prevForm
            ? h('button', {
                className: 'cfl-chip',
                title: '恢复润化前的提示词与后缀',
                onClick: function () {
                  setPrompt(prevForm.prompt);
                  setCfg(function (prev) { return { ...prev, styleSuffix: prevForm.styleSuffix, suffixEnabled: prevForm.suffixEnabled }; });
                  setPrevForm(null);
                },
                style: { fontSize: '12px' },
              }, '↩ 撤销润化')
            : null
        ),

        h('textarea', {
          value: prompt,
          onChange: function (e) { setPrompt(e.target.value); },
          rows: 5,
          placeholder: '描述你想要的画面：主体、动作、环境、光线、风格',
          style: { width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '13px' },
        }),

        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-end', marginTop: '10px' } },
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
            '比例',
            h('select', {
              value: cfg.aspectRatio,
              onChange: function (e) { setCfg(function (prev) { return { ...prev, aspectRatio: e.target.value }; }); },
            }, ASPECTS.map(function (a) { return h('option', { key: a[0], value: a[0] }, a[1]); }))
          ),
          num('像素(MP)', 'megapixels', 0.2, 2.0, 0.05),
          num('张数', 'batchSize', 1, 4, 1, '64px'),
          num('步数', 'steps', 4, 30, 1, '64px'),
          num('CFG', 'cfg', 1, 5, 0.1, '64px'),
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
              type: 'checkbox', checked: cfg.expand,
              onChange: function (e) { setCfg(function (prev) { return { ...prev, expand: e.target.checked }; }); },
            }),
            'AI 扩写'
          ),
          h('button', {
            className: 'cfl-chip', onClick: applyTurnaroundPreset,
            title: '套用四视图转盘预设：QuadView LoRA + 2×2 四视图提示词',
            style: { fontSize: '12px' },
          }, '🎭 四视图转盘'),
          h('button', {
            className: 'cfl-chip', onClick: generate, disabled: busy !== '' || active,
            style: { fontWeight: 600 },
          }, active ? '生成中…' : '生成')
        ),

        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-end', marginTop: '10px' } },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' } },
            h('input', {
              type: 'checkbox', checked: cfg.loraEnabled,
              onChange: function (e) { setCfg(function (prev) { return { ...prev, loraEnabled: e.target.checked }; }); },
            }),
            '启用 LoRA'
          ),
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
            'LoRA',
            h('select', {
              value: cfg.loraName,
              disabled: !cfg.loraEnabled,
              style: { maxWidth: '220px' },
              onChange: function (e) { setCfg(function (prev) { return { ...prev, loraName: e.target.value }; }); },
            },
              (loras.length ? loras : [cfg.loraName]).map(function (name) {
                return h('option', { key: name, value: name }, name.replace(/\.safetensors$/, ''));
              })
            )
          ),
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
            '强度',
            h('input', {
              type: 'number', min: -2, max: 2, step: 0.05, value: cfg.loraStrength,
              disabled: !cfg.loraEnabled,
              onChange: function (e) { setCfg(function (prev) { return { ...prev, loraStrength: Number(e.target.value) }; }); },
              style: { width: '70px' },
            })
          )
        ),

        h('div', { style: { marginTop: '8px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px' } },
            h('input', {
              type: 'checkbox', checked: cfg.suffixEnabled,
              onChange: function (e) { setCfg(function (prev) { return { ...prev, suffixEnabled: e.target.checked }; }); },
            }),
            '追加风格后缀'
          ),
          cfg.suffixEnabled
            ? h('input', {
                type: 'text', value: cfg.styleSuffix,
                placeholder: '点「AI 润化」会自动生成，也可手填',
                onChange: function (e) { setCfg(function (prev) { return { ...prev, styleSuffix: e.target.value }; }); },
                style: { width: '360px' },
              })
            : h('span', { style: { opacity: 0.5 } }, '（不追加；点「AI 润化」会生成并自动勾上）')
        ),

        error ? h('div', { style: { color: '#e05c5c', fontSize: '13px', marginTop: '10px' } }, error) : null,
        busy ? h('div', { style: { opacity: 0.7, fontSize: '12px', marginTop: '8px' } }, busy) : null,

        job
          ? h('div', { style: { marginTop: '16px' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' } },
                h('span', { style: { fontSize: '12px' } },
                  job.id + ' · ' + job.status
                  + (job.elapsedSeconds ? ' · ' + job.elapsedSeconds + 's' : '')
                  + (job.summary && job.summary.seed !== undefined ? ' · 种子 ' + job.summary.seed : '')
                  + (job.count ? ' · ' + job.count + ' 张' : '')),
                              ),
              job.error ? h('div', { style: { color: '#e05c5c', fontSize: '12px', marginBottom: '8px' } }, job.error) : null,
              job.expanded
                ? h('details', { style: { fontSize: '12px', marginBottom: '10px' } },
                    h('summary', { style: { cursor: 'pointer', opacity: 0.75 } },
                      '实际送进模型的提示词（扩写后，' + job.expanded.length + ' 字）'),
                    h('div', {
                      style: {
                        marginTop: '6px', padding: '8px', borderRadius: '6px',
                        background: 'rgba(128,128,128,0.08)', lineHeight: '1.6',
                        whiteSpace: 'pre-wrap', maxHeight: '220px', overflow: 'auto',
                      },
                    }, job.expanded)
                  )
                : null,
              files.length
                ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px' } },
                    files.map(function (file, i) {
                      const src = '/api/comfyui-txt2img/media?id=' + encodeURIComponent(job.id) + '&i=' + i;
                      return h('div', {
                        key: file,
                        onClick: function () { setViewer(src); },
                        title: '点击查看大图',
                        style: {
                          display: 'block', cursor: 'zoom-in', borderRadius: '6px', overflow: 'hidden',
                          border: '1px solid rgba(128,128,128,0.25)',
                        },
                      },
                        h('img', {
                          src: src, alt: 'result ' + (i + 1),
                          style: { display: 'block', width: '320px', maxWidth: '100%', height: 'auto' },
                        })
                      );
                    })
                  )
                : null
            )
          : null,

        history.length
          ? h('div', { style: { marginTop: '20px' } },
              h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px' } }, '最近生成'),
              history.slice(0, 12).map(function (item) {
                const cover = item.status === 'done'
                  ? h('img', {
                      src: '/api/comfyui-txt2img/media?id=' + encodeURIComponent(item.id) + '&i=0',
                      alt: item.id,
                      style: { width: '56px', height: '56px', objectFit: 'cover', borderRadius: '4px', display: 'block' },
                    })
                  : h('div', { style: { width: '56px', height: '56px', borderRadius: '4px', background: 'rgba(128,128,128,0.15)' } });
                return h('button', {
                  key: item.id,
                  onClick: function () { setJob(item); },
                  style: {
                    all: 'unset', cursor: 'pointer', display: 'flex', gap: '8px',
                    alignItems: 'center', marginBottom: '6px',
                  },
                },
                  cover,
                  h('span', { style: { fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '2px' } },
                    h('span', null, new Date(item.createdAt).toLocaleString()),
                    h('span', { style: { opacity: 0.6 } },
                      item.status + (item.count ? ' · ' + item.count + ' 张' : '') + (item.error ? ' · ' + item.error : ''))
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
          id: 'comfyui-txt2img',
          order: 5,
          label: () => '文生图',
        }, T2IIcon));

        ctx.slots.inject('main', () => {
          const disposers = [
            ctx.slots.register({ name: 'main', key: 'comfyui-txt2img' }, T2IPanel),
          ];
          return function disposeMain() { disposers.forEach(function (d) { d(); }); };
        });
      },
    };
  },
});
