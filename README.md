# dsh-config-migrate

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Syntax](https://github.com/kol-mm/dsh-config-migrate/actions/workflows/syntax-check.yml/badge.svg)

DeepSeek Harness 配置迁移插件 —— 一键导出/导入 `${DSH_HOME}` 配置（settings、凭据、profiles、external-plugins、agent presets），跨平台支持 **Windows / macOS / Linux**，专为「换新设备零折腾」设计。

## 功能

### 导出（export）
- 打包 `${DSH_HOME}` 下的配置：
  - 顶层：`settings.yaml`、`settings.yaml.bak`、`.credentials.yaml`、`.anonymous-user-id`
  - 目录：`profiles/**`、`external-plugins/**`、`.agent-presets/**`
  - 自动排除：`node_modules`、`sessions`、`storages`、`.git`
- 文本文件 UTF-8 直存；**二进制资源（图片等）以 base64 打包**，导出结果报告二进制数量
- `profiles/*/package.json` 里指向 `external-plugins` 的**绝对 link: 路径自动改写为相对路径**（`link:../../external-plugins/<名>`），跨机器有效
- **凭据加密**：可指定 `password`，对 `.credentials.yaml` 用 **AES-256-GCM + scrypt** 加密（node crypto），导出结果显示「凭据已加密」
- **依赖检测**：扫描 `external-plugins/*/package.json`，识别 DSH 不自带的 npm 依赖写入 `pluginDeps`，导入前预警
- 可选：排除凭据（`skipCredentials`）、自定义输出路径、`dryRun` 预览清单

### 导入（import / importLast）
- **自动发现备份包**：启动时扫描工作区 `dsh-config-export*.json`，或读取 `.dshmig-state.json` 记住的自定义导出路径
- **一键导入**（`importLast`）：直接恢复上次导出的备份，无需填路径
- 内容相同的文件自动跳过；覆盖前备份为 `*.bak-<时间戳>`
- **写回后校验**：文本回读比对、二进制校验字节数，失败进 `verifyErrors` 报告
- **加密凭据解密**：检测到 `encrypted` 条目时用 `password` 解密；口令错误明确拒绝（不静默出垃圾数据）
- **外部插件自动恢复**：
  - 还原 `external-plugins/**`（含二进制资源）
  - 重建 `node_modules/@dsh-external/<名>` 链接：Windows 用 **junction**，macOS/Linux 用**符号链接**
  - 链接失败进 `linkErrors` 并提示（可能需要在新设备 `pnpm install`）
- **v1/v2 兼容**：旧备份包（link 为绝对路径）在导入时自动相对化
- 可选：仅恢复缺失文件（`onlyMissing`）、排除凭据、`dryRun` 预览

## 导出包结构示例

```json
{
  "format": "dsh-config-migration",
  "version": 3,
  "exportedAt": "2026-08-15T08:00:00.000Z",
  "sourceHome": "C:\\Users\\xxx\\.dsh",
  "platform": "Windows",
  "pluginDeps": ["axios"],
  "files": {
    "settings.yaml":                       { "encoding": "utf8",    "content": "ui-onboarding: ..." },
    ".credentials.yaml":                   { "encoding": "encrypted", "payload": { "salt": "...", "iv": "...", "tag": "...", "data": "..." } },
    "profiles/web/package.json":           { "encoding": "utf8",    "content": "{ ... \"link:../../external-plugins/...\" ... }" },
    "external-plugins/.../assets/x.webp":  { "encoding": "base64",  "content": "UklGRi4B..." }
  }
}
```

## 使用方式

### 方式一：动态插件（推荐快速体验）
在 DeepSeek Harness 会话中通过 Cordis 动态插件机制加载 `host.js` / `client.js`（见「代码结构」），运行后：
- **设置面板**：设置 → 「配置迁移」页面，含导出/导入/预览、DSH_HOME 覆盖、凭据与仅缺失选项、口令加密
- **模型工具**：`dsh_config_migrate`（action: status/export/import/importLast）

### 方式二：作为外部插件部署
将本仓库放入 `${DSH_HOME}/external-plugins/` 并在 profile 的 package.json 中引用（参考 `@dsh-external` 的链接方式）。

## 代码结构

| 文件 | 说明 |
| --- | --- |
| `host.js` | Host half：RPC handlers（config/status、config/export、config/import、config/importLast）+ 动态工具 `dsh_config_migrate` |
| `client.js` | Client half：设置页「配置迁移」UI（`settings.section` 槽位） |
| `.github/workflows/syntax-check.yml` | CI：`new Function()` 包裹校验两个函数体的语法 + package.json 合法性 |

两个 JS 文件均为 Cordis 插件函数体（`return { apply(ctx) { ... } }`），可直接作为动态 Package 的 `code.host` / `code.client` 加载。

## 跨平台实现要点

- 无 `process.platform` 可用（沙箱），平台由路径推断：含盘符/反斜杠 → Windows，否则 Unix
- 路径分隔符按目标平台自动选择
- 二进制写回与链接重建统一走 **node**（`subprocess` 中 `powershell.exe`/`openssl` 不一定可用）：`Buffer.from(base64)` 解码、`fs.symlinkSync(type: junction|dir)` 建链接
- 凭据加密/解密用 node `crypto`（AES-256-GCM + scrypt）
- 迁移包本身平台无关：Windows 导出 → Mac/Linux 导入均可

## 安全说明

- 导出默认**包含凭据**（`.credentials.yaml`）；可用 `password` 加密或 `skipCredentials` 排除
- 加密条目为 `encoding: "encrypted"`，无口令无法读取；口令错误导入会被明确拒绝
- 导入写回 `${DSH_HOME}`（会话工作区之外）使用完整访问权限，界面有明确提示
- 路径安全：拒绝 `..` / 绝对路径逃逸条目

## License

[MIT](LICENSE)
