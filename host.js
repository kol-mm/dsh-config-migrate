// dsh-config-migrate — Host half (v3)
// Cordis 动态插件函数体：直接作为动态 Package 的 code.host 使用（return { apply(ctx) {...} }）
// 功能：config/status、config/export、config/import、config/importLast RPC + 动态工具 dsh_config_migrate
// v3 变更：凭据 AES-256-GCM 加密（node）、外部插件依赖检测、v1/v2 兼容（导入时相对化 link）、
//          二进制/链接操作统一走 node（harness 子进程中 powershell/openssl 不可用）
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
      const s = String(rel)
      if (!s) return null
      if (/^[A-Za-z]:/.test(s)) return null // windows drive prefix
      if (s.startsWith('/') || s.startsWith('\\')) return null // absolute
      const parts = s.split('/')
      for (const p of parts) {
        if (!p || p === '.' || p === '..' || p.indexOf('\\') !== -1) return null
      }
      return parts.join('/')
    }

    async function runNode(script, args, input, cwd) {
      if (subprocess === undefined) return { ok: false, error: 'subprocess 服务不可用' }
      try {
        const argv = ['node', '-e', script].concat(args || [])
        const handle = subprocess.spawn({
          argv,
          cwd: cwd || wsRoot || '.',
          stdio: {
            stdin: input !== undefined ? { data: input } : 'ignore',
            stdout: { maxBytes: 262144 },
            stderr: { maxBytes: 262144 },
          },
          graceMs: 120000,
        })
        const outcome = await handle.done
        const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
        const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
        return { ok: outcome.exitCode === 0, exitCode: outcome.exitCode, out, err }
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) }
      }
    }

    const CRED_SCRIPT = [
      'const crypto=require("crypto");',
      'const mode=process.argv[1];',
      'const pass=process.argv[2];',
      'let chunks=[];',
      'process.stdin.on("data",c=>chunks.push(c));',
      'process.stdin.on("end",()=>{',
      '  const buf=Buffer.concat(chunks);',
      '  if(mode==="enc"){',
      '    const salt=crypto.randomBytes(16);',
      '    const key=crypto.scryptSync(pass,salt,32);',
      '    const iv=crypto.randomBytes(12);',
      '    const c=crypto.createCipheriv("aes-256-gcm",key,iv);',
      '    const enc=Buffer.concat([c.update(buf),c.final()]);',
      '    process.stdout.write(JSON.stringify({salt:salt.toString("base64"),iv:iv.toString("base64"),tag:c.getAuthTag().toString("base64"),data:enc.toString("base64")}));',
      '  } else if(mode==="dec"){',
      '    const j=JSON.parse(buf.toString("utf8"));',
      '    const key=crypto.scryptSync(pass,Buffer.from(j.salt,"base64"),32);',
      '    const d=crypto.createDecipheriv("aes-256-gcm",key,Buffer.from(j.iv,"base64"));',
      '    d.setAuthTag(Buffer.from(j.tag,"base64"));',
      '    try{const plain=Buffer.concat([d.update(Buffer.from(j.data,"base64")),d.final()]);process.stdout.write(plain.toString("utf8"));}',
      '    catch(e){process.exit(3);}',
      '  } else { process.exit(2); }',
      '});',
    ].join('\n')

    async function encryptCredential(text, password) {
      const r = await runNode(CRED_SCRIPT, ['enc', password], text)
      if (!r.ok) throw new Error('凭据加密失败: ' + (r.error || r.err || r.exitCode))
      return JSON.parse(r.out)
    }
    async function decryptCredential(payload, password) {
      const r = await runNode(CRED_SCRIPT, ['dec', password], JSON.stringify(payload))
      if (!r.ok) {
        if (r.exitCode === 3) throw new Error('口令错误或数据损坏')
        throw new Error('凭据解密失败: ' + (r.error || r.err || r.exitCode))
      }
      return r.out
    }

    const BIN_SCRIPT = [
      'const fs=require("fs");',
      'const b64=fs.readFileSync(process.argv[1],"utf8");',
      'fs.writeFileSync(process.argv[2],Buffer.from(b64.replace(/\\s/g,""),"base64"));',
      'fs.unlinkSync(process.argv[1]);',
    ].join('\n')
    async function decodeBase64File(tmpPath, abs) {
      const r = await runNode(BIN_SCRIPT, [tmpPath, abs])
      return r.ok ? r : { ok: false, error: r.error || r.err || ('exit ' + r.exitCode) }
    }

    const LINK_SCRIPT = [
      'const fs=require("fs");',
      'const path=require("path");',
      'const link=process.argv[1];',
      'const target=process.argv[2];',
      'const win=/^[A-Za-z]:|\\\\/.test(target);',
      'fs.mkdirSync(path.dirname(link),{recursive:true});',
      'try{fs.rmSync(link,{recursive:true,force:true});}catch(e){}',
      'fs.symlinkSync(target,link,win?"junction":"dir");',
    ].join('\n')
    async function linkExternalPlugin(linkPath, target) {
      const r = await runNode(LINK_SCRIPT, [linkPath, target])
      return r.ok ? r : { ok: false, error: r.error || r.err || ('exit ' + r.exitCode) }
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

    async function collectPluginDeps(home) {
      const pluginRoot = joinBase(home, 'external-plugins')
      let entries
      try { entries = await fs.listDir(await fs.resolve(pluginRoot)) } catch (e) { return [] }
      const missing = []
      for (const e of entries) {
        if (e.type !== 'directory') continue
        const pkgPath = joinBase(pluginRoot, e.name + '/package.json')
        let text
        try { text = await fs.readText(await fs.resolve(pkgPath)) } catch (err) { continue }
        let pkg
        try { pkg = JSON.parse(text) } catch (err) { continue }
        const deps = Object.assign({}, pkg.dependencies || {}, pkg.peerDependencies || {})
        for (const name of Object.keys(deps)) {
          if (name.indexOf('@deepseek-ai/') === 0 || name === '@dsh-external') continue
          missing.push(name)
        }
      }
      return Array.from(new Set(missing))
    }

    async function exportBundle(args) {
      const opts = args || {}
      const home = await resolveHome(args)
      const files = await collect(home, opts)
      const maxBytes = (opts.maxFileBytes && typeof opts.maxFileBytes === 'number') ? opts.maxFileBytes : MAX_FILE_BYTES
      const bundle = {
        format: 'dsh-config-migration',
        version: 3,
        exportedAt: new Date().toISOString(),
        sourceHome: home,
        platform: platformName(home),
        files: {},
      }
      const skipped = []
      let binaryCount = 0
      let total = 0
      let credentialEncrypted = false
      const password = typeof opts.password === 'string' && opts.password ? opts.password : null
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
          let content = text
          if (f.rel === '.credentials.yaml' && password) {
            try {
              const enc = await encryptCredential(text, password)
              bundle.files[f.rel] = { encoding: 'encrypted', payload: enc }
              credentialEncrypted = true
              total += JSON.stringify(enc).length
              continue
            } catch (e) {
              skipped.push(f.rel + ' (加密失败: ' + e.message + ')'); continue
            }
          }
          if (f.rel.indexOf('profiles/') === 0 && basename(f.rel) === 'package.json') {
            content = relativizeLinks(text)
          }
          bundle.files[f.rel] = { encoding: 'utf8', content }
          total += content.length
        } else {
          bundle.files[f.rel] = { encoding: 'base64', content: bytesToBase64(bytes) }
          binaryCount += 1
          total += bytes.length
        }
      }
      const bundledFiles = Object.keys(bundle.files).map((rel) => ({ rel, size: JSON.stringify(bundle.files[rel]).length }))
      const dryRun = !!opts.dryRun
      if (dryRun) {
        return {
          dryRun: true,
          count: files.length,
          fileCount: bundledFiles.length,
          binaryCount,
          credentialEncrypted,
          skipped,
          bundledFiles,
        }
      }
      bundle.pluginDeps = await collectPluginDeps(home)
      const outPath = typeof opts.path === 'string' && opts.path
        ? String(opts.path)
        : joinBase(wsRoot || home, 'dsh-config-export.json')
      const out = await fs.resolve(outPath)
      await fs.writeText(out, JSON.stringify(bundle, null, 2))
      lastExport = { path: outPath, name: basename(outPath), size: total }
      await saveState(outPath)
      return {
        bundlePath: outPath,
        version: 3,
        count: files.length,
        fileCount: bundledFiles.length,
        binaryCount,
        credentialEncrypted,
        pluginDeps: bundle.pluginDeps,
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
      const password = typeof opts.password === 'string' && opts.password ? opts.password : null
      const policy = sandboxPolicy ? { mode: 'danger-full-access', workspaceRoot: sandboxPolicy.workspaceRoot } : undefined
      const restored = []
      const backups = []
      const skipped = []
      const verifyErrors = []
      let binaries = 0
      let decryptedCred = false
      for (const rel of Object.keys(bundle.files)) {
        const safe = safeRel(rel)
        const entry = bundle.files[rel]
        if (!safe || !entry || typeof entry.content !== 'string' && typeof entry.payload !== 'object') { skipped.push(rel + ' (非法条目)'); continue }
        if (shouldSkip(rel, opts)) { skipped.push(rel + ' (已排除)'); continue }
        const abs = joinBase(home, safe)
        const target = await fs.resolve(abs)
        const existing = await fs.stat(target).catch(() => undefined)
        const encoding = entry.encoding === 'encrypted' ? 'encrypted' : (entry.encoding === 'base64' ? 'base64' : 'utf8')
        let content = entry.content
        if (encoding === 'encrypted') {
          if (!password) { skipped.push(rel + ' (已加密，需要口令)'); continue }
          try {
            content = await decryptCredential(entry.payload, password)
            decryptedCred = true
          } catch (e) {
            skipped.push(rel + ' (' + e.message + ')'); continue
          }
        }
        if (encoding === 'utf8' && rel.indexOf('profiles/') === 0 && basename(rel) === 'package.json') {
          content = relativizeLinks(content)
        }
        if (existing && existing.type === 'file') {
          if (onlyMissing) { skipped.push(rel + ' (已存在，仅恢复缺失)'); continue }
          let same = false
          if (encoding === 'utf8') {
            try { same = (await fs.readText(target)) === content } catch (e) { same = false }
          } else if (encoding === 'base64') {
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
            const r = await decodeBase64File(tmpPath, abs)
            if (!r.ok) { skipped.push(rel + ' (二进制写入失败: ' + r.error + ')'); continue }
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
          await fs.writeText(target, content, undefined, undefined, policy)
          if (encoding === 'utf8') {
            try {
              const back = await fs.readText(target)
              if (back !== content) verifyErrors.push(rel + ' (内容不一致)')
            } catch (e) { verifyErrors.push(rel + ' (回读失败)') }
          }
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
          const r = await linkExternalPlugin(linkPath, target)
          if (r.ok) links.push(pkgName + ' → ' + linkPath)
          else linkErrors.push(pkgName + ' (' + r.error + ')')
        }
      }
      return { home, dryRun, restored, backups, skipped, binaries, links, predictedLinks, linkErrors, verifyErrors, pluginDeps: Array.isArray(bundle.pluginDeps) ? bundle.pluginDeps : [], decryptedCred }
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
      description: '导出/导入 DeepSeek Harness 配置（${DSH_HOME} 下的 settings.yaml、.credentials.yaml、profiles、external-plugins 与 .agent-presets），跨平台支持 Windows / macOS / Linux。导出以 base64 打包二进制资源，把 profiles/*/package.json 里指向 external-plugins 的绝对 link: 改写为相对路径，可用 password 对 .credentials.yaml 做 AES-256-GCM 加密，并检测外部插件缺失的 npm 依赖；导入时内容相同的文件自动跳过、覆盖前备份为 *.bak-<时间戳>、写回后校验、按平台重建外部插件链接（Windows junction / Unix 符号链接）、检测到加密凭据时用 password 解密、兼容 v1/v2 旧包（自动相对化 link）。action=status 列出配置清单；action=export 打包为 JSON（path 指定输出文件，缺省写入工作区 dsh-config-export.json；dryRun=true 只返回清单不写盘；skipCredentials 排除 .credentials.yaml；password 加密凭据）；action=import 从 path 指向的备份包恢复（dryRun=true 只预览；onlyMissing=true 仅恢复缺失文件；skipCredentials 排除凭据；password 解密）；action=importLast 一键导入本会话/工作区发现的最新备份。home 可选，缺省自动探测 DSH_HOME。',
      parameters: {
        action: { type: 'string', enum: ['status', 'export', 'import', 'importLast'], required: true, description: '要执行的操作' },
        path: { type: 'string', description: 'export 的输出文件路径，或 import 的备份包路径' },
        home: { type: 'string', description: '可选：DSH_HOME 绝对路径，缺省自动探测' },
        dryRun: { type: 'boolean', description: 'export/import 只预览，不写盘' },
        onlyMissing: { type: 'boolean', description: 'import 时仅恢复目标不存在的文件' },
        skipCredentials: { type: 'boolean', description: '排除 .credentials.yaml 凭据文件' },
        password: { type: 'string', description: 'export 时加密凭据 / import 时解密凭据的口令' },
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
