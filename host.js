// dsh-config-migrate — Host half
// Cordis 动态插件函数体：直接作为动态 Package 的 code.host 使用（return { apply(ctx) {...} }）
// 功能：config/status、config/export、config/import、config/importLast RPC + 动态工具 dsh_config_migrate
return {
  apply(ctx) {
    const fs = ctx.get('fs')
    const settings = ctx.get('settings')
    const sandboxPolicy = ctx.get('sandboxPolicy')
    const subprocess = ctx.get('subprocess')
    if (fs === undefined) return

    let lastExport = null
    const wsRoot = sandboxPolicy ? String(sandboxPolicy.workspaceRoot).replace(/[\\/]+$/, '') : null

    function isWindowsPath(p) {
      return /^[A-Za-z]:/.test(p) || p.indexOf('\\') !== -1
    }
    function sepFor(p) {
      return isWindowsPath(p) ? '\\' : '/'
    }
    function platformName(p) {
      return isWindowsPath(p) ? 'Windows' : 'Unix'
    }
    function joinBase(base, rel) {
      const sep = sepFor(base)
      return String(base).replace(/[\\/]+$/, '') + sep + String(rel).split('/').join(sep)
    }
    const statePath = wsRoot ? wsRoot + sepFor(wsRoot) + '.dshmig-state.json' : null

    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    function bytesToBase64(bytes) {
      let out = ''
      const len = bytes.length
      for (let i = 0; i < len; i += 3) {
        const b0 = bytes[i]
        const b1 = i + 1 < len ? bytes[i + 1] : 0
        const b2 = i + 2 < len ? bytes[i + 2] : 0
        out += B64[b0 >> 2]
        out += B64[((b0 & 3) << 4) | (b1 >> 4)]
        out += i + 1 < len ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '='
        out += i + 2 < len ? B64[b2 & 63] : '='
      }
      return out
    }
    function base64Len(b64) {
      const s = String(b64).replace(/[^A-Za-z0-9+/=]/g, '')
      let pad = 0
      if (s.endsWith('==')) pad = 2
      else if (s.endsWith('=')) pad = 1
      return Math.floor((s.length * 3) / 4) - pad
    }
    function tryUtf8(bytes) {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch (e) {
        return null
      }
    }
    // Rewrite absolute link: paths to portable relative ones (profiles/<p> -> ../../external-plugins/<name>)
    function relativizeLinks(text) {
      return String(text).replace(/"link:[^"]*external-plugins[\\/]+([^"\\/]+)"/g, '"link:../../external-plugins/$1"')
    }

    function dirname(p) {
      const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
      return i > 0 ? p.slice(0, i) : p
    }
    function basename(p) {
      const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'))
      return i >= 0 ? p.slice(i + 1) : p
    }
    function safeRel(rel) {
      const parts = String(rel).split('/')
      for (const p of parts) {
        if (!p || p === '.' || p === '..') return null
      }
      return parts.join('/')
    }

    async function runCmd(argv, cwd) {
      if (subprocess === undefined) return { ok: false, error: 'subprocess 服务不可用' }
      try {
        const handle = subprocess.spawn({
          argv,
          cwd,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
          graceMs: 120000,
        })
        const outcome = await handle.done
        return { ok: outcome.exitCode === 0, exitCode: outcome.exitCode }
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) }
      }
    }

    // Decode a base64 text file into a binary target, platform-aware.
    async function decodeBase64File(home, tmpPath, abs) {
      if (isWindowsPath(home)) {
        const ps = "$b=[IO.File]::ReadAllText('" + tmpPath.replace(/'/g, "''") + "');[IO.File]::WriteAllBytes('" + abs.replace(/'/g, "''") + "',[Convert]::FromBase64String(($b -replace '\\s','')));Remove-Item -LiteralPath '" + tmpPath.replace(/'/g, "''") + "' -Force"
        return runCmd(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', ps], home)
      }
      // Unix: try openssl, then BSD base64 -D, then GNU base64 -d
      const r1 = await runCmd(['openssl', 'base64', '-d', '-in', tmpPath, '-out', abs], home)
      if (r1.ok) {
        await runCmd(['rm', '-f', tmpPath], home)
        return r1
      }
      const r2 = await runCmd(['base64', '-D', '-i', tmpPath, '-o', abs], home)
      if (r2.ok) {
        await runCmd(['rm', '-f', tmpPath], home)
        return r2
      }
      const sh = "base64 -d < '" + tmpPath.replace(/'/g, "'\\''") + "' > '" + abs.replace(/'/g, "'\\''") + "' && rm -f '" + tmpPath.replace(/'/g, "'\\''") + "'"
      const r3 = await runCmd(['/bin/sh', '-c', sh], home)
      return r3
    }

    // Create a plugin link in node_modules, platform-aware (junction on Windows, symlink on Unix).
    async function linkExternalPlugin(home, linkPath, target) {
      if (isWindowsPath(home)) {
        const ps = "$parent=Split-Path -Parent '" + linkPath.replace(/'/g, "''") + "';New-Item -ItemType Directory -Force -Path $parent|Out-Null;if(Test-Path -LiteralPath '" + linkPath.replace(/'/g, "''") + "'){Remove-Item -LiteralPath '" + linkPath.replace(/'/g, "''") + "' -Force};New-Item -ItemType Junction -Path '" + linkPath.replace(/'/g, "''") + "' -Target '" + target.replace(/'/g, "''") + "'|Out-Null"
        return runCmd(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', ps], home)
      }
      const sh = "mkdir -p \"$(dirname '" + linkPath.replace(/'/g, "'\\''") + "')\" && ln -sfn '" + target.replace(/'/g, "'\\''") + "' '" + linkPath.replace(/'/g, "'\\''") + "'"
      return runCmd(['/bin/sh', '-c', sh], home)
    }

    async function resolveHome(args) {
      if (args && typeof args.home === 'string' && args.home) return String(args.home).replace(/[\\/]+$/, '')
      if (settings !== undefined) {
        try {
          const doc = await settings.prepareDocument()
          if (typeof doc === 'string' && doc) return dirname(doc)
        } catch (e) { /* ignore */ }
      }
      throw new Error('无法定位 DSH_HOME：settings 服务不可用且未提供 home 参数')
    }

    const EXCLUDE_DIRS = new Set(['node_modules', 'sessions', 'storages', '.git'])
    const TOP_FILES = ['settings.yaml', 'settings.yaml.bak', '.credentials.yaml', '.anonymous-user-id']
    const INCLUDE_DIRS = new Set(['profiles', 'external-plugins', '.agent-presets'])
    const MAX_FILE_BYTES = 50 * 1024 * 1024

    function shouldSkip(rel, opts) {
      const o = opts || {}
      if (o.skipCredentials && rel === '.credentials.yaml') return true
      if (Array.isArray(o.exclude)) {
        for (const p of o.exclude) {
          if (rel === p || rel.indexOf(p + '/') === 0) return true
        }
      }
      return false
    }

    async function walkCollect(target, rel, out, opts) {
      let entries
      try { entries = await fs.listDir(target) } catch (e) { return }
      for (const entry of entries) {
        if (EXCLUDE_DIRS.has(entry.name)) continue
        const childRel = rel ? rel + '/' + entry.name : entry.name
        if (entry.type === 'directory') {
          await walkCollect(entry.target, childRel, out, opts)
        } else if (entry.type === 'file') {
          if (shouldSkip(childRel, opts)) continue
          out.push({ rel: childRel, target: entry.target, size: entry.size || 0 })
        }
      }
    }

    async function collect(home, opts) {
      const root = await fs.resolve(home)
      const files = []
      const entries = await fs.listDir(root).catch(() => [])
      for (const entry of entries) {
        if (entry.type === 'file' && TOP_FILES.includes(entry.name)) {
          if (shouldSkip(entry.name, opts)) continue
          files.push({ rel: entry.name, target: entry.target, size: entry.size || 0 })
        } else if (entry.type === 'directory' && INCLUDE_DIRS.has(entry.name)) {
          await walkCollect(entry.target, entry.name, files, opts)
        }
      }
      return files
    }

    async function discoverWorkspaceBundles() {
      if (!wsRoot) return []
      let rootTarget
      try { rootTarget = await fs.resolve(wsRoot) } catch (e) { return [] }
      let entries
      try { entries = await fs.listDir(rootTarget) } catch (e) { return [] }
      const found = []
      for (const e of entries) {
        if (e.type !== 'file') continue
        const m = /^dsh-config-export(?:-(\d+))?\.json$/.exec(e.name)
        if (!m) continue
        found.push({ name: e.name, path: joinBase(wsRoot, e.name), size: e.size || 0, ts: m[1] ? Number(m[1]) : Infinity })
      }
      found.sort((a, b) => b.ts - a.ts)
      return found
    }

    async function loadState() {
      if (!statePath) return null
      try {
        const t = await fs.resolve(statePath)
        const info = await fs.stat(t).catch(() => undefined)
        if (!info || info.type !== 'file') return null
        const raw = await fs.readText(t)
        const s = JSON.parse(raw)
        return s && typeof s.lastExportPath === 'string' ? s : null
      } catch (e) { return null }
    }
    async function saveState(path) {
      if (!statePath) return
      try {
        await fs.writeText(await fs.resolve(statePath), JSON.stringify({ lastExportPath: path }, null, 2))
      } catch (e) { /* non-fatal */ }
    }

    void (async () => {
      try {
        const state = await loadState()
        const found = await discoverWorkspaceBundles()
        let candidate = null
        if (found.length) candidate = { path: found[0].path, name: found[0].name, size: found[0].size }
        else if (state && state.lastExportPath) candidate = { path: state.lastExportPath, name: basename(state.lastExportPath), size: 0 }
        if (candidate) {
          try {
            const t = await fs.resolve(candidate.path)
            const info = await fs.stat(t).catch(() => undefined)
            if (info && info.type === 'file') lastExport = candidate
          } catch (e) { /* fall through */ }
        }
      } catch (e) { /* non-fatal */ }
    })()

    async function status(args) {
      const home = await resolveHome(args)
      const files = await collect(home)
      const bundles = await discoverWorkspaceBundles()
      return {
        home,
        platform: platformName(home),
        count: files.length,
        files: files.map((f) => ({ rel: f.rel, size: f.size })),
        lastExport: lastExport,
        discovered: bundles.map((b) => ({ name: b.name, path: b.path, size: b.size })),
      }
    }

    async function exportBundle(args) {
      const opts = args || {}
      const home = await resolveHome(args)
      const files = await collect(home, opts)
      const maxBytes = (opts.maxFileBytes && typeof opts.maxFileBytes === 'number') ? opts.maxFileBytes : MAX_FILE_BYTES
      const bundle = {
        format: 'dsh-config-migration',
        version: 2,
        exportedAt: new Date().toISOString(),
        sourceHome: home,
        platform: platformName(home),
        files: {},
      }
      const skipped = []
      let binaryCount = 0
      let total = 0
      for (const f of files) {
        if (f.size > maxBytes) { skipped.push(f.rel + ' (过大)'); continue }
        let bytes
        try {
          bytes = await fs.readBytes(f.target, undefined, maxBytes)
        } catch (e) {
          skipped.push(f.rel + ' (读取失败)'); continue
        }
        const text = tryUtf8(bytes)
        if (text !== null) {
          const content = (f.rel.indexOf('profiles/') === 0 && basename(f.rel) === 'package.json')
            ? relativizeLinks(text)
            : text
          bundle.files[f.rel] = { encoding: 'utf8', content }
          total += content.length
        } else {
          bundle.files[f.rel] = { encoding: 'base64', content: bytesToBase64(bytes) }
          binaryCount += 1
          total += bytes.length
        }
      }
      const bundledFiles = Object.keys(bundle.files).map((rel) => ({ rel, size: bundle.files[rel].content.length }))
      const dryRun = !!opts.dryRun
      if (dryRun) {
        return {
          dryRun: true,
          count: files.length,
          fileCount: bundledFiles.length,
          binaryCount,
          skipped,
          bundledFiles,
        }
      }
      const outPath = typeof opts.path === 'string' && opts.path
        ? String(opts.path)
        : joinBase(wsRoot || home, 'dsh-config-export.json')
      const out = await fs.resolve(outPath)
      await fs.writeText(out, JSON.stringify(bundle, null, 2))
      lastExport = { path: outPath, name: basename(outPath), size: total }
      await saveState(outPath)
      return {
        bundlePath: outPath,
        version: 2,
        count: files.length,
        fileCount: bundledFiles.length,
        binaryCount,
        skipped,
        bundledFiles,
      }
    }

    async function importBundle(args) {
      const opts = args || {}
      if (typeof opts.path !== 'string' || !opts.path) throw new Error('缺少 bundle 路径')
      const home = await resolveHome(args)
      const src = await fs.resolve(String(opts.path))
      const raw = await fs.readText(src)
      let bundle
      try { bundle = JSON.parse(raw) } catch (e) { throw new Error('bundle 不是合法 JSON') }
      if (!bundle || bundle.format !== 'dsh-config-migration' || typeof bundle.files !== 'object') {
        throw new Error('不是 dsh-config-migration 备份包')
      }
      const dryRun = !!opts.dryRun
      const onlyMissing = !!opts.onlyMissing
      const policy = sandboxPolicy ? { mode: 'danger-full-access', workspaceRoot: sandboxPolicy.workspaceRoot } : undefined
      const restored = []
      const backups = []
      const skipped = []
      const verifyErrors = []
      let binaries = 0
      for (const rel of Object.keys(bundle.files)) {
        const safe = safeRel(rel)
        const entry = bundle.files[rel]
        if (!safe || !entry || typeof entry.content !== 'string') { skipped.push(rel + ' (非法条目)'); continue }
        if (shouldSkip(rel, opts)) { skipped.push(rel + ' (已排除)'); continue }
        const abs = joinBase(home, safe)
        const target = await fs.resolve(abs)
        const existing = await fs.stat(target).catch(() => undefined)
        const encoding = entry.encoding === 'base64' ? 'base64' : 'utf8'
        if (existing && existing.type === 'file') {
          if (onlyMissing) { skipped.push(rel + ' (已存在，仅恢复缺失)'); continue }
          let same = false
          if (encoding === 'utf8') {
            try { same = (await fs.readText(target)) === entry.content } catch (e) { same = false }
          } else {
            try {
              const cur = await fs.readBytes(target, undefined, base64Len(entry.content) + 64)
              same = cur.length === base64Len(entry.content)
            } catch (e) { same = false }
          }
          if (same) { skipped.push(rel + ' (内容相同)'); continue }
          if (!dryRun) {
            try {
              const before = await fs.readText(target)
              const bakTarget = await fs.resolve(abs + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-'))
              await fs.writeText(bakTarget, before, undefined, undefined, policy)
              backups.push(safe + ' → ' + basename(bakTarget))
            } catch (e) { skipped.push(rel + ' (备份失败)'); continue }
          } else {
            backups.push(safe + '.bak-<时间戳>')
          }
        }
        if (encoding === 'base64' && !dryRun) {
          if (subprocess === undefined) { skipped.push(rel + ' (二进制，subprocess 不可用)'); continue }
          const tmpPath = joinBase(home, '.dshmig-tmp-' + Date.now() + '-' + binaries + '.b64')
          try {
            await fs.writeText(await fs.resolve(tmpPath), entry.content, undefined, undefined, policy)
            const r = await decodeBase64File(home, tmpPath, abs)
            if (!r.ok) { skipped.push(rel + ' (二进制写入失败: ' + (r.error || r.exitCode) + ')'); continue }
          } catch (e) {
            skipped.push(rel + ' (二进制写入异常)'); continue
          }
          binaries += 1
          try {
            const info = await fs.stat(target).catch(() => undefined)
            if (!info || info.size !== base64Len(entry.content)) verifyErrors.push(rel + ' (大小不符)')
          } catch (e) { verifyErrors.push(rel + ' (校验失败)') }
        } else if (encoding === 'base64') {
          binaries += 1
        } else if (!dryRun) {
          await fs.writeText(target, entry.content, undefined, undefined, policy)
          try {
            const back = await fs.readText(target)
            if (back !== entry.content) verifyErrors.push(rel + ' (内容不一致)')
          } catch (e) { verifyErrors.push(rel + ' (回读失败)') }
        }
        restored.push(safe)
      }
      const links = []
      const linkErrors = []
      const predictedLinks = []
      for (const rel of Object.keys(bundle.files)) {
        const m = /^profiles\/([^/]+)\/package\.json$/.exec(rel)
        if (!m) continue
        const entry = bundle.files[rel]
        if (!entry || typeof entry.content !== 'string') continue
        const depRe = /"(@dsh-external\/[^"]+)":\s*"link:[^"]*"/g
        let dm
        while ((dm = depRe.exec(entry.content)) !== null) {
          const pkgName = dm[1]
          const shortName = pkgName.split('/').pop()
          const linkPath = joinBase(home, 'profiles/' + m[1] + '/node_modules/@dsh-external/' + shortName)
          const target = joinBase(home, 'external-plugins/' + shortName)
          if (dryRun) { predictedLinks.push(pkgName); continue }
          if (subprocess === undefined) { linkErrors.push(pkgName + ' (subprocess 不可用)'); continue }
          const r = await linkExternalPlugin(home, linkPath, target)
          if (r.ok) links.push(pkgName + ' → ' + linkPath)
          else linkErrors.push(pkgName + ' (' + (r.error || r.exitCode) + ')')
        }
      }
      return { home, dryRun, restored, backups, skipped, binaries, links, predictedLinks, linkErrors, verifyErrors }
    }

    async function importLast(args) {
      if (!lastExport) throw new Error('未发现备份包：请先导出配置，或将 dsh-config-export.json 放入工作区后刷新')
      const merged = Object.assign({}, args || {}, { path: lastExport.path })
      return importBundle(merged)
    }

    const handlers = {
      'config/status': status,
      'config/export': exportBundle,
      'config/import': importBundle,
      'config/importLast': importLast,
    }
    for (const name of Object.keys(handlers)) {
      const handler = handlers[name]
      ctx.effect(() => harness.handle(name, (args) => handler(args)))
    }

    const tool = harness.defineTool({
      name: 'dsh_config_migrate',
      description: '导出/导入 DeepSeek Harness 配置（${DSH_HOME} 下的 settings.yaml、.credentials.yaml、profiles、external-plugins 与 .agent-presets），跨平台支持 Windows / macOS / Linux。导出以 base64 打包二进制资源，把 profiles/*/package.json 里指向 external-plugins 的绝对 link: 改写为相对路径，并支持 dryRun 预览清单；导入时内容相同的文件自动跳过、覆盖前备份为 *.bak-<时间戳>、写回后校验文本一致性/二进制大小、按平台重建外部插件链接（Windows 用 junction，macOS/Linux 用符号链接），重启后即可用。action=status 列出配置清单；action=export 打包为 JSON（path 指定输出文件，缺省写入工作区 dsh-config-export.json；dryRun=true 只返回清单不写盘；skipCredentials 排除 .credentials.yaml）；action=import 从 path 指向的备份包恢复（dryRun=true 只预览；onlyMissing=true 仅恢复缺失文件；skipCredentials 排除凭据）；action=importLast 一键导入本会话/工作区发现的最新备份。home 可选，缺省自动探测 DSH_HOME。',
      parameters: {
        action: { type: 'string', enum: ['status', 'export', 'import', 'importLast'], required: true, description: '要执行的操作' },
        path: { type: 'string', description: 'export 的输出文件路径，或 import 的备份包路径' },
        home: { type: 'string', description: '可选：DSH_HOME 绝对路径，缺省自动探测' },
        dryRun: { type: 'boolean', description: 'export/import 只预览，不写盘' },
        onlyMissing: { type: 'boolean', description: 'import 时仅恢复目标不存在的文件' },
        skipCredentials: { type: 'boolean', description: '排除 .credentials.yaml 凭据文件' },
      },
      output: {
        schema: { type: 'json' },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async (args, exec) => {
        const action = args && typeof args.action === 'string' ? args.action : 'status'
        if (action === 'status') return status(args)
        if (action === 'export') return exportBundle(args)
        if (action === 'import') return importBundle(args)
        if (action === 'importLast') return importLast(args)
        return { error: 'unknown action: ' + action }
      },
    })
    ctx.effect(() => harness.registerTool(ctx, tool))
  },
}
