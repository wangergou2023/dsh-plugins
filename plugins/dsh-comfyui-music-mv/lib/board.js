/**
 * 分镜板（PNG）：把一部片子的静帧拼成一张带镜号/时间码/景别/动作的图。
 *
 * 不引第三方图形库：用 ffmpeg 的 pad + drawtext + xstack 拼，
 * 中文靠 textfile= 喂 UTF-8 临时文件（直接把中文写进滤镜串会被转义吃掉）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { findFfmpeg } from './ffmpeg.js';

const SIZE_CN = {
  extreme_wide: '大远景',
  wide: '全景',
  full: '全景',
  medium: '中景',
  close: '近景',
  extreme_close: '大特写',
};

function run(exe, args, timeoutMs = 240000) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error('分镜板渲染超时'));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`ffmpeg 退出 ${code}：${err.split('\n').filter(Boolean).slice(-3).join(' | ')}`));
    });
  });
}

/** 中文路径在 drawtext / textfile 里要写成 C:/x/y.txt 并转义冒号。 */
function filterPath(p) {
  return String(p).replace(/\\/g, '/').replace(/:/g, '\\:');
}

function captionOf(shot) {
  const secs = (Number(shot.end) - Number(shot.start)).toFixed(1);
  const no = String((Number(shot.index) || 0) + 1).padStart(2, '0');
  const size = SIZE_CN[shot.size] || shot.size || '';
  const label = String(shot.label || '').slice(0, 18);
  const prop = shot.prop ? ` · ${shot.prop}` : '';
  return `${no}  ${secs}s  ${size}${prop}  ${label}`;
}

/**
 * 拼分镜板。files 与 shots 一一对应。
 * @returns {Promise<string>} 输出文件路径
 */
export async function buildBoard({
  pluginDir,
  files = [],
  shots = [],
  outFile,
  cols = 3,
  width = 640,
  title = '',
} = {}) {
  const exe = findFfmpeg(pluginDir);
  if (!exe) throw new Error('找不到 ffmpeg，分镜板需要它来拼图');
  const usable = files.map((f, i) => ({ f, s: shots[i] || {} })).filter((x) => x.f);
  if (!usable.length) throw new Error('没有可用的静帧');

  const tmpDir = path.join(path.dirname(outFile), '.board-tmp');
  await fs.mkdir(tmpDir, { recursive: true });

  const cellW = width;
  const cellH = Math.round((cellW * 9) / 16) + 42; // 16:9 画面 + 一行字幕
  const args = [];
  for (const x of usable) args.push('-i', x.f);

  const parts = [];
  const layoutParts = [];
  const colCount = Math.max(1, Math.min(cols, usable.length));
  for (let i = 0; i < usable.length; i += 1) {
    const capFile = path.join(tmpDir, `cap-${i}.txt`);
    await fs.writeFile(capFile, captionOf(usable[i].s), 'utf8');
    parts.push(
      `[${i}:v]scale=${cellW}:${cellW * 9 / 16}:force_original_aspect_ratio=decrease,`
      + `pad=${cellW}:${cellW * 9 / 16}:(ow-iw)/2:(oh-ih)/2:color=0x0e1013,`
      + `pad=${cellW}:${cellH}:0:0:color=0x16191d,`
      + `drawtext=fontfile='C\\:/Windows/Fonts/msyh.ttc':textfile='${filterPath(capFile)}':`
      + `x=10:y=${cellW * 9 / 16 + 11}:fontsize=20:fontcolor=0xd6d2c8[v${i}]`,
    );
    const col = i % colCount;
    const row = Math.floor(i / colCount);
    layoutParts.push(`${col * cellW}_${row * cellH}`);
  }
  const layout = layoutParts.join('|');
  parts.push(`${usable.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${usable.length}:layout=${layout}:fill=0x0e1013[out]`);

  const filterFile = path.join(tmpDir, 'board.filter');
  await fs.writeFile(filterFile, parts.join(';\n'), 'utf8');

  args.push(
    '-filter_complex_script', filterFile,
    '-map', '[out]',
    '-frames:v', '1',
    '-y', outFile,
  );
  await run(exe, args);
  return outFile;
}

export { captionOf };
