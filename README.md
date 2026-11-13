# dsh-plugins

我的 **DeepSeek Harness** 插件合集：自己写的插件放在 `plugins/`，日常在用的其他人的插件整理在下面的清单里。

> DeepSeek Harness（命令 `dsh`）的插件是 Cordis 插件包，通过 npm 分发，用 `dsh plugin --profile <profile> add <包名>` 装进某个 profile。官方明确处于 developer preview，会有破坏性变更，装之前留意插件的 `engines.dsh` / 兼容性声明。

[![plugins](https://img.shields.io/badge/自研插件-plugins%2F-3b82f6?style=flat-square)](#自研插件)
[![verified](https://img.shields.io/badge/常用插件-本机实测-10b981?style=flat-square)](#常用插件清单)
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
| [`dsh-comfyui-refvideo`](plugins/dsh-comfyui-refvideo) | 可用 | 参考生视频：参考图 / 视频 / 音频 → MiniMax H3 短视频 |
| [`dsh-comfyui-txt2img`](plugins/dsh-comfyui-txt2img) | 可用 | 文生图：Krea2 Turbo，LoRA 与风格后缀 |
| [`dsh-comfyui-upscale`](plugins/dsh-comfyui-upscale) | 可用 | 图片放大：SeedVR2，1–8 倍 |
| [`dsh-comfyui-imgedit`](plugins/dsh-comfyui-imgedit) | 可用 | 图片编辑：多图合成一张（Qwen-Image 2.1） |
| [`dsh-comfyui-txt2music`](plugins/dsh-comfyui-txt2music) | 可用 | 文生音乐：YuE2 3B，曲风 + 歌词 → 歌 |

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

只列我**本机真的装着、天天在用**的插件。本仓库不是插件大全——想逛全集看下面的[找更多插件](#找更多插件)。

| 插件 | 干什么用的 | 作者 / 仓库 |
| --- | --- | --- |
| [`dsh-context`](https://www.npmjs.com/package/dsh-context) | 上下文洞察：Context 面板、侧栏、`/context` 命令，看上下文怎么组成、怎么演进 | [bowenliang123](https://github.com/bowenliang123/dsh-context) |
| [`dsh-image-gen`](https://www.npmjs.com/package/dsh-image-gen) | 对话内生成 / 编辑图像，多模型（Gemini、OpenAI、Seedream、ComfyUI 等） | [shanliuling](https://github.com/shanliuling/dsh-image-gen) |
| [`dsh-meme`](https://www.npmjs.com/package/dsh-meme) | 输入框一键发图、斗图；多图库、情绪与关键词搜图、AI 学图 | [yyh-001](https://github.com/yyh-001/dsh-meme) |
| [`dsh-notify-me`](https://www.npmjs.com/package/dsh-notify-me) | 离开页面也能收到提醒：需要你操作、后台回复完成时发系统通知 | [chromoany](https://github.com/chromoany/dsh-notify-me) |
| [`dsh-design`](https://www.npmjs.com/package/dsh-design) | 设计审查：`design_audit` 实测字号层级、WCAG 对比度、间距网格、配色漂移 | [Viger1](https://github.com/Viger1/dsh-design) |
| [`dsh-media-desk`](https://www.npmjs.com/package/dsh-media-desk) | 一句话记灵感、一键出稿：口播脚本、标题、封面、配图、分镜 | [woniuniuniu](https://github.com/woniuniuniu/dsh-media-desk) |
| [`@wxg-prc-cpg/browser-skill-dsh-plugin`](https://www.npmjs.com/package/@wxg-prc-cpg/browser-skill-dsh-plugin) | 把 BrowserSkill 浏览器自动化（`bsk_*` 工具）接进 DSH，用你已登录的真实浏览器 | [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill) |

就这些，没有更多。这张表只会因为我真的装了新东西才变长。

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

1. **我自己实际装过、用过至少一次**（这条是硬门槛，没装过的不进清单）；
2. npm 上能装到，`dsh.bundle.patch` 存在，`repository` 指向可访问仓库；
3. README 说清楚它是干什么的、装完怎么触发。

自研插件进 `plugins/` 要满足：

1. `node scripts/check-manifests.mjs` 通过；
2. 有 `locale/zh.json` 和 `locale/en.json` 的 `meta.title` / `meta.description`，有图标；
3. 有说明它做什么的 `README.md`。

---

## License

本仓库自己的代码用 [MIT](LICENSE)。清单里列出的第三方插件各自遵循其仓库的许可证，本仓库只做索引，不重新分发它们的代码。
