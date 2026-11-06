#!/usr/bin/env node
/**
 * 检查仓库里的插件包清单是否自洽。
 *
 * 对 plugins/ 和 templates/ 下的每个目录：
 *   - package.json 能解析，且有 name / version / dsh.bundle.patch
 *   - dsh.bundle.patch 指向的文件存在
 *   - cordis.patch.yml 里 insert 行的 name 与 package.json 的 name 一致
 *   - files 字段里列出的每个路径实际存在（支持 * 通配）
 *   - 若声明了 exports["./icon"]，图标文件存在且 ≤ 256 KiB
 *   - 若声明了 dsh.client，exports["./client"] 指向的文件存在
 *
 * 用法：node scripts/check-manifests.mjs
 * 退出码 0 = 全部通过，1 = 有错误。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const scanRoots = ['plugins', 'templates']
const errors = []
const checked = []

const ICON_LIMIT = 256 * 1024

function walkDirs(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (existsSync(join(full, 'package.json'))) out.push(full)
    out.push(...walkDirs(full))
  }
  return out
}

/** 粗略解析 patch 里的 insert 行，够用即可：只找 `- id:` / `name:` 对。 */
function rowsFromPatch(text) {
  const rows = []
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#')) continue
    const idM = /^-\s+id:\s*(.+)$/.exec(line)
    const nameM = /^name:\s*(.+)$/.exec(line)
    if (idM) {
      if (current) rows.push(current)
      current = { id: stripQuotes(idM[1]), name: null }
    } else if (nameM && current && current.name === null) {
      current.name = stripQuotes(nameM[1])
    }
  }
  if (current) rows.push(current)
  return rows
}

const stripQuotes = (v) => v.trim().replace(/^['"]|['"]$/g, '')

/** files 字段里的通配只支持文件名里的 `*`，按所在目录展开。 */
function expandFileGlob(pkgDir, pattern) {
  if (!pattern.includes('*')) return [pattern]
  const slash = pattern.lastIndexOf('/')
  const dirPart = slash === -1 ? '' : pattern.slice(0, slash)
  const [prefix, suffix] = pattern.slice(slash + 1).split('*')
  const dir = join(pkgDir, dirPart)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
    .map((f) => (dirPart ? `${dirPart}/${f}` : f))
}

for (const scanRoot of scanRoots) {
  for (const pkgDir of walkDirs(join(root, scanRoot))) {
    const rel = pkgDir.slice(root.length + 1).replaceAll('\\', '/')
    let pkg
    try {
      pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    } catch (err) {
      errors.push(`${rel}: package.json 不是合法 JSON (${err.message})`)
      continue
    }
    checked.push(rel)

    if (!pkg.name) errors.push(`${rel}: 缺少 name`)
    if (!pkg.version) errors.push(`${rel}: 缺少 version`)

    const patchRel = pkg.dsh?.bundle?.patch
    if (!patchRel) {
      errors.push(`${rel}: 缺少 dsh.bundle.patch，装载器找不到插件行`)
    } else if (!existsSync(join(pkgDir, patchRel))) {
      errors.push(`${rel}: dsh.bundle.patch 指向的文件不存在 (${patchRel})`)
    } else {
      const rows = rowsFromPatch(readFileSync(join(pkgDir, patchRel), 'utf8'))
      if (rows.length === 0) errors.push(`${rel}: patch 里没有 insert 行`)
      for (const row of rows) {
        if (!row.name) errors.push(`${rel}: patch 行 ${row.id} 缺少 name`)
        else if (row.name !== pkg.name) {
          errors.push(`${rel}: patch 行 ${row.id} 的 name (${row.name}) 与 package.json (${pkg.name}) 不一致`)
        }
      }
    }

    for (const pattern of pkg.files ?? []) {
      const hits = expandFileGlob(pkgDir, pattern)
      if (hits.length === 0) errors.push(`${rel}: files 里的 ${pattern} 实际不存在`)
    }

    const iconExport = pkg.exports?.['./icon']
    if (iconExport) {
      const iconPath = join(pkgDir, iconExport)
      if (!existsSync(iconPath)) errors.push(`${rel}: exports["./icon"] 指向的图标不存在 (${iconExport})`)
      else if (statSync(iconPath).size > ICON_LIMIT) errors.push(`${rel}: 图标超过 256 KiB`)
    }

    if (pkg.dsh?.client) {
      const clientExport = pkg.exports?.['./client']
      if (!clientExport) errors.push(`${rel}: 声明了 dsh.client 但没有 exports["./client"]`)
      else if (!existsSync(join(pkgDir, clientExport))) errors.push(`${rel}: exports["./client"] 指向的文件不存在`)
    }

    for (const loc of ['locale/en.json', 'locale/zh.json']) {
      const p = join(pkgDir, loc)
      if (!existsSync(p)) continue
      try {
        const json = JSON.parse(readFileSync(p, 'utf8'))
        if (!json?.meta?.title) errors.push(`${rel}: ${loc} 缺少 meta.title`)
        if (!json?.meta?.description) errors.push(`${rel}: ${loc} 缺少 meta.description`)
      } catch (err) {
        errors.push(`${rel}: ${loc} 不是合法 JSON (${err.message})`)
      }
    }
  }
}

for (const rel of checked) console.log(`checked ${rel}`)
if (errors.length) {
  console.error(`\n${errors.length} 个问题：`)
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(`\n全部通过（${checked.length} 个插件包）`)
