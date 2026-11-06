# 最小主机插件模板 / Minimal host plugin template

一个能装进 DSH profile 的最小 Cordis 插件：注册一条插件行、带本地化标题和图标，激活时打一条日志。

A minimal Cordis plugin that actually installs into a DSH profile: one loader row, localized title, icon, and a log line on activation.

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包清单。`dsh.bundle.patch` 指向 `cordis.patch.yml`，装载器靠它找到插件行 |
| `cordis.patch.yml` | Bundle patch 层。`name` 必须是可以被 `import` 的真实包名 |
| `index.js` | 主机侧插件：导出 `apply(ctx, config)`，可附带 `inject` 和 `Config` |
| `locale/en.json` / `locale/zh.json` | 插件管理器和设置页读取的 `meta.title` / `meta.description` |
| `icon.svg` | 插件图标（支持 SVG / PNG / JPEG / WebP，≤ 256 KiB，必须在包内） |

## 改成你自己的插件（三步）

1. 复制这个目录，改成一个有意义的名字，例如 `plugins/my-plugin/`。
2. 把 `package.json` 里的 `name` 改成你的包名（本地开发可以直接用 `@local/my-plugin`），并同步改 `cordis.patch.yml` 里的 `id` 和 `name`。
3. 改 `locale/*.json` 的标题和描述、换 `icon.svg`，然后在 `index.js` 的 `apply()` 里注册你真正要做的事。

## 本地安装

```bash
dsh plugin --profile web add <这个目录的绝对路径>
```

也可以在 DSH 的 **插件 → 添加插件** 里直接选本地目录。

装完用 `cordis_inspect_query`（`Config.listConfigs`）或插件管理器确认插件行已激活；只看日志或进程列表不算激活。

## 注意

- `cordis.patch.yml` 里的 `name` 写错会报 `Cannot find package '<name>'`，插件起不来。
- 不要在 `apply()` 之外注册任何资源；用 `ctx.effect` / `ctx.on` 注册并返回清理函数。
- 不要直接改写用户的 profile `cordis.patch.yml`。插件自己的配置通过 `ctx.get('configEditor')` 保存。
