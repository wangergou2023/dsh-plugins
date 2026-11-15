/**
 * 可选的 ffmpeg 后端：只干 ComfyUI 干不了的事 —— 镜头之间的转场（xfade）。
 *
 * 为什么是"可选"：没装 ffmpeg 时插件照常工作，走 ComfyUI 的 ConcatenateVideo 硬切拼接；
 * 装了 ffmpeg 才启用叠化/淡入淡出/甩镜这些真的转场。
 * 查找顺序：环境变量 → 插件 .data/bin → LocalMiniDrama 自带的那份 → PATH。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 转场类型 → ffmpeg xfade 的 transition 名。硬切用一个极短 fade 顶替（xfade 不支持 duration=0）。 */
const XFADE = {
  cut: { name: 'fade', duration: 0.08 },
  dissolve: { name: 'fade', duration: 0.6 },
  fade: { name: 'fadeblack', duration: 0.8 },
  whip: { name: 'wipeleft', duration: 0.35 },
  match: { name: 'fade', duration: 0.35 },
};

export function findFfmpeg(pluginDir) {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates = [];
  if (process.env.DSH_MV_FFMPEG) candidates.push(process.env.DSH_MV_FFMPEG);
  if (pluginDir) candidates.push(path.join(pluginDir, '.data', 'bin', exe));
  candidates.push(path.join(os.homedir(), 'Documents', 'LocalMiniDrama', 'backend-node', 'tools', 'ffmpeg', exe));
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* ignore */ }
  }
  // 最后看 PATH：交给 spawn 自己找
  return exe;
}

function run(bin, args, timeoutMs = 1800000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    let stdout = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += String(d); if (stdout.length > 20000) stdout = stdout.slice(-10000); });
    child.stderr.on('data', (d) => { stderr += String(d); if (stderr.length > 40000) stderr = stderr.slice(-20000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // ffmpeg 的 -version 打到 stdout，正常转码日志打到 stderr，两边都要留
      const out = (stdout + '\n' + stderr).trim();
      if (code === 0) resolve(out);
      else reject(new Error('ffmpeg 退出码 ' + code + '：' + out.slice(-800)));
    });
  });
}

/** 探测可用性（找不到文件时也会通过 spawn 失败体现）。 */
export async function probeFfmpeg(pluginDir) {
  const bin = findFfmpeg(pluginDir);
  try {
    const out = await run(bin, ['-version'], 20000);
    const first = out.split('\n').find((l) => l.startsWith('ffmpeg version')) || out.split('\n')[0];
    return { ok: true, bin, version: first.trim() };
  } catch (error) {
    return { ok: false, bin, error: String((error && error.message) || error).slice(0, 200) };
  }
}

/**
 * 把 N 段视频用真转场接起来，音轨换成整首歌，并裁到歌长。
 * @param clips        [{ file, duration }] 按顺序
 * @param transitions  每两个镜头之间的类型（长度 = clips.length - 1）
 * @param audioFile    整首歌
 * @param totalSeconds 成品时长（= 歌长）
 */
export async function stitchWithTransitions({ pluginDir, clips, transitions, audioFile, totalSeconds, outFile }) {
  if (!clips || clips.length === 0) throw new Error('没有可拼接的镜头');
  if (!audioFile) throw new Error('缺少音轨');
  const bin = findFfmpeg(pluginDir);
  const dir = path.dirname(outFile);
  await fsp.mkdir(dir, { recursive: true });

  const inputs = [];
  clips.forEach((c) => { inputs.push('-i', c.file); });
  inputs.push('-i', audioFile);

  const parts = [];
  const specs = clips.slice(0, -1).map((c, i) => {
    const type = String((transitions || [])[i] || 'cut');
    return XFADE[type] || XFADE.cut;
  });

  // 依次 xfade：offset 用「已累计时长 - 已重叠时长」推
  let acc = Number(clips[0].duration) || 10;
  let overlapTotal = 0;
  let lastLabel = '[0:v]';
  for (let i = 1; i < clips.length; i += 1) {
    const spec = specs[i - 1];
    const overlap = Math.min(spec.duration, (Number(clips[i].duration) || 10) / 2);
    overlapTotal += overlap;
    const offset = Math.max(0, acc - overlap);
    const label = i === clips.length - 1 ? '[vx]' : `[v${i}]`;
    parts.push(`${lastLabel}[${i}:v]xfade=transition=${spec.name}:duration=${overlap.toFixed(3)}:offset=${offset.toFixed(3)}${label}`);
    acc = offset + (Number(clips[i].duration) || 10);
    lastLabel = label;
  }
  // 只有一个镜头时不需要 xfade
  if (parts.length === 0) parts.push('[0:v]copy[vx]');

  // xfade 会让总时长缩短一个 overlap，不补偿的话画面会比歌短、尾巴没画面。
  // 补一段末帧延展，最后用 -t 裁回歌长。
  const pad = Math.max(1, overlapTotal + 0.6);
  parts.push(`[vx]tpad=stop_mode=clone:stop_duration=${pad.toFixed(2)}[vout]`);

  const audioIndex = clips.length;
  const args = [
    '-y', ...inputs,
    '-filter_complex', parts.join(';'),
    '-map', '[vout]', '-map', `${audioIndex}:a`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    ...(Number(totalSeconds) > 0.5 ? ['-t', Number(totalSeconds).toFixed(2)] : []),
    '-movflags', '+faststart',
    outFile,
  ];

  const stderr = await run(bin, args);
  const stat = await fsp.stat(outFile).catch(() => null);
  if (!stat || stat.size === 0) throw new Error('ffmpeg 没有产出文件：' + stderr.slice(-400));
  return { file: outFile, bytes: stat.size, bin };
}
