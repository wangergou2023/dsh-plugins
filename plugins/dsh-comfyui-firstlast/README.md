# dsh-comfyui-firstlast

首帧 + 尾帧 → 中间过程。用 MiniMax H3 的 **i2v（first/last frame）** 把两张静帧之间的动作补出来。

- 工作流来自 `video_minimax_h3_i2v.json`（27 节点，`MiniMaxH3ImageToVideo` 的 `first_frame` / `last_frame` 两个可选输入）
- 只给首帧也能跑（单图 i2v）；给了尾帧，模型会把动作收束到那张图上

## 工具

| 工具 | 说明 |
| --- | --- |
| `firstlast_generate` | 首帧（必填）+ 尾帧（可选）+ 一句过程描述 → mp4 |
| `firstlast_status` | 查进度 / 列最近任务 |

两张图都可以传**本机绝对路径**（插件会自动上传到 ComfyUI input），也可以直接传 ComfyUI input 里的文件名。

```
firstlast_generate(
  prompt="他把伞收拢，抬手抹掉玻璃上的水汽；雨渐小",
  firstFrame="C:\\path\\a.png",
  lastFrame="C:\\path\\b.png",
  durationSeconds=5,
  aspectRatio="16:9 (Widescreen)",
  megapixels=0.4,
  background=true,
)
```

## 面板

侧边栏「首尾帧视频」：两个图槽（点击上传、点图放大、× 移除）+ 提示词 + 比例 / 像素 / 时长 / 种子 / 闪电加速 + 生成 + 结果播放器 + 最近任务。
表单存 `localStorage`，切走再回来还在。

## 参数

- **时长**：2–15 秒。内部按 `17n + 5` 帧对齐（5s → 124 帧、6s → 141、15s → 362），所以实际时长会和输入值有几帧偏差。
- **像素**：0.2–1.0 MP。16GB 卡建议 0.3–0.4；正式片再往上抬。
- **闪电加速**：走 4 步 LoRA（`minimax_h3_dmad_full_dareties_v4_step600_comfy_fro`）；关掉是 20 步全量。
- **种子**：留空随机。同一对首尾帧 + 同一提示词 + 同一 seed 可复现。

## 显存

模型是 int8 量化、约 19.5GB，16GB 卡会走内存卸载：实测 4 秒 / 0.3MP 用 87 秒。任务开始时会检查显存，不足会在任务里挂一条 warning（不阻止运行）。

## 路由

```
GET  /api/comfyui-firstlast/meta          插件与 ComfyUI 状态
POST /api/comfyui-firstlast/run           提交任务 {prompt,firstFrame,lastFrame,...}
GET  /api/comfyui-firstlast/job?id=       单个任务
GET  /api/comfyui-firstlast/jobs?limit=   最近任务
POST /api/comfyui-firstlast/upload        multipart 上传图片
GET  /api/comfyui-firstlast/media?id=     成片（支持 Range）
GET  /api/comfyui-firstlast/frames?name=  input 里的图（面板缩略图用）
```

产物落在 `plugins/dsh-comfyui-firstlast/.data/videos/<jobId>.mp4`，任务表在 `.data/jobs.json`。
