# dsh-comfyui-txt2music

文生音乐：YuE2 3B。用一段曲风描述 + 一份带段落标记的歌词，生成一首歌。

## 面板

侧栏「文生音乐」。

| 字段 | 说明 |
| --- | --- |
| 曲风描述 | 流派、乐器、人声、情绪、制作质感；支持 ✨ AI 润化 |
| 歌词 | 用 `[Verse]` / `[Chorus]` 分段，一行一句 |
| 最长时长 | 秒；长曲目耗时线性上升 |
| 先写曲式 | 打开时先由 `YuE2GenerateABC` 写出曲式，再合成音频；关掉更快但结构弱 |
| 模式 | `full`=旋律+和弦；`melody`=仅旋律（做翻唱用） |
| 格式 / 码率 | flac 无码率；mp3 支持 V0/128k/320k；opus 支持 64k–320k |

## 工具

| 工具 | 说明 |
| --- | --- |
| `txt2music_generate` | 提交生成任务；`background: true` 立刻返回任务 id |
| `txt2music_status` | 查任务状态 / 列最近任务 |

## 工作流

`workflows/yue2_text2music.api.json`（16 节点）：

```
33:36 style ┐
33:37 lyrics┴→ YuE2GenerateABC ─(33:30 switch)→ YuE2GenerateMusic → KSampler → VAEDecodeAudio → SaveAudioAdvanced
```

- 检查点：`yue2_3b_int8_convrot.safetensors`（唯一的一个）
- `33:31` 是「先写曲式」的开关，对应 `PrimitiveBoolean`
- 输出读 `outputs['10'].audio[0]`，文件落在 ComfyUI 的 `output/audio/`

## 注意

- 显存不足时先缩「最长时长」和「步数」
- 音频路由支持 Range，浏览器里可以拖动进度条
