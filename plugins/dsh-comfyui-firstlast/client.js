
/** Electron 里 target=_blank / window.open 会被静默拦掉，改成"复制地址"。 */
function copyStudioUrl(path, btn) {
  const url = location.origin + path;
  const done = function () {
    if (!btn) { try { window.prompt('复制这个地址，粘到浏览器打开：', url); } catch (e) { /* 忽略 */ } return; }
    const old = btn.textContent;
    btn.textContent = '已复制 ✓';
    setTimeout(function () { btn.textContent = old; }, 1600);
  };
  const fallback = function () {
    try {
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta); done();
    } catch (e) { window.prompt('复制这个地址，粘到浏览器打开：', url); }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, fallback);
  else fallback();
}window.__ModuleLoader__.load({
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
      ['16:9 (Widescreen)', '16:9'],
      ['9:16 (Portrait Widescreen)', '9:16'],
      ['1:1 (Square)', '1:1'],
      ['4:3 (Standard)', '4:3'],
      ['3:4 (Portrait Standard)', '3:4'],
      ['21:9 (Ultrawide)', '21:9'],
      ['3:2 (Photo)', '3:2'],
      ['2:3 (Portrait Photo)', '2:3'],
    ];

    const FORM_KEY = 'comfyui-firstlast.form.v1';

    const DEFAULTS = {
      aspectRatio: '16:9 (Widescreen)',
      megapixels: 0.4,
      durationSeconds: 5,
      seed: '',
      lightning: true,
      unet: '',
      lora: '',
      models: {},
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
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true },
        h('rect', { x: 2.2, y: 5.2, width: 6.4, height: 13.6, rx: 1.6, ...stroke }),
        h('rect', { x: 15.4, y: 5.2, width: 6.4, height: 13.6, rx: 1.6, ...stroke }),
        h('path', { d: 'M9.4 12h5.2M12.9 9.8l2.2 2.2-2.2 2.2', ...stroke })
      );
    }

    const labelStyle = { fontSize: '13px', fontWeight: 600, color: 'inherit' };
    const hintStyle = { fontSize: '12px', opacity: 0.55, marginLeft: '6px' };
    const btnStyle = { all: 'unset', cursor: 'pointer', fontSize: '12px', padding: '3px 9px', border: '1px solid rgba(128,128,128,0.35)', borderRadius: '6px', display: 'inline-flex', alignItems: 'center', gap: '4px' };
    const fieldStyle = { display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '12px', opacity: 0.85 };
    const inputStyle = { padding: '4px 7px', borderRadius: '6px', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', fontSize: '13px' };

    function FrameRow(props) {
      const { title, required, value, onUpload, onPick, onRefresh, onClear, onZoom, busy, options } = props;
      const list = options || [];
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
          h('span', { style: labelStyle }, title),
          h('span', { style: hintStyle }, required ? '必填' : '可选'),
          h('button', { style: btnStyle, onClick: onUpload, disabled: !!busy }, '＋ 上传'),
          h('select', {
            value: '',
            disabled: !!busy || !list.length,
            title: list.length ? '从 ComfyUI 的 output 目录里选一张已生成的图' : 'output 目录里还没有图片',
            onChange: function (e) { if (e.target.value) onPick(e.target.value); },
            style: { ...inputStyle, fontSize: '11px', maxWidth: '320px' },
          },
            h('option', { value: '' }, list.length ? '从 output 选…' : '（output 里没有图片）'),
            list.map(function (item) { return h('option', { key: item.key, value: item.key }, item.label); })
          ),
          h('button', { style: btnStyle, onClick: onRefresh, title: '重新读取 output 目录' }, '↻'),
          value ? h('button', { style: btnStyle, onClick: onClear, title: '清空' }, '↺ 清空') : null
        ),
        value
          ? h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
              h('div', { style: { position: 'relative' } },
                h('img', {
                  src: '/api/comfyui-firstlast/frames?name=' + encodeURIComponent(value),
                  alt: title,
                  onClick: onZoom,
                  style: { width: '184px', height: '104px', objectFit: 'cover', borderRadius: '7px', border: '1px solid rgba(128,128,128,0.3)', cursor: 'zoom-in', display: 'block' },
                })
              ),
              h('div', { style: { fontSize: '11px', opacity: 0.5, maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingTop: '4px' } }, value)
            )
          : h('div', { style: { fontSize: '12px', opacity: 0.4, padding: '10px 0 2px' } }, required ? '还没有首帧——没有起点，模型不知道从哪里开始动' : '不给尾帧也行：模型只从首帧往后推')
      );
    }

    function FirstLastPanel() {
      return h('div', {
        style: { height: '100%', minHeight: 520, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#f4f5f7' },
      },
        h('div', {
          style: { display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', height: 34, flex: 'none', borderBottom: '1px solid #e6e8ec', background: '#fff', fontSize: 12, color: '#5b6169' },
        },
          h('b', { style: { fontSize: 12.5, color: '#22262c' } }, "首尾帧视频 · 工作台"),
          h('button', {
            onClick: function (e) { copyStudioUrl('/api/comfyui-firstlast/studio', e.currentTarget); },
            style: { all: 'unset', cursor: 'pointer', marginLeft: 'auto', color: '#3f5bd9' },
            title: '在浏览器里打开：/api/comfyui-firstlast/studio',
          }, '↗ 复制地址'),
          h('button', {
            onClick: function () {
              const f = document.querySelector('iframe[data-studio="' + "/api/comfyui-firstlast/studio" + '"]');
              if (f) f.src = "/api/comfyui-firstlast/studio" + '?t=' + Date.now();
            },
            style: { border: '1px solid #dcdfe5', background: '#fff', borderRadius: 7, padding: '3px 9px', fontSize: 12, cursor: 'pointer' },
          }, '↻ 刷新'),
        ),
        h('iframe', {
          'data-studio': "/api/comfyui-firstlast/studio",
          src: "/api/comfyui-firstlast/studio",
          style: { flex: 1, width: '100%', border: '0', minHeight: 480, background: '#f4f5f7' },
        }),
      );
    }

    function FirstLastPanelLegacy() {
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
      const [polishing, setPolishing] = React.useState(false);
      const [polishNote, setPolishNote] = React.useState('');
      const [prevPrompt, setPrevPrompt] = React.useState('');
      const [outputs, setOutputs] = React.useState([]);

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
      const refreshOutputs = React.useCallback(function () {
        api('/api/comfyui-firstlast/outputs?limit=120').then(function (d) {
          setOutputs((d && d.files) || []);
        }).catch(function () {});
      }, []);

      const refreshMeta = React.useCallback(function () {
        api('/api/comfyui-firstlast/meta').then(setMeta).catch(function () { setMeta({ alive: null }); });
        api('/api/comfyui-firstlast/outputs?limit=120').then(function (d) {
          setOutputs((d && d.files) || []);
        }).catch(function () {});
      }, []);
      React.useEffect(function () {
        refreshMeta();

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

      function uploadTo(setter, label) {
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

      async function importOutput(target, key) {
        if (!key) return;
        const slash = key.indexOf('/');
        const subfolder = slash >= 0 ? key.slice(0, slash) : '';
        const name = slash >= 0 ? key.slice(slash + 1) : key;
        setError('');
        setBusy('正在导入…');
        try {
          const data = await api('/api/comfyui-firstlast/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name, subfolder }),
          });
          target(data.name);
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy('');
        }
      }

      async function polish() {
        if (!prompt.trim()) { setError('先写一句，再润化'); return; }
        setError('');
        setPolishNote('');
        setPolishing(true);
        try {
          const data = await api('/api/comfyui-firstlast/polish', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: prompt.trim(), first, last, counts: { first: first ? 1 : 0, last: last ? 1 : 0 } }),
          });
          setPrevPrompt(prompt);
          setPrompt(data.prompt);
          setPolishNote('已润化，可点「↩ 撤销润化」还原');
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setPolishing(false);
        }
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
              unet: cfg.unet || undefined,
              lora: cfg.lora || undefined,
              models: cfg.models || {},
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
      const alive = meta && meta.alive;
      const lowVram = alive && typeof alive.vramFreeGB === 'number' && alive.vramFreeGB < 3;

      const imageOptions = React.useMemo(function () {
        const now = Date.now();
        return outputs
          .filter(function (f) { return f.kind === 'image'; })
          .slice(0, 120)
          .map(function (f) {
            const mins = Math.max(0, Math.round((now - f.mtime) / 60000));
            const when = mins < 60 ? mins + ' 分钟前' : Math.round(mins / 60) + ' 小时前';
            const label = f.subfolder ? f.subfolder + '/' + f.name : f.name;
            return { key: label, label: label + ' · ' + when };
          });
      }, [outputs]);

      // 顶部模型排：和「参考生视频」一致，把模板里所有 loader 字段摊成一排下拉
      function renderModelBar() {
        const models = (meta && meta.models) || [];
        if (!models.length) return null;
        const picked = cfg.models || {};
        return h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', fontSize: '12px', marginBottom: '2px' } },
          h('span', { style: { opacity: 0.6 } }, '模型：'),
          models.map(function (m) {
            const current = (picked[m.node] && picked[m.node][m.field]) || m.value || (m.options[0] || '');
            return h('label', {
              key: m.node + ':' + m.field,
              title: m.class_type + ' · 节点 ' + m.node,
              style: { display: 'flex', alignItems: 'center', gap: '4px' },
            },
              h('span', { style: { opacity: 0.55 } }, m.label),
              h('select', {
                value: current,
                onChange: function (e) {
                  const value = e.target.value;
                  setCfg(function (prev) {
                    const next = { ...prev, models: { ...(prev.models || {}) } };
                    next.models[m.node] = { ...(next.models[m.node] || {}), [m.field]: value };
                    return next;
                  });
                },
                style: { ...inputStyle, fontSize: '11px', maxWidth: '230px' },
              }, m.options.map(function (o) { return h('option', { key: o, value: o }, o); }))
            );
          })
        );
      }

      return h('div', {
        style: {
          padding: '16px 20px', maxWidth: '1120px', height: '100%', overflowY: 'auto', overflowX: 'hidden',
          boxSizing: 'border-box', overscrollBehavior: 'contain', display: 'flex', flexDirection: 'column', gap: '12px',
        },
      },
        renderModelBar(),
        h('div', null,
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
            h('div', { style: { fontSize: '17px', fontWeight: 600 } }, '首尾帧视频'),
            h('div', { style: { fontSize: '12px', opacity: 0.55 } },
              meta == null ? '连接中…'
                : alive ? 'ComfyUI ' + (alive.version || '') + ' · ' + (alive.device || '') + ' · 空闲 ' + (alive.vramFreeGB || '?') + ' GB'
                : 'ComfyUI 离线'
            ),
            h('button', {
              onClick: function () { refreshMeta(); },
              title: '重新读取 ComfyUI 状态与 output 列表',
              style: { padding: '2px 8px', fontSize: '11px', borderRadius: '999px', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', cursor: 'pointer' },
            }, '↻ 重连')
          ),
          lowVram
            ? h('div', { style: { fontSize: '12px', color: '#d9a441', marginTop: '4px' } },
                '空闲显存 ' + alive.vramFreeGB + ' GB < 模型所需 ~22 GB：会走内存卸载，一次可能几分钟甚至失败')
            : null,
        ),

        h(FrameRow, {
          title: '首帧', required: true, value: first, busy: busy,
          options: imageOptions,
          onUpload: function () { uploadTo(setFirst, '首帧'); },
          onPick: function (key) { importOutput(setFirst, key); },
          onRefresh: refreshOutputs,
          onClear: function () { setFirst(''); },
          onZoom: function () { setZoom(first); },
        }),

        h(FrameRow, {
          title: '尾帧', required: false, value: last, busy: busy,
          options: imageOptions,
          onUpload: function () { uploadTo(setLast, '尾帧'); },
          onPick: function (key) { importOutput(setLast, key); },
          onRefresh: refreshOutputs,
          onClear: function () { setLast(''); },
          onZoom: function () { setZoom(last); },
        }),

        h('div', null,
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '5px' } },
            h('span', { style: labelStyle }, '提示词'),
            h('span', { style: hintStyle }, '写中间发生了什么：动作、镜头、光线变化'),
            h('button', { style: btnStyle, onClick: polish, disabled: polishing || active }, polishing ? '润化中…' : '✨ AI 润化'),
            prevPrompt ? h('button', { style: btnStyle, onClick: function () { setPrompt(prevPrompt); setPrevPrompt(''); setPolishNote(''); } }, '↩ 撤销润化') : null,
            polishNote ? h('span', { style: { fontSize: '12px', color: '#5a9e6f' } }, polishNote) : null
          ),
          h('textarea', {
            value: prompt,
            onChange: function (e) { setPrompt(e.target.value); },
            rows: 4,
            placeholder: '例：店员从柜台后走到门口，手扶上玻璃门，门外的雨声变大；镜头缓慢推近，最后停在门口那张机位上',
            style: { width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: '8px', border: '1px solid rgba(128,128,128,0.35)', background: 'transparent', color: 'inherit', fontSize: '13px', resize: 'vertical', lineHeight: 1.6 },
          })
        ),

        h('div', { style: { display: 'flex', gap: '12px', alignItems: 'flex-end', flexWrap: 'wrap' } },
          h('label', { style: fieldStyle }, '比例',
            h('select', {
              value: cfg.aspectRatio,
              onChange: function (e) { setCfg(function (p) { return { ...p, aspectRatio: e.target.value }; }); },
              style: inputStyle,
            }, ASPECTS.map(function (a) { return h('option', { key: a[0], value: a[0] }, a[1]); }))
          ),
          h('label', { style: fieldStyle }, '像素(MP)',
            h('input', {
              type: 'number', min: 0.2, max: 1, step: 0.1, value: cfg.megapixels,
              onChange: function (e) { setCfg(function (p) { return { ...p, megapixels: e.target.value }; }); },
              style: { ...inputStyle, width: '76px' },
            })
          ),
          h('label', { style: fieldStyle }, '时长(秒)',
            h('input', {
              type: 'number', min: 2, max: 15, step: 1, value: cfg.durationSeconds,
              onChange: function (e) { setCfg(function (p) { return { ...p, durationSeconds: e.target.value }; }); },
              style: { ...inputStyle, width: '76px' },
            })
          ),
          h('label', { style: fieldStyle }, '种子',
            h('input', {
              type: 'text', value: cfg.seed, placeholder: '随机',
              onChange: function (e) { setCfg(function (p) { return { ...p, seed: e.target.value }; }); },
              style: { ...inputStyle, width: '110px' },
            })
          ),
          h('label', { style: { ...fieldStyle, flexDirection: 'row', alignItems: 'center', gap: '5px', paddingBottom: '4px' } },
            h('input', {
              type: 'checkbox', checked: cfg.lightning,
              onChange: function (e) { setCfg(function (p) { return { ...p, lightning: e.target.checked }; }); },
            }),
            '闪电加速'
          ),
          h('button', {
            onClick: generate,
            disabled: active,
            style: { padding: '6px 20px', borderRadius: '7px', border: '1px solid rgba(128,128,128,0.35)', background: active ? 'transparent' : 'rgba(120,140,255,0.18)', color: 'inherit', cursor: active ? 'default' : 'pointer', fontWeight: 600, fontSize: '13px' },
          }, active ? '生成中…' : '生成')
        ),

        error ? h('div', { style: { color: '#e05c5c', fontSize: '12px' } }, error) : null,
        busy ? h('div', { style: { opacity: 0.65, fontSize: '12px' } }, busy) : null,

        job
          ? h('div', { style: { padding: '9px 11px', border: '1px solid rgba(128,128,128,0.25)', borderRadius: '8px' } },
              h('div', { style: { fontSize: '12px', opacity: 0.7, marginBottom: '5px' } },
                job.id + ' · ' + job.status
                  + (job.elapsedSeconds ? ' · ' + job.elapsedSeconds + 's' : '')
                  + (job.summary && job.summary.seed !== undefined ? ' · 种子 ' + job.summary.seed : '')
                  + (job.summary && job.summary.frames ? ' · ' + job.summary.frames + ' 帧' : '')
              ),
              job.warning ? h('div', { style: { fontSize: '12px', color: '#d9a441', marginBottom: '5px' } }, job.warning) : null,
              job.error ? h('div', { style: { fontSize: '12px', color: '#e05c5c' } }, job.error) : null,
              done ? h('video', { src: '/api/comfyui-firstlast/media?id=' + encodeURIComponent(job.id), controls: true, style: { width: '100%', maxWidth: '680px', borderRadius: '6px' } }) : null
            )
          : null,

        history.length
          ? h('div', null,
              h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px' } }, '最近生成'),
              history.slice(0, 10).map(function (item) {
                return h('div', { key: item.id, style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px', padding: '2px 0' } },
                  h('span', { style: { opacity: 0.55 } }, new Date(item.createdAt).toLocaleString()),
                  h('span', null, item.status),
                  item.status === 'done'
                    ? h('a', { href: '/api/comfyui-firstlast/media?id=' + encodeURIComponent(item.id), target: '_blank', rel: 'noreferrer', style: { color: 'inherit' } }, '打开')
                    : h('span', { style: { opacity: 0.45 } }, item.error || ''),
                  h('button', { style: { all: 'unset', cursor: 'pointer', opacity: 0.55 }, title: '查看', onClick: function () { setJob(item); } }, '↗')
                );
              })
            )
          : null,

        zoom
          ? h('div', {
              onClick: function () { setZoom(''); },
              style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, cursor: 'zoom-out' },
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
          order: 4,
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
