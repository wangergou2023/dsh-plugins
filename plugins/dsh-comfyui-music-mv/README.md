# dsh-comfyui-music-mv

音乐 MV 生成插件：一个主题进，一支带原曲的 mp4 出。

![面板](docs/panel.png)

> 步骤条 + 时间轴带 + 分镜卡片。每镜可以单独重 roll 静帧、单独看片、展开改景别/运镜/灯光/景深。

![分镜](docs/storyboard.png)

> 六镜静帧：同一角色贯穿全片，景别按情绪推进变化。

## 流程（分镜先行）

```
主题
 ├─ 剧本     宿主 LLM          logline / 情绪曲线 / 结尾 / 导演阐述 / 主角外形 / 歌词 / 曲风
 ├─ 分镜     宿主 LLM          每镜 12 个结构化字段（场景 时间 景别 机位 俯仰 运镜 灯光 景深 转场 动作 对位歌词 情绪）
 ├─ 出歌     YuE2 3B          → flac（读 STREAMINFO 得精确总长）
 ├─ 定妆图   Krea2 Turbo      → 1 张主角图，全片复用，锁人物身份
 ├─ 静帧     Krea2 Turbo      → 每镜一张电影剧照【可单镜重 roll、可改参数、有版本历史】
 ├─ 视频     MiniMax H3       → 首帧=静帧，身份=定妆图，歌声=<Audio 1> 切片（对口型）
 │                              下一镜可用上一镜末帧当首帧（末帧接龙）
 └─ 合成     ConcatenateVideo → 接成整支 + 压上原曲 + 按歌长裁齐
```

**为什么先出静帧**：直接文生视频等于六次独立抽卡，人物、场景、构图都不可控，错了只能整镜重跑。
先出图把画面定死，再图生视频，成本从"每镜 5–10 分钟"降到"每镜 40 秒可审"，而且首帧就是你要的那张。

**为什么要末帧接龙**：H3 单段上限 15 秒，一支 MV 必然是 N 段拼。
把上一段最后一帧抽出来（`LoadVideo → Video Slice → GetVideoComponents → SaveImage`，不需要 ffmpeg），
当下一段的首帧，切点两侧是同一张画面，观感上就是连续的。

## 结构化镜头语言

`lib/shotlang.js` 把"景别 / 俯仰 / 机位 / 运镜 / 灯光 / 景深 / 转场"变成枚举 + 英文片段，
提示词由字段拼出来，而不是一段自由文本：

```
medium shot, waist-up to full body · eye-level shot · shooting from the front ·
slow push-in dolly · dramatic side lighting · shallow depth of field
```

灵感来自 LocalMiniDrama 的 `angleService`（8 方向 × 4 俯仰 × 3 景别）与「专业分镜」弹窗。
小模型对这类短语的反应，比"很感人的特写"稳定得多。

## 面板用法

1. 写主题 → 调歌长/像素/比例 → **🎬 生成剧本**
2. 改剧本、歌词、主角，展开任一镜头可改参数
3. **① 出歌 + 定妆 + 静帧** → 停下等人审
4. 不满意的镜头点 **🔄 换一张**（只重出这一张图，几十秒）
5. **② 出视频 + 合成** → 末帧接龙逐镜出片并拼成成品
6. 也可 **一键到底**

## 工具

| 工具 | 作用 |
|---|---|
| `mv_plan` | 主题 → 剧本 + 歌词 + 分镜表（只调宿主 LLM，不占 GPU） |
| `mv_render` | 后台任务；`phase=all/frames/videos`、`tailLink` 控制是否接龙 |
| `mv_status` | 查进度：阶段、每镜静帧/视频状态、成品路径 |
| `mv_stitch` | 只拼接：N 段视频 + 1 条音轨 → mp4（`trimSeconds` 裁到歌长） |

## 对口型

有台词的镜头会把整首歌按该镜的时间区间切一段，当 `<Audio 1>` 喂给 H3：

```
LoadAudio(整首) → TrimAudioDuration(start_index, duration) → SaveAudioAdvanced(flac)
```

提示词里写「严格按 <Audio 1> 的歌声对口型，唱的是『那句歌词』」。
成品音轨仍然用整首歌压一次，所以切片再准也不会把多段人声拼错。

## 转场（可选 ffmpeg）

分镜表里每镜的 `transition` 字段现在会真的执行：`cut / dissolve / fade / whip / match`。
执行它需要 ffmpeg，插件按下面的顺序找，找到就启用、找不到就退回硬切（不报错）：

```
$DSH_MV_FFMPEG   →   <插件>/.data/bin/ffmpeg.exe
                 →   ~/Documents/LocalMiniDrama/backend-node/tools/ffmpeg/ffmpeg.exe
                 →   PATH
```

拼接命令是 `xfade` 链：

```
[0:v][1:v]xfade=transition=fade:duration=0.6:offset=9.53[v1]
[v1][2:v]xfade=transition=fadeblack:duration=0.8:offset=18.85[v2] ...
[vx]tpad=stop_mode=clone:stop_duration=2.76[vout]   ← 补回被 overlap 吃掉的时长
-map [vout] -map N:a -c:v libx264 -crf 20 -c:a aac -t <歌长>
```

xfade 每接一次就少一个 overlap，所以必须用 `tpad` 补回、再用 `-t` 裁齐，
否则会出现「画面 58.6 秒、声音 60 秒」的尾巴没画面。

没有 ffmpeg 时走 ComfyUI 的 `ConcatenateVideo`，硬切 + 原曲，同样按歌长裁齐。

## 已知限制

- 对口型只保证"嘴型跟着这段歌声走"，不能保证逐字精确。
- 单镜 5–15 秒；60 秒约 6–8 镜，16 GB 显存整支可能一小时。
- 转场依赖 ffmpeg；没有它时 `transition` 字段只入库，段间一律硬切。
- 只支持 flac / mp3 读时长（flac 精确，mp3 按首帧比特率估算）。
- 全片必须同一比例/像素，否则转场/拼接会失败或重编码。
