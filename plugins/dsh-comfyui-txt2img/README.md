# dsh-comfyui-txt2img

文生图：Krea2 Turbo，8 步、cfg 1，可选 LoRA 与风格后缀。

## 面板

侧栏「文生图」。提示词、LoRA、强度、张数、步数、种子；结果图点击可 1:1 查看。

## 两个「改写」不要混

| 按钮 | 谁在改 | 消耗 |
| --- | --- | --- |
| ✨ AI 润化 | 会话模型改提示词，输出 `[PROMPT]` + `[SUFFIX]` 两段 | 会话 token |
| AI 扩写 | ComfyUI 内部 `TextGenerate` 节点，本机执行 | 本机算力 |

扩写后的实际提示词会在结果上方显示，方便回看。

## 工具

| 工具 | 说明 |
| --- | --- |
| `t2i_generate` | 提交生成任务 |
| `t2i_status` | 查任务状态 |

## 工作流

`workflows/krea2_turbo_t2i.api.json`，LoRA 与后缀是两个独立开关（`30:23` / `800`）。
