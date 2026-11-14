# dsh-comfyui-pixal3d

四视图转 3D：一张转盘图（前 / 左 / 后 / 右）→ Pixal3D 多视图条件 → Trellis2 形状与贴图 → **GLB**。

## 面板

侧栏「3D 生成」。

| 字段 | 说明 |
| --- | --- |
| 四视图转盘图 | 一张横图，四格依次是前 / 左 / 后 / 右；可上传或从 output 选 |
| 切分方式 | `按宽度四等分`（按图片实际宽度平均切）／`模板坐标`（工作流里写死的四段坐标） |
| 形状步数 | 默认 20（节点 18） |
| 贴图步数 | 默认 12（节点 12） |
| 上采样 | 默认 1536（节点 94） |
| 重网格 | 默认 768（节点 241） |
| 贴图尺寸 | 默认 4096（节点 288） |
| 阈值 | 体素转网格阈值，默认 0.6（节点 4） |
| 种子 | 四个采样器共用；留空随机 |

模型行会自动列出这套流程用到的五个模型（pixal3d unet、dino clip_vision、trellis shape/texture 两个 vae、birefnet 抠图），可直接换。

## 工具

| 工具 | 说明 |
| --- | --- |
| `p3d_generate` | `image` + 参数；`background: true` 立即返回任务 id |
| `p3d_status` | 查任务状态 |

## 工作流要点

- 65 个节点，产物在 `outputs['372']['3d'][0]`（`Save3DAdvanced`）
- 四视图裁剪节点：`338` 前、`341` 左、`342` 后、`345` 右
- 走 `Trellis2ShapeStage` → `VaeDecodeShapeTrellis` → 网格清理 → `BakeTextureFromVoxel` → `ApplyTextureToMesh` → `MeshToFile3D`
- 耗时通常 2–8 分钟；显存吃紧时先降上采样和重网格

## 注意

- 转盘图四格必须顺序正确，否则生成的是"错位的模型"
- 等分模式假设四格等宽；若你的图四格不等宽，改用模板坐标或自己裁成等宽
