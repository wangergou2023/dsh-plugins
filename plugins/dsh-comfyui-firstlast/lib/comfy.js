/**
 * ComfyUI 客户端（宿主进程内使用）。
 * 只做四件事：提交工作流、轮询结果、上传图片、取回产物。
 */

export class ComfyClient {
  constructor(host = 'http://127.0.0.1:8188') {
    this.host = host.replace(/\/+$/, '');
  }

  async alive() {
    try {
      const res = await fetch(this.host + '/system_stats', { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const data = await res.json();
      return {
        version: data.system?.comfyui_version || 'unknown',
        device: data.devices?.[0]?.name || 'unknown',
        vramFreeGB: Math.round((data.devices?.[0]?.vram_free || 0) / 1024 ** 3 * 10) / 10,
      };
    } catch {
      return null;
    }
  }

  async queue() {
    const res = await fetch(this.host + '/queue', { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    return { running: data.queue_running?.length || 0, pending: data.queue_pending?.length || 0 };
  }

  async idle(timeoutMs = 600000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const q = await this.queue();
      if (q.running === 0 && q.pending === 0) return;
      await sleep(3000);
    }
    throw new Error('ComfyUI 队列一直忙');
  }

  /** 提交工作流，返回 prompt_id。 */
  async submit(workflow) {
    const res = await fetch(this.host + '/prompt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = body?.node_errors ? JSON.stringify(body.node_errors).slice(0, 600) : JSON.stringify(body).slice(0, 400);
      throw new Error('工作流被拒（HTTP ' + res.status + '）：' + detail);
    }
    return body.prompt_id;
  }

  /** 等待某个 prompt 完成，返回 history 条目。 */
  async wait(promptId, timeoutMs = 1800000, onTick) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(3000);
      let history;
      try {
        const res = await fetch(this.host + '/history/' + promptId, { signal: AbortSignal.timeout(10000) });
        history = await res.json();
      } catch {
        continue;
      }
      const entry = history[promptId];
      if (!entry) {
        if (onTick) onTick(Math.round((Date.now() - start) / 1000));
        continue;
      }
      if (entry.status && entry.status.status_str !== 'success') {
        throw new Error('执行失败：' + JSON.stringify(entry.status).slice(0, 800));
      }
      return entry;
    }
    throw new Error('等待超时');
  }

  /** 从 history 条目里取第一份产物并下载为 Buffer。 */
  async fetchOutput(entry) {
    const item = Object.values(entry.outputs || {}).flatMap((o) => o.images || o.gifs || o.videos || [])[0];
    if (!item) throw new Error('这次执行没有产出文件');
    const url = this.host + '/view?filename=' + encodeURIComponent(item.filename)
      + '&subfolder=' + encodeURIComponent(item.subfolder || '')
      + '&type=' + (item.type || 'output');
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error('取回产物失败 HTTP ' + res.status);
    return { buffer: Buffer.from(await res.arrayBuffer()), meta: item.metadata || {} };
  }

  /** 上传本地文件（图片 / 音频 / 视频），返回 ComfyUI 里的文件名。 */
  async upload(buffer, filename, mime = 'image/png') {
    const form = new FormData();
    form.append('image', new Blob([buffer], { type: mime }), filename);
    form.append('overwrite', 'true');
    const res = await fetch(this.host + '/upload/image', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error('上传失败 HTTP ' + res.status);
    return (await res.json()).name;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
