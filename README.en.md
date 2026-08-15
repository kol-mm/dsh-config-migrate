# dsh-config-migrate

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Syntax](https://github.com/kol-mm/dsh-config-migrate/actions/workflows/syntax-check.yml/badge.svg)

A DeepSeek Harness config migration plugin — one-click export/import of the `${DSH_HOME}` configuration (settings, credentials, profiles, external plugins, agent presets). Cross-platform: **Windows / macOS / Linux**. Built for zero-friction setup on a new machine.

## Features

### Export (`export`)
- Packs the configuration under `${DSH_HOME}`:
  - Top-level: `settings.yaml`, `settings.yaml.bak`, `.credentials.yaml`, `.anonymous-user-id`
  - Directories: `profiles/**`, `external-plugins/**`, `.agent-presets/**`
  - Auto-excludes: `node_modules`, `sessions`, `storages`, `.git` (config only, no data)
- Text files stored as UTF-8; **binary assets (images etc.) packed as base64**, reported in the result
- **Absolute `link:` paths** in `profiles/*/package.json` pointing at `external-plugins` are **rewritten to relative paths** (`link:../../external-plugins/<name>`) — portable across machines
- **Credential encryption**: pass `password` to encrypt `.credentials.yaml` with **AES-256-GCM + scrypt** (node crypto); result reports "credentials encrypted"
- **Dependency detection**: scans `external-plugins/*/package.json`, records non-DSH npm deps into `pluginDeps`, warns before import
- Options: skip credentials (`skipCredentials`), custom output path, `dryRun` preview

### Import (`import` / `importLast`)
- **Auto-discovers bundles**: scans the workspace for `dsh-config-export*.json` on start, or reads the remembered path from `.dshmig-state.json`
- **One-click import** (`importLast`): restores the latest export without typing a path
- Identical files skipped automatically; overwritten files backed up as `*.bak-<timestamp>`
- **Post-write verification**: text re-read comparison, binary byte-count check; failures go to `verifyErrors`
- **Encrypted credentials decrypted** with `password`; wrong password is rejected explicitly (never silently decodes garbage)
- **External plugins restored automatically**:
  - `external-plugins/**` restored (including binary assets)
  - `node_modules/@dsh-external/<name>` links rebuilt: **junction** on Windows, **symlink** on macOS/Linux
  - Link failures go to `linkErrors` with a hint (may need `pnpm install` on the target)
- **v1/v2 bundle compat**: old bundles with absolute link paths are relativized on import
- Options: only restore missing files (`onlyMissing`), skip credentials, `dryRun` preview

## Bundle format example

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

## Usage

### As a dynamic plugin (fastest)
Load `host.js` / `client.js` through the Cordis dynamic-plugin mechanism in a DeepSeek Harness session (see "Code layout"). Then:
- **Settings panel**: Settings → "配置迁移" (Config Migration) page — export/import/preview, DSH_HOME override, credentials & only-missing options, password encryption
- **Model tool**: `dsh_config_migrate` (action: status/export/import/importLast)

### As an external plugin
Place this repo under `${DSH_HOME}/external-plugins/` and reference it in a profile's package.json (see how `@dsh-external` links work).

## Code layout

| File | Description |
| --- | --- |
| `host.js` | Host half: RPC handlers (config/status, config/export, config/import, config/importLast) + dynamic tool `dsh_config_migrate` |
| `client.js` | Client half: "Config Migration" settings-page UI (`settings.section` slot) |
| `test/core.test.mjs` | 27 pure-logic unit tests (no DSH runtime needed): base64, utf8 detection, link relativization, path safety, AES roundtrip, junction/symlink, binary decode |
| `.github/workflows/syntax-check.yml` | CI on **ubuntu / windows / macos**: `new Function()` syntax check + unit tests |

Both JS files are Cordis plugin function bodies (`return { apply(ctx) { ... } }`); use them directly as a dynamic Package's `code.host` / `code.client`.

## Cross-platform notes

- No `process.platform` in the sandbox: platform is inferred from the path (drive prefix / backslash → Windows, else Unix)
- Path separators chosen per target platform
- Binary decode and link creation both use **node** (`subprocess` may lack `powershell.exe`/`openssl`): `Buffer.from(base64)`, `fs.symlinkSync(type: junction|dir)`
- Credential encryption uses node `crypto` (AES-256-GCM + scrypt)
- The bundle itself is platform-independent: export on Windows → import on Mac/Linux and vice versa

> Note: node subprocesses on Windows can mis-resolve paths containing non-ASCII characters. Keep the workspace path ASCII when running imports that create junctions; the target `${DSH_HOME}` is normally unaffected.

## Security

- Export **includes credentials** by default; use `password` to encrypt or `skipCredentials` to exclude
- Encrypted entries are `encoding: "encrypted"` — unreadable without the password; wrong passwords are rejected on import
- Import writes to `${DSH_HOME}` (outside the session workspace) with full access; the UI says so explicitly
- Path safety: `..` / absolute / drive-prefix escapes are rejected (unit-tested)

## License

[MIT](LICENSE)
