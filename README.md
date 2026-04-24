# Paraglide Zed LSP

Lightweight Paraglide / inlang language-server support for Zed.

The default experience is intentionally low-configuration:

- Install the Zed extension.
- Open a project with `project.inlang/settings.json` and `messages/{locale}.json`.
- Hover, completion, and diagnostics work without extra LSP settings.
- Translation inline hints only need Zed's generic `show_other_hints` switch.

This project contains two deliverables:

- A Zed extension shell written in Rust and compiled by Zed to WebAssembly.
- A Node.js LSP server published as the npm package `paraglide-zed-lsp`.

The Zed extension does not vendor the language server. At runtime it installs
`paraglide-zed-lsp` through `zed_extension_api::npm_install_package` and starts
`node_modules/paraglide-zed-lsp/dist/src/server.js` with Zed's bundled Node.js.

## Features

- Detects Paraglide message calls using inlang's official
  `@inlang/plugin-m-function-matcher`.
- Supports `m.message_key()` and static bracket access such as
  `m["session.changes_summary.open"]()`.
- Shows all locale values on hover.
- Completes Paraglide message keys after `m.`.
- Reports unknown keys and missing locale translations.
- Shows translation inline hints for the configured display locale.
- Reads the common Paraglide project layout:
  `project.inlang/settings.json` plus `messages/{locale}.json`.

## Quick Start

Install `Paraglide i18n` from Zed's extension gallery.

For hover, completion, and diagnostics, no project settings are required. The
language server automatically uses:

- `baseLocale` from `project.inlang/settings.json`.
- `messages/{locale}.json` or the configured
  `plugin.inlang.messageFormat.pathPattern`.
- Compact inline labels such as `en · Save`.

## Optional Inline Hints

Zed only asks language servers for inline hints when editor-level inlay hints
are enabled. To show Paraglide translation hints, add the smallest useful
project setting:

```json
{
  "inlay_hints": {
    "enabled": true,
    "show_other_hints": true
  }
}
```

If you want translation hints without TypeScript or Svelte type and parameter
hints, use this quieter setting:

```json
{
  "inlay_hints": {
    "enabled": true,
    "show_type_hints": false,
    "show_parameter_hints": false,
    "show_other_hints": true
  }
}
```

For team projects that want automatic extension installation, use:

```json
{
  "auto_install_extensions": {
    "paraglide-i18n": true
  },
  "inlay_hints": {
    "enabled": true,
    "show_other_hints": true
  }
}
```

## AI-assisted Setup

If you prefer not to edit Zed settings by hand, copy this prompt into your AI
coding assistant in the target project:

```text
Please configure this project for the Zed Paraglide i18n extension.

Requirements:
1. Detect whether this repo uses Paraglide/inlang by checking for
   project.inlang/settings.json.
2. Create or update .zed/settings.json.
3. Preserve existing Zed settings.
4. Ensure the Paraglide i18n extension is auto-installed.
5. Enable translation inline hints without enabling noisy type or parameter
   hints.

Use this Zed settings shape:

{
  "auto_install_extensions": {
    "paraglide-i18n": true
  },
  "inlay_hints": {
    "enabled": true,
    "show_type_hints": false,
    "show_parameter_hints": false,
    "show_other_hints": true
  }
}

Do not overwrite unrelated settings. Merge with existing .zed/settings.json if
it exists. After editing, show the final .zed/settings.json and explain what
changed.
```

## Advanced Settings

Most users should not need this section. The defaults are:

```json
{
  "paraglideI18n": {
    "messageFunctionAliases": [],
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
```

Message references use Paraglide's conventional `m` namespace by default:
`m.message_key()`, `m["message.key"]()`, and `m['message.key']()`.

If a project intentionally imports generated messages under another namespace,
add that alias explicitly. The built-in `m` namespace remains enabled:

```json
{
  "lsp": {
    "paraglide-i18n-svelte": {
      "settings": {
        "paraglideI18n": {
          "messageFunctionAliases": ["messages"]
        }
      }
    }
  }
}
```

`displayLocale: "auto"` uses the `baseLocale` from
`project.inlang/settings.json`. You can override it per language server if you
always want a concrete locale:

```json
{
  "lsp": {
    "paraglide-i18n-svelte": {
      "settings": {
        "paraglideI18n": {
          "inlayHints": {
            "displayLocale": "en"
          }
        }
      }
    }
  }
}
```

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

Then submit or update the Zed extension registry entry in
[`zed-industries/extensions`](https://github.com/zed-industries/extensions). The
extension manifest keeps the public extension id `paraglide-i18n`.

## Scope

This MVP intentionally keeps the parser narrow:

- The built-in `m` namespace is parsed by default.
- Explicit `messageFunctionAliases` are supported for namespace-style message imports.
- Static dot and bracket calls are parsed, including `m.key()` and `m["key.with.dots"]()`.
- Dynamic calls, destructuring, and `m[key]` are not parsed.
- Only flat JSON string messages are indexed.
- Message files are read-only.
- Code actions, extraction, and go-to-definition are future work.

## 中文说明

这个版本把用户配置成本压到最低：

- hover、completion、diagnostics 默认零配置可用。
- 翻译 inline hints 只需要开启 Zed 的 `inlay_hints.show_other_hints`。
- 不想手动改 JSON 时，可以复制 `AI-assisted Setup` 提示词交给 AI 工具配置。
- 语言展示默认使用 `project.inlang/settings.json` 的 `baseLocale`，不需要单独配置。

本地调试时使用 `PARAGLIDE_ZED_LSP_SERVER` 指向 `dist/src/server.js`；正式安装
时由 Zed 扩展自动通过 npm 安装并启动。

## License

MIT
