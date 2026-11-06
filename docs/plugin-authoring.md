# DSH 插件开发速查 / Plugin authoring cheat sheet

面向「想给 DeepSeek Harness（`dsh`）写插件」的人。内容按 2026-11 的实际安装目录核对过，不是凭印象写的。

## 1. 插件是什么

DSH 的插件就是 **Cordis 插件包**，通过 npm 分发。一个包同时可以做三件事：

| 半边 | 入口 | 说明 |
| --- | --- | --- |
| Bundle patch | `package.json` 的 `dsh.bundle.patch` | 一份 YAML，往 profile 的 loader 里插入插件行 |
| 主机侧 Host | 包的主入口（`main` / `exports["."]`） | 普通 Cordis 插件，跑在 Node 进程里：工具、路由、服务、监听 |
| 浏览器侧 Client | `exports["./client"]` + `dsh.client` | 一个懒加载工厂，往 Web UI 的 slot 里注册 React 组件 |

只做后端的插件不需要 `dsh.client`；只做 UI 装饰的插件 `index.js` 可以只导出 `export function apply() {}`。

## 2. 最小清单

```json
{
  "name": "dsh-my-plugin",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "files": ["index.js", "client.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["@deepseek-ai/dsh-client-ui-conversation"]
    }
  }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: my-plugin
      name: 'dsh-my-plugin'   # 必须是能被 import 的真实包名
      config: {}
```

## 3. 三条最容易踩的坑

1. **`name` 写错 = 插件起不来。** 报错是 `Cannot find package '<name>'`。`id` 是本地标识、随便起；`name` 是模块说明符，必须和 `package.json` 的包名一致。
2. **资源必须在 `apply()` 里注册。** 用 `ctx.effect(() => dispose)` 或 `ctx.on(...)`，并返回清理函数。写在模块顶层的东西禁用插件时不会回收。
3. **不要碰用户的 profile `cordis.patch.yml`。** 那是用户和别的插件共用的文件，里面还有注释和 `!!js` 表达式。插件要存自己的配置，走 `ctx.get('configEditor').edit(entry, ...)`；密钥走 `ctx.credentials`。

## 4. Client 半边长什么样

```js
window.__ModuleLoader__.load({
  id: 'dsh-my-plugin',            // 必须等于包名
  factory(require) {
    const React = require('react')
    const h = React.createElement
    function Badge() {
      return h('span', { style: { fontVariantNumeric: 'tabular-nums' } }, 'ok')
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'my-plugin-badge',
          order: 5,
        }, Badge))
      },
    }
  },
})
```

React 从浏览器的模块表里来，**不要**自己再装一份 React，也不要挂 CDN。样式继承宿主主题的 CSS 变量，别写死颜色。

## 5. 显示信息（别省）

插件管理器和设置页**不激活插件**也会读这些：

- `locale/en.json` 和 `locale/zh.json` 里的 `meta.title`、`meta.description`；
- 图标：`exports["./icon"]`，或 `package.json` 顶层的 `icon` 字段（优先级更高）。

图标支持 SVG / PNG / JPEG / WebP，≤ 256 KiB，必须在包目录内。缺了就掉到默认图，别人一眼就看出是模板没改。英文标题用句首大写（sentence case）。

## 6. 本地调试与安装

```bash
# 装到指定 profile
dsh plugin --profile web add ./path/to/your-plugin

# 装 npm 上的包
dsh plugin --profile web add dsh-my-plugin

# 更新 / 卸载 / 查看
dsh plugin --profile web update dsh-my-plugin@latest
dsh plugin --profile web remove dsh-my-plugin
dsh plugin --profile web list
```

`dsh plugin --profile <name> <pnpm args>` 本质上是在 profile 目录里转发给 pnpm，所以 `add` / `remove` / `update` / `list` 都是 pnpm 的语义。

**profile 名不要写 `desktop`。** 官方 CLI 文档写明：`desktop` 这个 profile 保留给 Electron 持有，CLI 会拒绝针对它的启动、配置 dump **以及插件管理**请求；桌面端插件要在桌面客户端里装。可用的名字是 `web`、`headless`、`sdk`、`sdk-minimal`、`acp`，或你自己 `dsh --profile <name>` 建的自定义 profile（落在 `$DSH_HOME/profiles/<name>`）。

装完不要靠「进程还在」判断成功：查插件行是否激活（插件管理器面板，或 `cordis_inspect_query` 的 `Config.listConfigs`）。`restart-required` 表示还没生效。

## 7. 发布

1. `package.json` 补 `description`、`keywords`（含 `dsh-plugin`、`deepseek-harness`）、`license`、`repository`。
2. `files` 里的东西要和实际发布内容一致——漏了 `locale/` 或 `icon.svg`，用户装上去就是一个没有名字的灰块。
3. `npm publish`，然后在 README 里给出 `dsh plugin --profile web add <包名>`。
4. 想进本仓库的清单？按 `plugins/` 下的约定提 PR。

## 8. 参考

官方：

- 官方仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 官方文档站：<https://deepseek-harness.github.io/deepseek-harness/>
- 开发文档（"第一个插件"）：<https://deepseek-harness.github.io/deepseek-harness/develop/basic/>
- 工具 / 配置 / 打包安装：`/develop/basic/tool`、`/develop/basic/config`、`/develop/basic/publish`
- 插件市场索引格式：<https://deepseek-harness.github.io/deepseek-harness/guide/plugin-market>
- CLI 说明：<https://github.com/deepseek-ai/deepseek-harness/blob/HEAD/apps/cli/README.zh.md>
- Cordis 框架：<https://github.com/cordiverse/cordis>

DSH 内置技能（问 Agent 要，比翻文档快）：

- `cordis-plugin-development` — 插件开发全流程与模板
- `cordis-composition-reference` — Loader patch 语法、可安装包清单
- `editing-cordis-compositions` — Agent preset / composition
