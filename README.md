# Paraglide Zed LSP

Lightweight Paraglide / inlang language-server support for Zed.

This project contains two deliverables:

- A Zed extension shell written in Rust and compiled by Zed to WebAssembly.
- A Node.js LSP server published as the npm package `paraglide-zed-lsp`.

The Zed extension does not vendor the language server. At runtime it installs
`paraglide-zed-lsp` through `zed_extension_api::npm_install_package` and starts
`node_modules/paraglide-zed-lsp/dist/src/server.js` with Zed's bundled Node.js.

## Features

- Detects `m.message_key()` calls.
- Shows all locale values on hover.
- Completes Paraglide message keys after `m.`.
- Reports unknown keys and missing locale translations.
- Shows translation inlay hints for the configured display locale.
- Reads the common Paraglide project layout:
  `project.inlang/settings.json` plus `messages/{locale}.json`.

## Zed Configuration

The extension registers three language servers:

- `paraglide-i18n-svelte`
- `paraglide-i18n-typescript`
- `paraglide-i18n-javascript`

If Zed does not enable the additional language server automatically, add it in
your user or project `settings.json`:

```json
{
  "languages": {
    "Svelte": {
      "language_servers": ["...", "paraglide-i18n-svelte"]
    },
    "TypeScript": {
      "language_servers": ["...", "paraglide-i18n-typescript"]
    },
    "JavaScript": {
      "language_servers": ["...", "paraglide-i18n-javascript"]
    }
  }
}
```

Inlay hints can be configured through Zed's LSP settings:

```json
{
  "lsp": {
    "paraglide-i18n-svelte": {
      "settings": {
        "paraglideI18n": {
          "inlayHints": {
            "enabled": true,
            "displayLocale": "auto",
            "format": "compact",
            "maxLength": 80,
            "showExisting": true,
            "showMissing": true
          }
        }
      }
    }
  }
}
```

`displayLocale: "auto"` uses the `baseLocale` from
`project.inlang/settings.json`. You can also set a concrete locale such as
`"en"` or `"zh"`.

If you restrict Zed extension capabilities globally, allow this npm package:

```json
{
  "granted_extension_capabilities": [
    { "kind": "npm:install", "package": "paraglide-zed-lsp" }
  ]
}
```

## Local Development

Install dependencies and run the verification suite:

```bash
bun install
bun run check
bun run test
bun run smoke
cargo check
cargo check --target wasm32-wasip2
```

For local Zed development, build the TypeScript server and point the extension at
that local server:

```bash
bun run build
PARAGLIDE_ZED_LSP_SERVER=/absolute/path/to/paraglide-zed-lsp/dist/src/server.js zed .
```

Then run `zed: install dev extension` in Zed and select this repository.

`bun run zed:sync` remains available as a local helper for copying a built dev
extension into Zed's work directory. It is not part of the published extension
runtime.

## Publishing

Publish the npm package first:

```bash
bun install
npm pack --dry-run
npm publish
```

Then submit the Zed extension repository to
[`zed-industries/extensions`](https://github.com/zed-industries/extensions). The
extension manifest keeps the public extension id `paraglide-i18n`.

## Scope

This MVP intentionally keeps the parser narrow:

- Only `m.key()` calls are parsed.
- Dynamic calls, aliases, destructuring, and `m[key]` are not parsed.
- Only flat JSON string messages are indexed.
- Message files are read-only.
- Code actions, extraction, and go-to-definition are future work.

## 中文说明

这个仓库现在按可开源发布形态组织：Zed 扩展本身只负责安装并启动 npm 包
`paraglide-zed-lsp`，不会把 TypeScript LSP server 直接打进扩展产物里。

本地调试时使用 `PARAGLIDE_ZED_LSP_SERVER` 指向 `dist/src/server.js`；正式安装
时由 Zed 扩展自动通过 npm 安装并启动。

## License

MIT
