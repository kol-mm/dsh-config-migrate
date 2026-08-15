# dsh-config-migrate

DeepSeek Harness 配置迁移插件 —— 一键导出/导入 `${DSH_HOME}` 配置（settings、凭据、profiles、external-plugins、agent presets），跨平台支持 **Windows / macOS / Linux**，专为「换新设备零折腾」设计。

## 功能

### 导出（export）
- 打包 `${DSH_HOME}` 下的配置：
  - 顶层：`settings.yaml`、`settings.yaml.bak`、`.credentials.yaml`、`.anonymous-user-id`
  - 目录：`profiles/**`、`external-plugins/**`、`.agent-presets/**`
  - 自动排除：`node_modules`、`sessions`、`storages`、`.git`
- 文本文件 UTF-8 直存；**二进制资源（图片等）以 base64 打包**，导出结果报告二进制数量
- `profiles/*/package.json` 里指向 `external-plugins` 的**绝对 link: 路径自动改写为相对路径**（`link:../../external-plugins/<名>`），跨机器有效
- 可选：排除凭据（`skipCredentials`）、自定义输出路径、`dryRun` 预览清单

### 导入（import / importLast）
- **自动发现备份包**：启动时扫描工作区 `dsh-config-export*.json`，或读取 `.dshmig-state.json` 记住的自定义导出路径
- **一键导入**（`importLast`）：直接恢复上次导出的备份，无需填路径
- 内容相同的文件自动跳过；覆盖前备份为 `*.bak-<时间戳>`
- **写回后校验**：文本回读比对、二进制校验字节数，失败进 `verifyErrors` 报告
- **外部插件自动恢复**：
  - 还原 `external-plugins/**`（含二进制资源）
  - 重建 `node_modules/@dsh-external/<名>` 链接：Windows 用 **junction**，macOS/Linux 用**符号链接**
  - 链接失败进 `linkErrors` 并提示（可能需要在新设备 `pnpm install`）
- 可选：仅恢复缺失文件（`onlyMissing`）、排除凭据、`dryRun` 预览

## 使用方式

### 方式一：动态插件（推荐快速体验）
在 DeepSeek Harness 会话中通过 Cordis 动态插件机制加载 `host.js` / `client.js`（见下文「代码结构」），运行后：
- **设置面板**：设置 → 「配置迁移」页面，含导出/导入/预览、DSH_HOME 覆盖、凭据与仅缺失选项
- **模型工具**：`dsh_config_migrate`（action: status/export/import/importLast）

### 方式二：作为外部插件部署
将本仓库放入 `${DSH_HOME}/external-plugins/` 并在 profile 的 package.json 中引用（参考 `@dsh-external` 的链接方式）。

## 代码结构

| 文件 | 说明 |
| --- | --- |
| `host.js` | Host half：RPC handlers（config/status、config/export、config/import、config/importLast）+ 动态工具 `dsh_config_migrate` |
| `client.js` | Client half：设置页「配置迁移」UI（`settings.section` 槽位） |

两个文件均为 Cordis 插件函数体（`return { apply(ctx) { ... } }`），可直接作为动态 Package 的 `code.host` / `code.client` 加载。

## 跨平台实现要点

- 无 `process.platform` 可用（沙箱），平台由路径推断：含盘符/反斜杠 → Windows，否则 Unix
- 路径分隔符按目标平台自动选择
- 二进制写回：Windows 用 PowerShell `FromBase64String`；Unix 用 `openssl base64 -d` → `base64 -D` → `base64 -d` 三级回退
- 插件链接：Windows 建 junction，Unix 建 `ln -sfn` 符号链接
- 迁移包本身平台无关：Windows 导出 → Mac/Linux 导入均可

## 安全说明

- 导出默认**包含凭据**（`.credentials.yaml`），请妥善保管备份包；可用 `skipCredentials` 排除
- 导入写回 `${DSH_HOME}`（会话工作区之外）使用完整访问权限，界面有明确提示
- 路径安全：拒绝 `..` / 绝对路径逃逸条目

## License

MIT
