window.__ModuleLoader__.load({
  id: 'dsh-comfyui-refvideo',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** 统一调用：空响应 / 非 JSON 都给能看懂的错误，不把 parse 异常抛给用户。 */
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

    /** 表单状态存本地，切走/刷新回来还在。 */
    const FORM_KEY = 'comfyui-refvideo.form.v1';

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
      aspectRatio: '16:9 (Widescreen)',
      megapixels: 0.4,
      durationSeconds: 5,
      seed: '',
      lightning: true,
      refImageSize: 'match',
    };

    function Ref2VIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20;
      const active = !!(props && props.active);
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: active ? 1.9 : 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('rect', { key: 'a', x: 2.6, y: 6.4, width: 12.8, height: 11.2, rx: 2 }),
        h('path', { key: 'b', d: 'M15.4 11.2 21.4 7.6v8.8l-6 -3.6z' }),
        h('circle', { key: 'c', cx: 6.6, cy: 10.2, r: 1.2 })
      );
    }

    function Ref2VPanel() {
      const [initial] = React.useState(function () { return loadForm(); });
      const [meta, setMeta] = React.useState(null);
      const [modelValues, setModelValues] = React.useState({});
      const [metaError, setMetaError] = React.useState('');
      const [prompt, setPrompt] = React.useState((initial && initial.prompt) || '');
      const [slots, setSlots] = React.useState(
        (initial && initial.slots) || { images: [], videos: [], audios: [] }
      );
      const [cfg, setCfg] = React.useState(function () {
        return { ...CFG_DEFAULTS, ...((initial && initial.cfg) || {}) };
      });
      const [job, setJob] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [polishing, setPolishing] = React.useState(false);
      const [polishNote, setPolishNote] = React.useState('');
      const [prevPrompt, setPrevPrompt] = React.useState('');
      const [outputs, setOutputs] = React.useState({ images: [], videos: [], audios: [] });
      const [history, setHistory] = React.useState([]);

      // 表单改动落本地
      React.useEffect(function () {
        try {
          window.localStorage.setItem(FORM_KEY, JSON.stringify({ prompt, slots, cfg }));
        } catch { /* 隐私模式下写不进去就算了 */ }
      }, [prompt, slots, cfg]);

      const refreshHistory = React.useCallback(function () {
        api('/api/comfyui-refvideo/jobs')
          .then(function (d) {
            if (!d || !Array.isArray(d.jobs)) return;
            setHistory(d.jobs);
            // 没有选中任务时，自动挂上最新一条——任务跑完回头看就能直接播
            setJob(function (current) { return current || d.jobs[0] || null; });
          })
          .catch(function () {});
      }, []);

      const loadMeta = React.useCallback(async function (attempt) {
        const tries = typeof attempt === 'number' ? attempt : 0;
        try {
          const data = await api('/api/comfyui-refvideo/meta');
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
        // 历史列表定时刷新：任务在后台跑完后不用重新进页面
        const timer = setInterval(refreshHistory, 5000);
        return function () { clearInterval(timer); };
      }, [loadMeta, refreshHistory]);

      async function loadOutputs() {
        try {
          const data = await api('/api/comfyui-refvideo/outputs?limit=200');
          const grouped = { images: [], videos: [], audios: [] };
          for (const file of (data && data.files) || []) {
            if (grouped[file.kind]) grouped[file.kind].push(file);
          }
          setOutputs(grouped);
        } catch { /* 读不到就留空 */ }
      }

      /** 选中 output 里的文件 → 复制进 input → 加进对应槽位。 */
      async function importOutput(kind, key) {
        const slash = key.indexOf('/');
        const subfolder = slash >= 0 ? key.slice(0, slash) : '';
        const name = slash >= 0 ? key.slice(slash + 1) : key;
        setError('');
        setBusy('正在导入…');
        try {
          const data = await api('/api/comfyui-refvideo/import', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: name, subfolder: subfolder }),
          });
          const target = data.kind || kind;
          setSlots(function (prev) {
            const next = { ...prev };
            next[target] = prev[target].concat([data.name]);
            return next;
          });
        } catch (err) {
          setError(String((err && err.message) || err));
        } finally {
          setBusy('');
        }
      }

      React.useEffect(function () {
        if (!job || (job.status !== 'queued' && job.status !== 'running')) return undefined;
        const timer = setInterval(function () {
          api('/api/comfyui-refvideo/job?id=' + encodeURIComponent(job.id))
            .then(function (next) {
              setJob(next);
              if (next.status === 'done' || next.status === 'failed') refreshHistory();
            })
            .catch(function () {});
        }, 2000);
        return function () { clearInterval(timer); };
      }, [job, refreshHistory]);

      function upload(kind) {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = kind === 'images' ? 'image/*' : kind === 'videos' ? 'video/*' : 'audio/*';
        input.onchange = async function () {
          if (!input.files || input.files.length === 0) return;
          setError('');
          setBusy('正在上传…');
          try {
            const form = new FormData();
            for (const file of input.files) form.append('file', file, file.name);
            const data = await api('/api/comfyui-refvideo/upload', { method: 'POST', body: form });
            setSlots(function (prev) {
              const next = { ...prev };
              next[kind] = prev[kind].concat(data.files.map(function (f) { return f.name; }));
              return next;
            });
          } catch (err) {
            setError(String((err && err.message) || err));
          } finally {
            setBusy('');
          }
        };
        input.click();
      }

      function removeSlot(kind, index) {
        setSlots(function (prev) {
          const next = { ...prev };
          next[kind] = prev[kind].filter(function (_, i) { return i !== index; });
          return next;
        });
      }

      function insertTag(tag) {
        setPrompt(function (prev) { return prev ? prev.replace(/\s*$/, ' ') + tag : tag; });
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
        if (!prompt.trim()) { setError('先写提示词：用 <Picture 1> 这样的标签指代参考素材'); return; }
        setBusy('正在提交…');
        try {
          const body = { ...cfg, prompt, images: slots.images, videos: slots.videos, audios: slots.audios };
          if (body.seed === '' || body.seed === undefined) delete body.seed;
          const data = await api('/api/comfyui-refvideo/run', {
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

      async function polish() {
        setError('');
        if (!prompt.trim()) { setError('先写一点提示词，再点润化'); return; }
        setPolishing(true);
        try {
          const data = await api('/api/comfyui-refvideo/polish', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              prompt: prompt,
              counts: { images: slots.images.length, videos: slots.videos.length, audios: slots.audios.length },
              images: slots.images,
            }),
          });
          setPrevPrompt(prompt);
          setPrompt(data.text);
          {
            const parts = [];
            parts.push(data.vision ? '已读图（' + data.imagesAttached + ' 张）' : '未读图，纯文字改写');
            if (data.coverage && data.coverage.missing && data.coverage.missing.length) {
              parts.push('⚠ 漏了 Picture ' + data.coverage.missing.join('/'));
            }
            setPolishNote(parts.join(' · '));
          }
        } catch (err) {
          setError('润化失败：' + String((err && err.message) || err));
        } finally {
          setPolishing(false);
        }
      }

      function slotRow(kind, label, max) {
        return h('div', { style: { marginBottom: '10px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' } },
            h('span', { style: { fontWeight: 600 } }, label + '（' + slots[kind].length + '/' + max + '）'),
            h('button', {
              className: 'cfl-chip',
              disabled: slots[kind].length >= max,
              onClick: function () { upload(kind); },
            }, '＋ 上传'),
            h('select', {
              value: '',
              disabled: slots[kind].length >= max,
              title: '从 ComfyUI 的 output 目录里选一个已生成的' + label,
              onChange: function (e) { if (e.target.value) importOutput(kind, e.target.value); },
              style: { fontSize: '11px', maxWidth: '190px' },
            },
              h('option', { value: '' }, (outputs[kind] || []).length ? '从 output 选…' : '（output 里没有' + label + '）'),
              ...(outputs[kind] || []).map(function (item) {
                const key = (item.subfolder ? item.subfolder + '/' : '') + item.name;
                const mins = Math.round((Date.now() - item.mtime) / 60000);
                const when = mins < 60 ? mins + ' 分钟前' : Math.round(mins / 60) + ' 小时前';
                return h('option', { key: key, value: key }, item.name + ' · ' + when);
              })
            ),
            h('button', {
              className: 'cfl-chip',
              title: '重新读取 output 目录',
              onClick: function () { loadOutputs(); },
              style: { fontSize: '11px' },
            }, '↻')
          ),
          slots[kind].length === 0
            ? h('div', { style: { opacity: 0.55, fontSize: '12px' } }, '空')
            : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px' } },
                slots[kind].map(function (name, i) {
                  const tag = kind === 'images' ? '<Picture ' + (i + 1) + '>'
                    : kind === 'videos' ? '<Video ' + (i + 1) + '>'
                    : '<Audio ' + (i + 1) + '>';
                  const src = '/api/comfyui-refvideo/preview?filename=' + encodeURIComponent(name);
                  const thumbStyle = { width: '46px', height: '46px', objectFit: 'cover', borderRadius: '4px', display: 'block', background: 'rgba(128,128,128,0.15)', flex: '0 0 auto' };
                  const thumb = kind === 'images'
                    ? h('img', { src: src, alt: name, loading: 'lazy', style: thumbStyle })
                    : kind === 'videos'
                      ? h('video', { src: src, muted: true, preload: 'metadata', style: thumbStyle })
                      : h('div', {
                          style: { ...thumbStyle, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px' },
                          title: name,
                        }, '🔈');
                  return h('div', {
                    key: kind + i,
                    title: name,
                    style: {
                      display: 'flex', alignItems: 'center', gap: '6px', padding: '4px',
                      border: '1px solid rgba(128,128,128,0.25)', borderRadius: '6px', maxWidth: '100%',
                    },
                  },
                    thumb,
                    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 } },
                      h('button', {
                        style: { all: 'unset', cursor: 'pointer', fontSize: '12px', fontWeight: 600 },
                        title: '插入标签 ' + tag,
                        onClick: function () { insertTag(tag); },
                      }, tag),
                      h('span', {
                        style: { opacity: 0.6, fontSize: '11px', maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                      }, name)
                    ),
                    h('button', {
                      style: { all: 'unset', cursor: 'pointer', opacity: 0.6, padding: '0 4px', fontSize: '14px' },
                      title: '移除',
                      onClick: function () { removeSlot(kind, i); },
                    }, '×')
                  );
                })
              )
        );
      }

      function num(label, key, min, max, step) {
        return h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
          label,
          h('input', {
            type: 'number', min, max, step,
            value: cfg[key],
            onChange: function (e) {
              const v = e.target.value;
              setCfg(function (prev) { return { ...prev, [key]: key === 'seed' ? v : Number(v) }; });
            },
            style: { width: '92px' },
          })
        );
      }

      const active = job && (job.status === 'queued' || job.status === 'running');
      const done = job && job.status === 'done' && job.mediaUrl;

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
              })
            )
          : null),
        h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px', flexWrap: 'wrap' } },
          h('h2', { style: { margin: 0, fontSize: '18px' } }, '参考生视频'),
          h('span', { style: { fontSize: '12px', opacity: 0.65 } },
            online
              ? 'ComfyUI ' + meta.comfyui.version + ' · ' + meta.comfyui.device + (vram !== null ? ' · 空闲 ' + vram + ' GB' : '')
              : metaError ? '状态未知：' + metaError
              : !meta ? '正在连接 ComfyUI…'
              : 'ComfyUI 离线' + (meta.comfyui && meta.comfyui.probe
                  ? '：' + (meta.comfyui.probe.error || ('HTTP ' + meta.comfyui.probe.status)) + '（' + meta.comfyui.probe.host + '）'
                  : '')),
          online ? null : h('button', {
            className: 'cfl-chip',
            style: { fontSize: '11px' },
            onClick: function () { loadMeta(0); },
          }, '重试连接')
        ),
        online && vram !== null && vram < 22
          ? h('div', { style: { fontSize: '12px', color: '#e0a030', marginBottom: '10px' } },
              '空闲显存 ' + vram + ' GB < 模型所需 ~22 GB：会走内存卸载，一次可能几十分钟甚至失败')
          : null,

        slotRow('images', '参考图', 9),
        slotRow('videos', '参考视频', 3),
        slotRow('audios', '参考音频', 3),

        h('div', { style: { marginTop: '12px' } },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '4px' } },
            h('span', { style: { fontSize: '12px', opacity: 0.65 } },
              '提示词：用标签按顺序指代素材，例如「<Picture 1> 里的角色在 <Picture 2> 的场景中回头」'),
            h('button', {
              className: 'cfl-chip',
              disabled: polishing,
              title: '用当前会话的模型把提示词改写成更适合参考生视频的一版',
              onClick: polish,
              style: { fontSize: '12px' },
            }, polishing ? '润化中…' : '✨ AI 润化'),
            prevPrompt
              ? h('button', {
                  className: 'cfl-chip',
                  title: '恢复润化前的提示词',
                  onClick: function () { setPrompt(prevPrompt); setPrevPrompt(''); },
                  style: { fontSize: '12px' },
                }, '↩ 撤销润化')
              : null
            ,
            polishNote
              ? h('span', { style: { fontSize: '11px', opacity: 0.55 } }, polishNote)
              : null
          ),
          h('textarea', {
            value: prompt,
            onChange: function (e) { setPrompt(e.target.value); },
            rows: 6,
            placeholder: '描述镜头、动作、镜头运动、声音；用 <Picture 1> / <Video 1> / <Audio 1> 引用上面的素材',
            style: { width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: '13px' },
          })
        ),

        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '12px', alignItems: 'flex-end', marginTop: '10px' } },
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
            '比例',
            h('select', {
              value: cfg.aspectRatio,
              onChange: function (e) { setCfg(function (prev) { return { ...prev, aspectRatio: e.target.value }; }); },
            }, ASPECTS.map(function (a) { return h('option', { key: a[0], value: a[0] }, a[1]); }))
          ),
          num('像素(MP)', 'megapixels', 0.2, 1.0, 0.05),
          num('时长(秒)', 'durationSeconds', 5, 15, 1),
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
            '种子',
            h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } },
              h('input', {
                type: 'number',
                placeholder: '随机',
                value: cfg.seed,
                onChange: function (e) { setCfg(function (prev) { return { ...prev, seed: e.target.value }; }); },
                style: { width: '92px' },
              }),
              h('button', {
                className: 'cfl-chip',
                title: '随机一个种子（留空则每次自动随机）',
                onClick: function () {
                  setCfg(function (prev) { return { ...prev, seed: String(Math.floor(Math.random() * 2 ** 31)) }; });
                },
              }, '🎲')
            )
          ),
          h('label', { style: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: '12px' } },
            '细节',
            h('select', {
              value: cfg.refImageSize,
              onChange: function (e) { setCfg(function (prev) { return { ...prev, refImageSize: e.target.value }; }); },
            },
              h('option', { value: 'match' }, 'match（快）'),
              h('option', { value: 'max' }, 'max（更像，更慢）')
            )
          ),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' } },
            h('input', {
              type: 'checkbox',
              checked: cfg.lightning,
              onChange: function (e) { setCfg(function (prev) { return { ...prev, lightning: e.target.checked }; }); },
            }),
            '4 步加速'
          ),
          h('button', {
            className: 'cfl-chip',
            onClick: generate,
            disabled: busy !== '' || active,
            style: { fontWeight: 600 },
          }, active ? '生成中…' : '生成')
        ),

        error ? h('div', { style: { color: '#e05c5c', fontSize: '13px', marginTop: '10px' } }, error) : null,
        busy ? h('div', { style: { opacity: 0.7, fontSize: '12px', marginTop: '8px' } }, busy) : null,

        job
          ? h('div', { style: { marginTop: '14px', padding: '10px', border: '1px solid rgba(128,128,128,0.25)', borderRadius: '8px' } },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' } },
                h('span', { style: { fontSize: '12px' } },
                  job.id + ' · ' + job.status
                  + (job.elapsedSeconds ? ' · ' + job.elapsedSeconds + 's' : '')
                  + (job.summary && job.summary.seed !== undefined ? ' · 种子 ' + job.summary.seed : '')),
                              ),
              job.error ? h('div', { style: { color: '#e05c5c', fontSize: '12px' } }, job.error) : null,
              done ? h('video', { src: job.mediaUrl, controls: true, style: { width: '100%', maxWidth: '720px', borderRadius: '6px' } }) : null
            )
          : null,

        history.length
          ? h('div', { style: { marginTop: '18px' } },
              h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '6px' } }, '最近生成'),
              history.slice(0, 10).map(function (item) {
                return h('div', {
                  key: item.id,
                  style: { display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px', padding: '3px 0' },
                },
                  h('span', { style: { opacity: 0.6 } }, new Date(item.createdAt).toLocaleString()),
                  h('span', null, item.status),
                  item.status === 'done'
                    ? h('a', { href: '/api/comfyui-refvideo/media?id=' + encodeURIComponent(item.id), target: '_blank', rel: 'noreferrer' }, '打开')
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
          id: 'comfyui-refvideo',
          order: 4,
          label: () => '参考生视频',
        }, Ref2VIcon));

        ctx.slots.inject('main', () => {
          const disposers = [
            ctx.slots.register({ name: 'main', key: 'comfyui-refvideo' }, Ref2VPanel),
          ];
          return function disposeMain() { disposers.forEach(function (d) { d(); }); };
        });
      },
    };
  },
});
