import fs from 'node:fs/promises';
import path from 'node:path';

export const MAX_JOBS = 30;

export class JobStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'mv-jobs.json');
    this.jobs = new Map();
    this.mtime = 0;
    this.ready = this.load();
  }

  async load(clear = false) {
    try {
      const list = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!Array.isArray(list)) return;
      if (clear) this.jobs = new Map();
      for (const job of list) this.jobs.set(job.id, job);
    } catch { /* 首次运行 */ }
  }

  /**
   * 磁盘上有更新就重读。
   * 插件重载后可能同时存在两个实例，共用一个 jobs.json：跑任务的那个在写，
   * 显示状态的那个如果不重读，就会一直报旧阶段（曾显示卡在"定妆图"而实际已在渲染）。
   */
  async refresh() {
    try {
      const stat = await fs.stat(this.file);
      if (stat.mtimeMs === this.mtime) return;
      this.mtime = stat.mtimeMs;
      await this.load(true);
    } catch { /* 文件还没写出来 */ }
  }

  async persist() {
    const list = [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_JOBS);
    this.jobs = new Map(list.map((job) => [job.id, job]));
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify(list, null, 2), 'utf8');
    try { this.mtime = (await fs.stat(this.file)).mtimeMs; } catch { /* 忽略 */ }
  }

  create(params) {
    const id = 'mv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const job = { id, status: 'queued', stage: 'queued', createdAt: Date.now(), updatedAt: Date.now(), params, shots: [] };
    this.jobs.set(id, job);
    return job;
  }

  /**
   * 插件重载/进程退出后，旧任务还挂着 running，其实早就死了
   * （ComfyUI 队列是空的，却一直显示"正在跑"，还把续跑挡在 409 门外）。
   * 载入时统一标成 interrupted，面板给"续跑"。
   */
  async reapOrphans() {
    await this.refresh();
    const victims = [...this.jobs.values()].filter((job) => job.status === 'running' || job.status === 'queued');
    if (!victims.length) return 0;
    for (const job of victims) {
      job.status = 'interrupted';
      job.error = '进程重启，任务中断（可以续跑）';
      job.updatedAt = Date.now();
    }
    await this.persist();
    return victims.length;
  }

  get(id) { return this.jobs.get(id) || null; }

  list(limit = 20) {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
  }

  async patch(id, patch) {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: Date.now() });
    await this.persist();
    return job;
  }

  async patchShot(id, index, patch) {
    const job = this.jobs.get(id);
    if (!job) return null;
    const shot = job.shots.find((s) => s.index === index);
    if (shot) Object.assign(shot, patch);
    job.updatedAt = Date.now();
    await this.persist();
    return job;
  }
}

/* ---------------------------- 分镜表生成 ---------------------------- */

/**
 * 密度样例：不是"参考风格"，是把"表演/他要/道具"写到什么颗粒度给模型看一眼。
 * 这段是手写本子里挑出来的两镜，作用等于 few-shot——底层 LLM 就是 DSH 自己的，
 * 提示词里放一段真样例，比再加十条规则有效。
 */
