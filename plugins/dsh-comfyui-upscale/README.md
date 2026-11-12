# dsh-comfyui-upscale

图片放大：SeedVR2 7B int8，单图进、放大图出。

## 面板

侧栏「图片放大」。选图（上传 / 从 output 选 / ↻）+ 倍数、分块、重叠、颜色校正、种子。

## 参数建议

| 场景 | 建议 |
| --- | --- |
| 常规 4× | 分块 512、重叠 128 |
| 显存不足 | 分块 256 |
| 4096² 出图 | 约 30 秒（RTX 4060 Ti） |

## 依赖模型

| 文件 | 目录 |
| --- | --- |
| `seedvr2_7b_int8_convrot.safetensors` | `models/diffusion_models/` |
| `seedvr2_ema_vae_fp16.safetensors` | `models/vae/` |

缺文件时 `/meta` 接口会返回 `missingModels`，面板顶部会直接提示。

## 工作流

`workflows/seedvr2_upscale_image.api.json`。分块参数会同时写到 `66:48` 与 `66:55` 两个节点。
