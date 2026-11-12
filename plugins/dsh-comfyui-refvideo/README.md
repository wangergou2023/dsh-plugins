# dsh-comfyui-refvideo

参考生视频：把参考图（最多 9 张）、参考视频（3 段）、参考音频（3 段）喂给 MiniMax H3 的 ref2va 工作流，生成一段短视频。

## 面板

侧栏「参考生视频」。三排素材位都是「＋ 上传 / 从 output 选 / ↻」；卡片只展示与删除。
提示词里用 `<Picture N>` / `<Video N>` / `<Audio N>` 按顺序指代素材，N 从 1 开始。

## 工具

| 工具 | 说明 |
| --- | --- |
| `ref2v_generate` | 提交生成任务；`background: true` 立刻返回任务 id |
| `ref2v_status` | 查任务状态 / 列最近任务 |
| `ref2v_llm_probe` | 诊断宿主模型服务是否可用 |

## 参数（面板）

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| 时长 | 5 s | 5–15 秒 |
| 像素 | 0.4 MP | 越大越慢、越吃显存 |
| 步数 | 4 | 配合 lightning LoRA |
| 种子 | 随机 | 空 = 随机 |

## 限制

- 模型约 22 GB，16 GB 显存会走内存卸载，一次几分钟属正常
- 提示词必须带标签，否则素材不会被引用（润化会自动补 `<Picture N>`）
- AI 润化会读取参考图（最多 6 张），并检查标签覆盖是否齐全

## 工作流

`workflows/minimax_h3_ref2va.api.json` + `minimax_h3_ref2va.slots.json`。换模型只改模板，不用改代码。
