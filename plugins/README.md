# plugins/

我自己的 DSH 插件，一个目录一个独立包，可以直接安装：

```bash
dsh plugin --profile web add ./plugins/<name>
```

## 新建一个插件

```bash
cp -r templates/minimal-host-plugin plugins/my-plugin
```

然后至少改这几处，否则装上去是个空壳：

| 改哪里 | 改成什么 |
| --- | --- |
| `package.json` → `name` | 你的包名，例如 `dsh-my-plugin`（本地开发可用 `@local/my-plugin`） |
| `package.json` → `description` / `keywords` / `repository` | 真实描述；`keywords` 里带 `dsh-plugin`、`deepseek-harness` |
| `cordis.patch.yml` → `id` 和 `name` | `name` **必须等于** `package.json` 的 `name`，否则报 `Cannot find package` |
| `locale/en.json`、`locale/zh.json` | `meta.title` 和 `meta.description`，插件管理器不激活插件也会读 |
| `icon.svg` | 换成自己的图标（SVG/PNG/JPEG/WebP，≤ 256 KiB，必须在包内） |
| `index.js` → `apply()` | 注册你真正要做的东西 |
| `README.md` | 这个插件做什么、怎么触发、有什么配置 |

改完跑一遍检查：

```bash
node scripts/check-manifests.mjs
```

## 约定

- 目录名和 npm 包名对应（`dsh-foo` → `plugins/dsh-foo/`）。
- 不要在 `apply()` 外面注册任何资源；用 `ctx.effect` / `ctx.on` 注册并返回清理函数。
- 不要把用户 profile 的 `cordis.patch.yml` 当成自己的配置文件读写。
- `engines.dsh` 或 `dsh.compatibility.dshReleases` 能声明就声明，DSH 还在 developer preview，破坏性变更不少。

开发要点见 [`docs/plugin-authoring.md`](../docs/plugin-authoring.md)。

## 已收录

| 插件 | 说明 |
| --- | --- |
| _暂无_ | — |
