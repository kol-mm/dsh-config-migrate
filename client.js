// dsh-config-migrate — Client half (v3)
// Cordis 动态插件函数体：直接作为动态 Package 的 code.client 使用（return { apply(ctx) {...} }）
// 功能：设置面板「配置迁移」页面（settings.section 槽位）
// v3 变更：导出/导入增加口令输入框（凭据加密）；导入结果展示外部插件依赖缺失警告
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    styles.insert(`
.dshmig-page { display: flex; flex-direction: column; gap: 14px; padding: 18px; max-width: 800px; }
.dshmig-page h2 { margin: 0 0 4px; font-size: 16px; }
.dshmig-card { border: 1px solid var(--color-border, rgba(127,127,127,.35)); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.dshmig-card h3 { margin: 0; font-size: 13px; }
.dshmig-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dshmig-input { flex: 1; min-width: 160px; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--color-border, rgba(127,127,127,.35)); background: var(--color-surface, transparent); color: var(--color-text, inherit); font-size: 13px; }
.dshmig-btn { padding: 7px 16px; border-radius: 8px; border: 1px solid var(--color-border, rgba(127,127,127,.35)); background: var(--color-accent, #4a7dff); color: #fff; font-size: 13px; cursor: pointer; }
.dshmig-btn:disabled { opacity: .55; cursor: default; }
.dshmig-btn.secondary { background: transparent; color: var(--color-text, inherit); }
.dshmig-btn.ghost { background: transparent; border-color: var(--color-accent, #4a7dff); color: var(--color-accent, #4a7dff); }
.dshmig-meta { font-size: 12px; opacity: .8; white-space: pre-wrap; word-break: break-all; }
.dshmig-list { font-size: 12px; max-height: 200px; overflow: auto; border: 1px solid var(--color-border, rgba(127,127,127,.25)); border-radius: 8px; padding: 8px 10px; }
.dshmig-err { color: var(--color-danger, #e5484d); font-size: 12px; white-space: pre-wrap; }
.dshmig-ok { color: var(--color-success, #30a46c); font-size: 12px; white-space: pre-wrap; }
.dshmig-warn { color: var(--color-warning, #f5a524); font-size: 12px; white-space: pre-wrap; }
.dshmig-hint { font-size: 12px; opacity: .7; }
.dshmig-check { display: flex; align-items: center; gap: 6px; font-size: 12px; opacity: .85; }
`)

    function Page() {
      const [home, setHome] = React.useState('')
      const [platform, setPlatform] = React.useState('')
      const [homeOverride, setHomeOverride] = React.useState('')
      const [files, setFiles] = React.useState([])
      const [lastExport, setLastExport] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [result, setResult] = React.useState(null)
      const [exportPath, setExportPath] = React.useState('')
      const [importPath, setImportPath] = React.useState('')
      const [exportPassword, setExportPassword] = React.useState('')
      const [importPassword, setImportPassword] = React.useState('')
      const [skipCredExport, setSkipCredExport] = React.useState(false)
      const [skipCredImport, setSkipCredImport] = React.useState(false)
      const [onlyMissing, setOnlyMissing] = React.useState(false)

      const baseArgs = (extra) => {
        const a = Object.assign({}, extra || {})
        if (homeOverride.trim()) a.home = homeOverride.trim()
        return a
      }

      const refresh = () => {
        host.call('config/status', baseArgs({})).then((v) => {
          if (v && typeof v === 'object' && v.home) setHome(String(v.home))
          if (v && typeof v.platform === 'string' && v.platform) setPlatform(v.platform)
          if (v && Array.isArray(v.files)) setFiles(v.files)
          if (v && v.lastExport) setLastExport(v.lastExport)
        }).catch((e) => setError(String(e && e.message ? e.message : e)))
      }
      React.useEffect(refresh, [])

      const fmt = (r) => {
        if (!r) return ''
        const isDry = !!r.dryRun
        const pre = isDry ? '将' : '已'
        const parts = []
        parts.push(pre + '恢复 ' + (r.restored ? r.restored.length : 0) + ' 个')
        parts.push(pre + '备份 ' + (r.backups ? r.backups.length : 0) + ' 个')
        parts.push('跳过 ' + (r.skipped ? r.skipped.length : 0) + ' 个')
        if (r.binaries) parts.push('二进制 ' + r.binaries + ' 个')
        if (r.links && r.links.length) parts.push('重建插件链接 ' + r.links.length + ' 个')
        if (r.verifyErrors && r.verifyErrors.length) parts.push('校验失败 ' + r.verifyErrors.length + ' 个')
        return parts.join('，')
      }

      const doExport = () => {
        setBusy(true); setError(''); setResult(null)
        const args = baseArgs({ skipCredentials: skipCredExport })
        if (exportPath.trim()) args.path = exportPath.trim()
        if (exportPassword.trim()) args.password = exportPassword.trim()
        host.call('config/export', args).then((v) => {
          if (v && v.bundlePath) setLastExport({ path: v.bundlePath, name: String(v.bundlePath).split(/[\\/]/).pop(), size: 0 })
          setResult({ kind: 'export', text: '导出完成 → ' + v.bundlePath + '\n打包 ' + v.fileCount + ' / ' + v.count + ' 个文件' + (v.binaryCount ? '（含二进制 ' + v.binaryCount + ' 个）' : '') + (v.credentialEncrypted ? '（凭据已加密）' : '') + (v.skipped && v.skipped.length ? '，跳过 ' + v.skipped.length + ' 个' : ''), list: v.skipped })
        }).catch((e) => setError(String(e && e.message ? e.message : e))).finally(() => setBusy(false))
      }

      const doPreviewExport = () => {
        setBusy(true); setError(''); setResult(null)
        const args = baseArgs({ skipCredentials: skipCredExport, dryRun: true })
        if (exportPassword.trim()) args.password = exportPassword.trim()
        host.call('config/export', args).then((v) => {
          const rows = (v.bundledFiles || []).map((f) => f.rel + (f.size ? ' (' + f.size + ' B)' : ''))
          setResult({ kind: 'preview', text: '将打包 ' + (v.bundledFiles || []).length + ' 个文件' + (v.binaryCount ? '（含二进制 ' + v.binaryCount + ' 个）' : '') + (v.skipped && v.skipped.length ? '，跳过 ' + v.skipped.length + ' 个' : ''), list: rows.concat((v.skipped || []).map((s) => s + ' [跳过]')) })
        }).catch((e) => setError(String(e && e.message ? e.message : e))).finally(() => setBusy(false))
      }

      const doPreview = (path) => {
        if (!path || !path.trim()) return
        setBusy(true); setError(''); setResult(null)
        const args = baseArgs({ path: path.trim(), dryRun: true, onlyMissing: onlyMissing, skipCredentials: skipCredImport })
        if (importPassword.trim()) args.password = importPassword.trim()
        host.call('config/import', args).then((v) => {
          setResult({ kind: 'preview', text: '预览（不会写盘）→ ' + fmt(v) + '\n来源：' + path, list: (v.restored || []).concat((v.skipped || []).map((s) => s + ' [跳过]')) })
        }).catch((e) => setError(String(e && e.message ? e.message : e))).finally(() => setBusy(false))
      }

      const doImport = (path) => {
        if (!path || !path.trim()) return
        setBusy(true); setError(''); setResult(null)
        const args = baseArgs({ path: path.trim(), onlyMissing: onlyMissing, skipCredentials: skipCredImport })
        if (importPassword.trim()) args.password = importPassword.trim()
        host.call('config/import', args).then((v) => {
          const warns = []
          if (v.linkErrors && v.linkErrors.length) warns.push(v.linkErrors.length + ' 个插件链接重建失败，可能需要手动 pnpm install')
          if (v.pluginDeps && v.pluginDeps.length) warns.push('外部插件依赖缺失: ' + v.pluginDeps.join(', ') + '（目标设备可能需要 pnpm install）')
          const warn = warns.length ? '\n[警告] ' + warns.join('；') : ''
          setResult({ kind: 'import', text: fmt(v) + warn + '\n来源：' + path + '\n提示：重启 DeepSeek Harness 后配置生效', list: (v.restored || []).concat((v.skipped || []).map((s) => s + ' [跳过]')) })
        }).catch((e) => setError(String(e && e.message ? e.message : e))).finally(() => setBusy(false))
      }

      const doImportLast = () => {
        if (!lastExport) return
        setBusy(true); setError(''); setResult(null)
        const args = baseArgs({ onlyMissing: onlyMissing, skipCredentials: skipCredImport })
        if (importPassword.trim()) args.password = importPassword.trim()
        host.call('config/importLast', args).then((v) => {
          const warns = []
          if (v.linkErrors && v.linkErrors.length) warns.push(v.linkErrors.length + ' 个插件链接重建失败，可能需要手动 pnpm install')
          if (v.pluginDeps && v.pluginDeps.length) warns.push('外部插件依赖缺失: ' + v.pluginDeps.join(', ') + '（目标设备可能需要 pnpm install）')
          const warn = warns.length ? '\n[警告] ' + warns.join('；') : ''
          setResult({ kind: 'import', text: '已一键导入：' + lastExport.path + '\n' + fmt(v) + warn + '\n提示：重启 DeepSeek Harness 后配置生效', list: (v.restored || []).concat((v.skipped || []).map((s) => s + ' [跳过]')) })
        }).catch((e) => setError(String(e && e.message ? e.message : e))).finally(() => setBusy(false))
      }

      return React.createElement('div', { className: 'dshmig-page' },
        React.createElement('h2', null, 'DeepSeek Harness 配置迁移'),
        React.createElement('div', { className: 'dshmig-card' },
          React.createElement('h3', null, '当前配置'),
          React.createElement('div', { className: 'dshmig-meta' }, 'DSH_HOME: ' + (home || '探测中…') + (platform ? '（' + platform + '）' : '')),
          React.createElement('div', { className: 'dshmig-row' },
            React.createElement('input', { className: 'dshmig-input', placeholder: 'DSH_HOME 覆盖（新设备探测失败时填写，如 C:\\Users\\xxx\\.dsh 或 /Users/xxx/.dsh）', value: homeOverride, onChange: (e) => setHomeOverride(e.target.value) }),
          ),
          React.createElement('div', { className: 'dshmig-list' }, files.map((f) => React.createElement('div', { key: f.rel }, f.rel + (f.size ? ' (' + f.size + ' B)' : '')))),
        ),
        React.createElement('div', { className: 'dshmig-card' },
          React.createElement('h3', null, '① 导出配置（打包为 JSON；可选口令加密凭据）'),
          React.createElement('div', { className: 'dshmig-row' },
            React.createElement('input', { className: 'dshmig-input', placeholder: '输出文件路径（留空使用工作区 dsh-config-export.json）', value: exportPath, onChange: (e) => setExportPath(e.target.value) }),
            React.createElement('label', { className: 'dshmig-check' },
              React.createElement('input', { type: 'checkbox', checked: skipCredExport, onChange: (e) => setSkipCredExport(e.target.checked) }),
              '排除凭据',
            ),
          ),
          React.createElement('div', { className: 'dshmig-row' },
            React.createElement('input', { className: 'dshmig-input', type: 'password', placeholder: '口令（可选）：加密 .credentials.yaml', value: exportPassword, onChange: (e) => setExportPassword(e.target.value) }),
            React.createElement('button', { className: 'dshmig-btn secondary', disabled: busy, onClick: doPreviewExport }, '预览'),
            React.createElement('button', { className: 'dshmig-btn', disabled: busy, onClick: doExport }, '导出'),
          ),
          lastExport ? React.createElement('div', { className: 'dshmig-hint' }, '上次导出 / 已发现的备份：' + lastExport.path) : null,
        ),
        React.createElement('div', { className: 'dshmig-card' },
          React.createElement('h3', null, '② 导入配置（跨平台：Windows / macOS / Linux）'),
          React.createElement('div', { className: 'dshmig-row' },
            React.createElement('button', { className: 'dshmig-btn ghost', disabled: busy || !lastExport, onClick: doImportLast }, '一键导入上次导出'),
            React.createElement('label', { className: 'dshmig-check' },
              React.createElement('input', { type: 'checkbox', checked: onlyMissing, onChange: (e) => setOnlyMissing(e.target.checked) }),
              '仅恢复缺失文件',
            ),
            React.createElement('label', { className: 'dshmig-check' },
              React.createElement('input', { type: 'checkbox', checked: skipCredImport, onChange: (e) => setSkipCredImport(e.target.checked) }),
              '排除凭据',
            ),
          ),
          React.createElement('div', { className: 'dshmig-row' },
            React.createElement('input', { className: 'dshmig-input', placeholder: '备份包 JSON 路径', value: importPath, onChange: (e) => setImportPath(e.target.value) }),
            React.createElement('input', { className: 'dshmig-input', type: 'password', placeholder: '口令（若导出时加密过）', value: importPassword, onChange: (e) => setImportPassword(e.target.value) }),
            React.createElement('button', { className: 'dshmig-btn secondary', disabled: busy || !importPath.trim(), onClick: () => doPreview(importPath) }, '预览'),
            React.createElement('button', { className: 'dshmig-btn secondary', disabled: busy || !importPath.trim(), onClick: () => doImport(importPath) }, '导入'),
          ),
          React.createElement('div', { className: 'dshmig-hint' }, '导入覆盖前自动备份为 *.bak-<时间戳>；内容相同的文件自动跳过；二进制资源按平台解码还原；外部插件在 Windows 重建 junction、在 macOS/Linux 重建符号链接；导入时检测外部插件缺失的 npm 依赖。重启后即可用。'),
        ),
        error ? React.createElement('div', { className: 'dshmig-err' }, error) : null,
        result ? React.createElement('div', { className: 'dshmig-card' },
          React.createElement('h3', null, result.kind === 'preview' ? '预览结果' : (result.kind === 'export' ? '导出结果' : '导入结果')),
          React.createElement('div', { className: result.kind === 'preview' ? 'dshmig-meta' : 'dshmig-ok' }, result.text),
          result.list && result.list.length ? React.createElement('div', { className: 'dshmig-list' }, result.list.map((x, i) => React.createElement('div', { key: i }, x))) : null,
        ) : null,
      )
    }

    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'config-migration', order: 30, label: '配置迁移' },
      () => React.createElement(Page, null),
    ))
  },
}
