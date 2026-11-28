/**
 * output 目录读写的共用小工具：面板「从 output 选」用它把已有素材捡回来。
 * 与 refvideo 里的实现同源，这里只要图片和视频两类。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const KIND_EXT = {
  image: new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']),
  video: new Set(['.mp4', '.webm', '.mov', '.mkv']),
};

function kindOfExt(ext) {
  for (const [kind, set] of Object.entries(KIND_EXT)) if (set.has(ext)) return kind;
  return null;
}

function outputRoots() {
  const list = [];
  const env = process.env.DSH_COMFY_OUTPUT_DIR;
  if (env) list.push(env);
  const local = process.env.LOCALAPPDATA || '';
  if (local) list.push(path.join(local, 'Comfy-Desktop', 'ComfyUI-Shared', 'output'));
  list.push('E:\\ComfyUI\\output', 'C:\\ComfyUI\\output', 'D:\\ComfyUI\\output');
  return list;
}

function mimeOfName(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  return 'image/png';
}

/** 列出 output 里的图片与视频（按时间倒序）。 */
export async function listOutputs(limit = 200) {
  for (const root of outputRoots()) {
    let entries = [];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = [];
    const collect = async (dir, subfolder) => {
      let list = [];
      try {
        list = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of list) {
        if (!entry.isFile()) continue;
        const kind = kindOfExt(path.extname(entry.name).toLowerCase());
        if (!kind) continue;
        const info = await fs.stat(path.join(dir, entry.name)).catch(() => null);
        if (info) files.push({ name: entry.name, subfolder, kind, size: info.size, mtime: info.mtimeMs });
      }
    };
    for (const entry of entries) {
      if (entry.isDirectory()) await collect(path.join(root, entry.name), entry.name);
      else if (entry.isFile()) {
        const kind = kindOfExt(path.extname(entry.name).toLowerCase());
        if (!kind) continue;
        const info = await fs.stat(path.join(root, entry.name)).catch(() => null);
        if (info) files.push({ name: entry.name, subfolder: '', kind, size: info.size, mtime: info.mtimeMs });
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    return { root, files: files.slice(0, limit) };
  }
  return { root: null, files: [] };
}

/** 把 output 里的文件复制进 ComfyUI 的 input，返回 input 里的文件名。 */
export async function importFromOutput(client, name, subfolder = '') {
  const safeName = String(name || '').replace(/^.*[\\/]/, '');
  if (!safeName) throw new Error('没有指定文件名');
  for (const root of outputRoots()) {
    const full = path.join(root, String(subfolder || ''), safeName);
    let buffer;
    try {
      buffer = await fs.readFile(full);
    } catch {
      continue;
    }
    const uploaded = await client.upload(buffer, safeName, mimeOfName(safeName));
    return { name: uploaded, kind: kindOfExt(path.extname(safeName).toLowerCase()) };
  }
  throw new Error('output 里找不到这个文件：' + safeName);
}
