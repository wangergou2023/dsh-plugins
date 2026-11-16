/**
 * 电影质感后处理（可选，需要 ffmpeg）。
 *
 * 出片之后再过一遍：
 *   调色（对比/饱和/黑位）→ 轻暗角 → 微锐化 → 胶片颗粒 →（可选）2.35:1 遮幅 → 片名压字
 * 一次 re-encode 搞定，音轨直接 copy 不重压。
 *
 * 为什么用 -filter_script：滤镜串里有中文、冒号、反斜杠，直接拼 args 在 Windows 上
 * 会被 shell/ffmpeg 的转义规则吃掉；写进文件最稳。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findFfmpeg } from './ffmpeg.js';

const FONT_CANDIDATES = [
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/msyhbd.ttc',
  'C:/Windows/Fonts/simhei.ttf',
];

async function firstExisting(list) {
  for (const p of list) {
    try { await fs.access(p); return p; } catch { /* next */ }
  }
  return null;
}

/** drawtext 的 text 需要把特殊字符转义掉，否则整条滤镜都坏。 */
function escapeDrawText(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\\\'")
    .replace(/%/g, '\\%')
    .replace(/\n/g, ' ');
}

function run(bin, args, timeoutMs = 900000) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let log = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
    child.stdout.on('data', (d) => { log += String(d); if (log.length > 20000) log = log.slice(-8000); });
    child.stderr.on('data', (d) => { log += String(d); if (log.length > 40000) log = log.slice(-16000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(log);
      else reject(new Error('ffmpeg 后处理失败(' + code + ')：' + log.slice(-700)));
    });
  });
}

/**
 * @param input     成片 mp4
 * @param output    输出 mp4
 * @param title     片名（可选，压在前 3 秒）
 * @param subtitle  副标题（可选，片名下面一行小字）
 * @param crop      是否做 2.35:1 遮幅
 * @param grade     是否调色
 * @param grain     是否加胶片颗粒
 */
export async function cinematicPass({ pluginDir, input, output, title, subtitle, crop = true, grade = true, grain = true, timeoutMs }) {
  const bin = findFfmpeg(pluginDir);
  const filters = [];

  // 2.35:1 遮幅：裁掉上下，不做加黑边（播放器自己会加）
  if (crop) filters.push('crop=iw:min(ih\\,iw/2.35):0:(ih-min(ih\\,iw/2.35))/2');

  if (grade) {
    filters.push('eq=contrast=1.07:brightness=-0.015:saturation=1.08:gamma=0.98');
    filters.push('curves=preset=medium_contrast');
  }
  filters.push('vignette=angle=PI/5');           // 轻暗角，聚拢视线
  filters.push('unsharp=5:5:0.55:5:5:0.0');      // 轻微锐化，压住转码的糊
  if (grain) filters.push('noise=alls=5:allf=t'); // 胶片颗粒，弱一点

  // 片名：前 3.2 秒淡入淡出，落在画面左下
  const font = await firstExisting(FONT_CANDIDATES);
  if (title && font) {
    const t = escapeDrawText(title);
    const fade = "if(lt(t,0.5),t/0.5,if(gt(t,2.7),(3.2-t)/0.5,1))";
    filters.push(
      `drawtext=fontfile='${font}':text='${t}':fontcolor=white@0.92:fontsize=h/11:`
      + `x=w*0.055:y=h*0.74:shadowcolor=black@0.55:shadowx=2:shadowy=2:`
      + `alpha='${fade}':enable='lt(t,3.2)'`,
    );
    if (subtitle) {
      const s = escapeDrawText(subtitle);
      filters.push(
        `drawtext=fontfile='${font}':text='${s}':fontcolor=white@0.72:fontsize=h/26:`
        + `x=w*0.058:y=h*0.74+h/11+8:alpha='${fade}':enable='lt(t,3.2)'`,
      );
    }
  }

  const script = path.join(path.dirname(output), 'grade-' + Date.now().toString(36) + '.txt');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(script, filters.join(',\n'), 'utf8');

  const args = [
    '-y', '-i', input,
    '-filter_script:v', script,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy',
    '-movflags', '+faststart',
    output,
  ];
  try {
    await run(bin, args, timeoutMs);
  } finally {
    await fs.unlink(script).catch(() => {});
  }
  const stat = await fs.stat(output).catch(() => null);
  if (!stat || stat.size === 0) throw new Error('后处理没有产出文件');
  return { file: output, bytes: stat.size };
}
