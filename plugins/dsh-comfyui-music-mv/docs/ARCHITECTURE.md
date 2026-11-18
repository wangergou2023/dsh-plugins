# dsh-comfyui-music-mv · 代码地图

> 给下一次改这个插件的人（很可能还是我）看的。先说清"东西在哪、为什么这么排"，再说清"哪里还是烂的"。

## 一句话

主题进 → 剧本 + 歌词 + 分镜出 → 出歌 → 定妆 → 每镜静帧 → 末帧接龙出视频 → 拼接/转场/调色 → 一支 MV。

## 文件地图

| 文件 | 行数 | 职责 | 什么时候改它 |
|---|---|---|---|
| `index.js` | ~1834 | 插件入口：工具注册、HTTP 路由、后台任务流水线（run 编排、出歌/定妆/静帧/视频/合成） | 加工具/路由、改任务流程 |
| `lib/prompts.js` | ~236 | 所有 LLM 提示词：planSystemPrompt、planScriptPrompt、shotsPrompt、DENSITY_EXAMPLE、REVIEW/COMPARE/REWRITE/WARM/FOCUS_SYSTEM | 改提示词、调 few-shot |
| `lib/repairs.js` | ~275 | 基于 LLM 的自动返修：repairBookend、relieveSilence、reviewPlan、comparePlans(Fair)、rewriteShots、addWarmBeat、focusSignShot | 改返修策略 |
| `lib/llm.js` | ~68 | 宿主 LLM 适配：rich messages、取文本、错误转人话 | 改模型调用 |
| `lib/jobs.js` | ~81 | JobStore：任务持久化、reapOrphans、按 id 读写 | 改任务存储 |
| `lib/mv.js` | ~1640 | 剧本数据模型：normalizePlan、体检 lintPlan、各种自动返修、画面提示词 composeFramePrompt | 改剧本结构、加体检项、改画面提示词 |
| `client.js` | ~960 | 面板（React 无 JSX，`h()` 手搓）：表单、剧本卡、任务卡、导演本/分镜板按钮 | 改 UI/交互 |
| `lib/shotlang.js` | ~105 | 景别/机位/运镜/灯光的中英词表（`vocab()` 给面板下拉用） | 加镜头语言词 |
| `lib/comfy.js` | ~100 | ComfyUI 客户端：排队、等 history、取产物 | 改底层调用 |
| `lib/ref2v.js` | ~280 | H3 参考生视频的图构造与产物拉取 | 改视频段 |
| `lib/refedit.js` | ~117 | 参考图生图（Qwen-Image-Edit）：定妆图怎么喂、形态护栏、抗融合 | 改"认人"逻辑 |
| `lib/t2i.js` | ~196 | Krea2 文生图：定妆图、静帧的回退路径 | 改文生图 |
| `lib/music.js` | ~220 | YuE2 出歌 | 改歌 |
| `lib/ffmpeg.js` | ~150 | 拼接、转场、音频拼接、过渡形态拼接 | 改后处理 |
| `lib/grade.js` | ~120 | 电影质感：2.35 遮幅、调色、颗粒、片名 | 改调色 |
| `lib/board.js` | ~99 | 分镜板 PNG（ffmpeg 拼图，中文走 textfile=） | 改板子版式 |
| `lib/book.js` | ~274 | 导演本 HTML（A4 打印、图片 base64、缩略图缓存） | 改本子 |
| `lib/models.js` | ~75 | 扫模型、套模型覆盖 | 换模型 |

## 数据流

```
主题
 └─ POST /plan-async → planTasks{taskId}（服务端后台跑 LLM，30 分钟 TTL）
      └─ GET /plan-task?id= → { status, plan, lint }
           └─ 前端轮询 → 剧本卡（scenes + shots + twist + props + lint）

POST /run { plan, 参数 }
 └─ JobStore 建任务（.data/mv-jobs.json）
      ├─ song    : YuE2 分段生成 → concatAudio（acrossfade）→ song_full.flac
      │             长度不足 95% 时补一段
      ├─ hero    : 每个角色按 heroFormSpecs 出 本体/人形/过渡 三张
      ├─ frames  : 每镜 composeFramePrompt → 参考图生图（认人）→ frame_NN.png
      ├─ videos  : 每镜 H3（首帧=静帧，末帧接龙=上一镜末帧，<Audio N>=歌词切片）
      └─ stitch  : 拼接 → 转场 → 调色 → 成片 mp4
```

任务状态：`queued → running → paused（静帧就绪，等审）→ running（视频）→ done/failed/interrupted`。
插件重载会把 running 判成 `interrupted`（`JobStore.reapOrphans`），续跑用 `POST /continue`。

## 提示词都在哪（改剧本质量先看这里）

`index.js`：

| 名字 | 作用 |
|---|---|
| `planSystemPrompt(duration)` | 写剧本的主提示词：结构规则 A–L、J（twist 要动作级）、K（中段必须有放松）、L（logline 不剧透）、规则 22–24（props 三次、label 不重复、母题三段不同场面） |
| `planScriptPrompt(duration)` | 长片两阶段的第一阶段：只要剧本骨架（场次体 + props + twist），不写 shots |
| `shotsPrompt(count, from, to, part, total)` | 第二阶段：分批写 21 镜分镜，带"这是第 N/M 段 + 已拍镜头清单"防重复 |
| `DENSITY_EXAMPLE` | 手写的一镜 few-shot（正面 JSON + 三句反例）。**这是把"我写的本子"塞进提示词的方式** |
| `REVIEW_SYSTEM` / `rewriteShots` | 逐镜体检（谁/要什么/被什么挡住/表演是否落到身体） |
| `FOCUS_SYSTEM` / `focusSignShot` | 只改揭示镜，让它只拍 `twist.sign` 那一样东西 |

## 剧本返修链（顺序有讲究，别乱调）

`index.js` 里两处（≤10 镜 / 长片分批）都走这条链：

```
assignPropSlots → repairBookend → focusSignShot → forceSignShot
→ ensureOtsPair → enforceReversePair → trimLongActions → mergeScenes
→ cleanLogline → dedupePerformance → dedupeLabels → linkWarmProp
→ fixSizeRuns → lintPlan
```

顺序的理由：

- `assignPropSlots` 先占位，否则后面 `repairBookend` 改末镜时物件又缺了；
- `trimLongActions` 必须在 `repairBookend` **之后**——末镜返修会把句子重新写长；
- `fixSizeRuns` 放最后，景别三连是结构问题，前面的改写可能又造出三连。

## 体检 28 项（`lintPlan`）

结构：`complete`（每镜有表演/目标）、`perf-dup`、`body`（表演落到身体）、`size-run`、`move-run`、
`props`、`props-arc`（每件物件三次：建立→回声→兑现）、`bookend`（末镜回到开场物件）、
`lyric-offset`（唱词不复述画面）、`lyric-dup`（同一句最多两格）、`action-len`（12–90 字）、
`empty-shot`（≤2 个空镜）、`timeline`（无断裂）、`silence`（有一镜不说话 ≥8 秒）、
`rhythm`（长短比 ≥1.5）、`turn`（揭示在 50%–90%）、`contrast`（18%–68% 有一处真的放松）、
`twist-sign`（揭示有物理信号）、`sign-focus`（揭示镜咬合信号 ≥34%）、`warm-link`（笑时手里拿着揭示物）、
`scenes-count`（4–12 场）、`logline-clean`（logline 不剧透）、`lyrics`（≥4 行）、
`forms`（本体/人形交替、不许三连）、`composition`（有双人对话就要有过肩）、
`reverse`（成对的过肩镜必须同场景、焦点互换）、`labels`（标题不重复）、`prop-motif`（母题不在同一场面重复）。

**满分不等于好**：只跑体检会写出"评分全过、句子在描述第三只手"的本子。拉满分之后必须逐镜读一遍。

## HTTP 路由

| 路由 | 方法 | 作用 |
|---|---|---|
| `/meta` | GET | ComfyUI 版本、VRAM、ffmpeg、词表 |
| `/plan-async` → `/plan-task` | POST/GET | 异步写剧本（面板用这个） |
| `/plan` | POST | 同步写剧本（脚本/工具用） |
| `/polish-shots` `/review` `/compare` | POST | 返修、逐镜体检、两版换位对打 |
| `/run` `/continue` `/frame` `/shot` `/stitch` | POST | 起任务、续跑、重出单帧、改单镜参数、重新合成 |
| `/heroes` | POST | 只重出定妆 |
| `/job` `/jobs` | GET | 任务详情 / 最近任务 |
| `/book` `/board` | GET | 导演本 HTML / 分镜板 PNG（`?download=1`） |
| `/media` `/song` `/clip` `/frame-img` `/hero-img` | GET | 媒体流（支持 Range） |
| `/export` `/import` `/upload` | POST | 方案导入导出、上传图片 |

## 工具

`mv_script`（只出本子，零 GPU）、`mv_render`、`mv_status`、`mv_stitch`、`mv_board`、`mv_compare`、`mv_book`、`mv_plan`。

## 前端状态与 localStorage

| key | 内容 | 谁写 |
|---|---|---|
| `comfyui-music-mv.form.v2` | 表单 + 剧本（重挂载后恢复） | 每次 cfg/plan 变化 |
| `comfyui-music-mv.planrun.v2` | 正在跑的写剧本 taskId | 点「生成剧本」 |
| `comfyui-music-mv.job.v1` | 面板上正在看哪个任务 | 起任务/点历史/新建时清除 |

**任务自动恢复**只认这个指针（或正在跑的任务），不再"自动挂最近那个"——否则点完新建，下面又冒出上一个任务。

## 已知技术债

1. `index.js` 2480 行太长：提示词、返修、路由、JobStore 混在一个文件。下次动它应该拆成 `lib/prompts.js` / `lib/repairs.js` / `lib/jobs.js`。
2. 体检 28 项里有一部分是"能过但没意义"的底线项（如 `empty-shot`），真正的质量判据只有 `body`/`turn`/`sign-focus`/`warm-link` 这几项。
3. 面板没有分镜编辑（改动作/表演要导出 json 改），只有单帧重出和参数编辑。
4. `lib/t2i.js` / `lib/ref2v.js` / `lib/music.js` 是从别的插件抄过来的分支副本，和原插件有重复代码，改 ComfyUI 节点时两边都要改。
5. videos 阶段只在 2 镜 20 秒上验证过，21 镜整片没跑过。
