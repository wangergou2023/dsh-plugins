# dsh-plugins

我的 **DeepSeek Harness** 插件合集：自己写的插件放在 `plugins/`，日常在用的其他人的插件整理在下面的清单里。

> DeepSeek Harness（命令 `dsh`）的插件是 Cordis 插件包，通过 npm 分发，用 `dsh plugin --profile <profile> add <包名>` 装进某个 profile。官方明确处于 developer preview，会有破坏性变更，装之前留意插件的 `engines.dsh` / 兼容性声明。

[![plugins](https://img.shields.io/badge/自研插件-plugins%2F-3b82f6?style=flat-square)](#自研插件)
[![verified](https://img.shields.io/badge/第三方清单-逐个核对 npm-10b981?style=flat-square)](#常用插件清单)
[![license](https://img.shields.io/badge/license-MIT-64748b?style=flat-square)](LICENSE)

---

## 目录

- [自研插件](#自研插件)
- [常用插件清单](#常用插件清单)
- [找更多插件](#找更多插件)
- [怎么装](#怎么装)
- [仓库结构](#仓库结构)
- [写一个插件](#写一个插件)
- [收录规则](#收录规则)

---

## 自研插件

| 插件 | 状态 | 说明 |
| --- | --- | --- |
| _暂无_ | — | 第一个插件整理中，起步见 [`templates/minimal-host-plugin`](templates/minimal-host-plugin) |

自研插件按 `plugins/<name>/` 组织，每个目录是一个可以直接 `dsh plugin add` 的独立包：

```
plugins/<name>/
├── package.json          # dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml      # 往 profile loader 插入插件行
├── index.js              # 主机侧：apply(ctx, config)
├── client.js             # 可选，浏览器侧 UI
├── locale/{en,zh}.json   # meta.title / meta.description
├── icon.svg              # 插件图标
└── README.md             # 这个插件怎么用
```

---

## 常用插件清单

下面每个包都在 npm 上拉过元数据，确认 `dsh.bundle.patch` 存在、`repository` 指向可访问仓库。按用途分组，装之前仍建议看一眼对应仓库的 README 和兼容性说明。

### 界面与侧栏

| 插件 | 说明 | 作者 / 仓库 |
| --- | --- | --- |
| [`dsh-context`](https://www.npmjs.com/package/dsh-context) | 上下文洞察：Context 面板、浏览器、侧栏、`/context` 命令，看上下文组成与演进 | [bowenliang123](https://github.com/bowenliang123/dsh-context) |
| [`dsh-better-sidebar`](https://www.npmjs.com/package/dsh-better-sidebar) | 侧栏底座：文件树、编辑器、变更、任务、侧聊集中在一列，并向其他插件开放注册 Tab / 文件查看器 | [omdsh-dev](https://github.com/omdsh-dev/DSH-better-sidebar) |
| [`dsh-meme`](https://www.npmjs.com/package/dsh-meme) | 输入框一键发图、斗图；多图库、情绪与关键词搜图、AI 学图 | [yyh-001](https://github.com/yyh-001/dsh-meme) |
| [`dsh-notify-me`](https://www.npmjs.com/package/dsh-notify-me) | 离开页面也能收到提醒：需要你操作、后台回复完成时发系统通知 | [chromoany](https://github.com/chromoany/dsh-notify-me) |
| [`dsh-plugin-wallpaper-engine`](https://www.npmjs.com/package/dsh-plugin-wallpaper-engine) | 把本机 Wallpaper Engine 壁纸渲染到 Web UI 背后（WebGL / 视频 / 液态玻璃） | [elysia395](https://github.com/elysia395/dsh-wallpaper-engine) |
| [`dsh-pet`](https://www.npmjs.com/package/dsh-pet) | 桌面上的蓝色大肥鱼：会溜达、会被拖走、顺手帮你盯余额 | [PC2005-cloud](https://github.com/PC2005-cloud/dsh-pet) |
| [`dsh-chat-manager`](https://www.npmjs.com/package/dsh-chat-manager) | 会话与聊天记录管理：搜索归档、恢复对话、安全删除 | [WSL043](https://github.com/WSL043/dsh-chat-manager) |
| [`dsh-where-did-my-tokens-go`](https://www.npmjs.com/package/dsh-where-did-my-tokens-go) | 深度思考指示器旁实时显示 token 计数 | [RevxZxCx](https://github.com/RevxZxCx/dsh-where-did-my-tokens-go) |

### 图像、文档与视觉

| 插件 | 说明 | 作者 / 仓库 |
| --- | --- | --- |
| [`dsh-image-gen`](https://www.npmjs.com/package/dsh-image-gen) | 对话内生成 / 编辑 / 对比图像，500+ 提示词、图库、多模型、ComfyUI | [shanliuling](https://github.com/shanliuling/dsh-image-gen) |
| [`dsh-ppt`](https://www.npmjs.com/package/dsh-ppt) | 给材料，直接出可交付的演示文稿 | [STARDUSTLC666](https://github.com/STARDUSTLC666/dsh-ppt) |
| [`dsh-univer-office`](https://www.npmjs.com/package/dsh-univer-office) | Univer 表格 / 文档 / 幻灯片预览与协作 Gateway（包体较大） | [dream-num](https://github.com/dream-num/dsh-univer-office) |
| [`dsh-design`](https://www.npmjs.com/package/dsh-design) | 设计审查：`design_audit` 实测字号层级、WCAG 对比度、间距网格、配色漂移 | [Viger1](https://github.com/Viger1/dsh-design) |
| [`@liustack/modlens`](https://www.npmjs.com/package/@liustack/modlens) | 给纯文本模型外挂视觉：贴图返回结构化证据（OCR / 版面 / 语义） | [liustack](https://github.com/liustack/modlens) |
| [`@anionex/dsh-vision-toolkit`](https://www.npmjs.com/package/@anionex/dsh-vision-toolkit) | 视觉工具箱：图片问答、长截图 OCR、UI 还原、grounding、像素 diff | [Anionex](https://github.com/Anionex/dsh-vision-toolkit) |
| [`dsh-media-desk`](https://www.npmjs.com/package/dsh-media-desk) | 一句话记灵感、一键出稿：口播脚本、标题、封面、配图、分镜 | [woniuniuniu](https://github.com/woniuniuniu/dsh-media-desk) |

### 搜索、抓取与浏览器

| 插件 | 说明 | 作者 / 仓库 |
| --- | --- | --- |
| [`@wxg-prc-cpg/browser-skill-dsh-plugin`](https://www.npmjs.com/package/@wxg-prc-cpg/browser-skill-dsh-plugin) | 把 BrowserSkill 浏览器自动化（`bsk_*` 工具）接进 DSH，用你已登录的真实浏览器 | [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill) |
| [`dsh-builtin-browser`](https://www.npmjs.com/package/dsh-builtin-browser) | 共享真实浏览器：可见、可接管、CDP 驱动，DOM 级交互与 cookie 持久化 | [wqty123](https://github.com/wqty123/dsh-browser) |
| [`dsh-free-search`](https://www.npmjs.com/package/dsh-free-search) | 免费网页搜索，27 个引擎，多数无需 API Key | [DDDMUC](https://github.com/DDDMUC/dsh-free-search) |

### 记忆与上下文压缩

| 插件 | 说明 | 作者 / 仓库 |
| --- | --- | --- |
| [`dsh-mnemon`](https://www.npmjs.com/package/dsh-mnemon) | 可组合的视图式上下文：可插拔来源与策略，分层记忆 + 自演化技能 | [omdsh-dev](https://github.com/omdsh-dev/dsh-mnemon) |
| [`dsh-lite-memory`](https://www.npmjs.com/package/dsh-lite-memory) | 按需记忆：不常驻，命中时最多三张小卡片，正文按需读取 | [regrevia](https://github.com/regrevia/dsh-lite-memory) |
| [`dsh-soul-md`](https://www.npmjs.com/package/dsh-soul-md) | soul.md 风人设 + 长期记忆，可按工作区 / 会话切换人设 | [Scorp1o117](https://github.com/Scorp1o117/dsh-soul-md) |
| [`billion-context`](https://www.npmjs.com/package/billion-context) | 上下文压缩：小窗口也够用、省 token、支持月级长会话 | [ranxianglei](https://github.com/ranxianglei/billion-context) |

### 模型与订阅

| 插件 | 说明 | 作者 / 仓库 |
| --- | --- | --- |
| [`dsh-codex-subscription`](https://www.npmjs.com/package/dsh-codex-subscription) | 把 ChatGPT / Codex 订阅当 DSH 的 LLM provider（OAuth、额度、Fast 模式） | [WSL043](https://github.com/WSL043/dsh-codex-subscription) |
| [`dsh-plugin-subscriptions`](https://www.npmjs.com/package/dsh-plugin-subscriptions) | ChatGPT(Codex)、Claude、Grok、Copilot、Antigravity 订阅接入，Web 设置页 OAuth 登录 | [V1ki](https://github.com/V1ki/dsh-plugin-subscriptions) |
| [`dsh-connect-workbuddy`](https://www.npmjs.com/package/dsh-connect-workbuddy) | 把本机登录的 WorkBuddy 模型接进 DSH，读积分倍率、多账号切换 | [dingminhua](https://github.com/dingminhua/dsh-connect-workbuddy) |

### 远程、移动与 IM

| 插件 | 说明 | 作者 / 仓库 |
| --- | --- | --- |
| [`dsh-remote`](https://www.npmjs.com/package/dsh-remote) | SSH 远程工作助手：多跳 ProxyJump、21 个 `rw_*` 工具、镜像同步、内置 PTY | [flymysql](https://github.com/flymysql/dsh-remote) |
| [`dsh-mobile`](https://www.npmjs.com/package/dsh-mobile) | 移动端适配与安全访问：局域网、远程连接、Android App、手机浏览器 | [saya-ch](https://github.com/saya-ch/dsh-mobile) |
| [`dsh-pocket`](https://www.npmjs.com/package/dsh-pocket) | 手机扫码同步访问电脑上的 DSH（局域网 + 公网） | [shaobeichen](https://github.com/shaobeichen/dsh-pocket) |
| [`@xmanrui/dsh-im`](https://www.npmjs.com/package/@xmanrui/dsh-im) | 微信 / 飞书 / 企微 / 钉钉 / QQ / Telegram / Slack / Discord 接入 DSH | [xmanrui](https://github.com/xmanrui/dsh-im) |
| [`@tencent-connect/dsh-qqbot`](https://www.npmjs.com/package/@tencent-connect/dsh-qqbot) | 在 QQ 私聊和群聊里直接对话 DeepSeek Harness | [tencent-connect](https://github.com/tencent-connect/dsh-qqbot) |

### 多 Agent 与终端

| 插件 | 说明 | 作者 / 仓库 |
| --- | --- | --- |
| [`@nanmicoder/dsh-agent-teams`](https://www.npmjs.com/package/@nanmicoder/dsh-agent-teams) | 多智能体团队协作：队长、成员、依赖任务、消息，GUI 有树状监控 | [NanmiCoder](https://github.com/NanmiCoder/dsh-agent-teams) |
| [`@deepseek-harness-tui/dsh-tui`](https://www.npmjs.com/package/@deepseek-harness-tui/dsh-tui) | 终端 TUI 客户端（Claude Code 风格），补官方空档 | [ccch1mneyyy](https://github.com/ccch1mneyyy/dsh-TUI) |

### 插件治理与工具链

| 插件 | 说明 | 作者 / 仓库 |
| --- | --- | --- |
| [`dshmarket`](https://www.npmjs.com/package/dshmarket) | 装在界面里的可视化插件市场，浏览 / 搜索 / 一键安装 | [dsh-market](https://github.com/dsh-market/dsh-market) |
| [`dsh-plugin-health`](https://www.npmjs.com/package/dsh-plugin-health) | 诊断插件安装、兼容性与加载失败，给可回滚的修复方案 | [EasonMWS](https://github.com/EasonMWS/dsh-plugin-health) |
| [`dsh-plugin-toolkit`](https://www.npmjs.com/package/dsh-plugin-toolkit) | 插件预检、发布与测试：检查目录或 GitHub 仓库、等 npm 真的发出新版本 | [WJDdidi-1](https://github.com/WJDdidi-1/dsh-plugin-toolkit) |
| [`dsh-trust-check`](https://www.npmjs.com/package/dsh-trust-check) | 静态能力披露：插件申请了哪些能力、注入了什么提示词、装了什么脚本 | [liuwenji007](https://github.com/liuwenji007/dsh-trust-check) |
| [`dsh-ops`](https://www.npmjs.com/package/dsh-ops) | 原生文件与 PTC 工具，覆盖 Windows x64 / Linux x64 / macOS | [T-Auto](https://github.com/T-Auto/dsh-ops) |
| [`dsh-cost-meter`](https://www.npmjs.com/package/dsh-cost-meter) | 会话费用统计：本会话成本、当日费用、历史记录、多厂商模型计价 | [Han-1413141](https://github.com/Han-1413141/dsh-cost-meter) |

> 清单随实际使用更新。**装了但不好用的会被移出去**，没列进来不代表不好。

---

## 找更多插件

DSH 官方**不运营插件注册表**，只要求社区仓库打 GitHub topic `dsh-plugin` 方便发现。下面是社区做的索引站，与官方无关：

| 站点 | 做什么 |
| --- | --- |
| [awesome-dsh-plugin.com](https://awesome-dsh-plugin.com) | 策展清单 + format-1 索引（[index.json](https://awesome-dsh-plugin.com/index.json)），只收能用 `dsh plugin add` 装的包 |
| [dshfind.com](https://dshfind.com) | 插件超市 + 教程，索引源 <https://api.dshfind.com/market/dsh-index.json>，可直接贴进 DSH 的自定义插件市场 |
| [dsh-insights.com](https://dsh-insights.com) | 生态观察站 / 评分库，含周报与开放数据 |
| [dsh-plugin.org](https://dsh-plugin.org) | 插件市场 GUI 插件（npm 包名 `dsh-plugin`）+ 站点 |
| [dshmarket.com](https://dshmarket.com) | 站内可视化市场，npm 包名 `dshmarket` |

官方文档与仓库：

- 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 官方文档：<https://deepseek-harness.github.io/deepseek-harness/>
- 开发文档（从"第一个插件"开始）：<https://deepseek-harness.github.io/deepseek-harness/develop/basic/>
- 插件市场索引格式规范：<https://deepseek-harness.github.io/deepseek-harness/guide/plugin-market>

**风险提示**：装插件等于以你的权限运行第三方代码，工具审批不沙箱化插件代码。上面的索引站都是自动抓取、不做安全审查，别把"收录了"当成"安全"。

---

## 怎么装

```bash
# npm 上的插件
dsh plugin --profile web add dsh-meme

# 指定版本
dsh plugin --profile web add dsh-meme@0.1.63

# 本地目录里的插件（正在开发的）
dsh plugin --profile web add ./plugins/my-plugin
```

也可以在 DSH 界面里走 **插件 → 添加插件**，搜索包名安装。

常用维护命令：

```bash
dsh plugin --profile web update dsh-meme@latest   # 更新
dsh plugin --profile web remove dsh-meme          # 卸载
dsh plugin --profile web list                     # 看装了什么
dsh --profile web --dump-config                   # 看合成后的配置
```

**关于 profile 名**：用 `web`、`headless`、`sdk`、`sdk-minimal`、`acp` 或你自己建的名字。**`desktop` 是 Electron 占用的 profile，npm 版 CLI 会拒绝针对它的插件管理请求**——桌面端的插件要在桌面客户端里装。

**装完别只看进程还在**：看插件行是否真的激活（插件管理器面板），`restart-required` 表示还没生效。都改 UI 主题或注册同名工具的那类插件容易互相打架，出问题先用 `dsh-plugin-health` 查。

---

## 仓库结构

```
dsh-plugins/
├── plugins/                      # 我自己的插件，每个目录一个独立包
├── templates/
│   └── minimal-host-plugin/      # 最小可安装插件模板（带 locale + icon，能过清单检查）
├── docs/
│   └── plugin-authoring.md       # 插件开发速查：清单字段、三个最常见的坑、调试与发布
├── scripts/
│   └── check-manifests.mjs       # 校验 plugins/ 和 templates/ 下包的清单自洽性
├── .github/workflows/ci.yml      # 每次 push 跑清单检查
├── README.md
└── LICENSE
```

跑清单检查：

```bash
node scripts/check-manifests.mjs
```

它会检查每个包的 `package.json` 能否解析、`dsh.bundle.patch` 指向的文件是否存在、patch 行里的 `name` 是否与包名一致、`files` 列出的文件是否真实存在、图标是否超过 256 KiB、`dsh.client` 是否配了 `exports["./client"]`。

---

## 写一个插件

从模板起步：

```bash
cp -r templates/minimal-host-plugin plugins/my-plugin
```

然后改三处：`package.json` 的 `name`、`cordis.patch.yml` 里 `id` 和 `name`、`locale/*.json` 的标题和描述。**`cordis.patch.yml` 里的 `name` 必须等于包名**，否则装载器会报 `Cannot find package '<name>'`，插件起不来。

完整要点见 [docs/plugin-authoring.md](docs/plugin-authoring.md)，包括：

- bundle patch / 主机侧 / 浏览器侧三者的关系
- `apply()` 里注册资源并返回清理函数
- 不要直接改写用户的 profile `cordis.patch.yml`；配置走 `configEditor`，密钥走 `credentials`
- 本地调试、`restart-required` 的判定、发布前检查

---

## 收录规则

别人的插件进这份清单，要满足：

1. npm 上能装到，`dsh.bundle.patch` 存在，`repository` 指向可访问仓库；
2. README 说清楚它是干什么的、装完怎么触发；
3. 我自己实际装过、用过至少一次。

自研插件进 `plugins/` 要满足：

1. `node scripts/check-manifests.mjs` 通过；
2. 有 `locale/zh.json` 和 `locale/en.json` 的 `meta.title` / `meta.description`，有图标；
3. 有说明它做什么的 `README.md`。

---

## License

本仓库自己的代码用 [MIT](LICENSE)。清单里列出的第三方插件各自遵循其仓库的许可证，本仓库只做索引，不重新分发它们的代码。
