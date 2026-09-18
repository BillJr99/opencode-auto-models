# opencode-auto-models

An [opencode](https://opencode.ai/) plugin that automatically discovers available
models from OpenAI-compatible providers, so you don't have to maintain a manual
`models` block in your `opencode.json`.

## Features

- **Auto-discovery**: calls `GET {baseURL}/models` for every eligible provider
  and fills the `models` map.
- **Manual overrides preserved**: if you already define a model with extra
  metadata (modalities, context limits, etc.), the discovered defaults are
  merged underneath it.
- **Universal**: works with any provider that uses the
  [`@ai-sdk/openai-compatible`](https://www.npmjs.com/package/@ai-sdk/openai-compatible)
  driver, or any provider explicitly opted in with `autoModels: true`.
- **Dependency-free plain JavaScript**: a single file with no imports and no
  build step, so it loads anywhere opencode runs, including the Windows desktop
  app.
- **Loud about failures**: every provider it skips, and every reason, is logged.
  A plugin that quietly does nothing is indistinguishable from one that is not
  installed, which is the failure mode this is built to avoid.
- **Safe defaults**: requests time out and are retried once, so a slow provider
  cannot hang opencode startup, and one failing provider cannot affect another.

## Installation

### Option 1 — Copy the file (recommended, works everywhere)

The plugin is one dependency-free JavaScript file. Copying it needs no package
manager, no `git`, and no TypeScript loader:

```bash
# Global, macOS/Linux
mkdir -p ~/.config/opencode/plugins
cp src/index.js ~/.config/opencode/plugins/auto-models.js

# Project-local
mkdir -p .opencode/plugins
cp src/index.js .opencode/plugins/auto-models.js
```

On Windows, copy it to `C:\Users\<You>\.config\opencode\plugins\auto-models.js`.

Files in these directories are loaded automatically at startup.

### Option 2 — Install from git

```json
{
  "plugin": [
    "git+https://github.com/BillJr99/opencode-auto-models.git"
  ]
}
```

opencode resolves this by installing the package at startup, which requires a
working `git` binary in the environment opencode itself runs in. That is not
always the environment your shell has, so if the plugin appears in your config
but never runs, prefer Option 1 and check
`~/.cache/opencode/packages/` to see whether the install actually produced
anything.

## Usage

Define a provider that uses the OpenAI-compatible driver and leave the `models`
block out entirely:

```json
{
  "provider": {
    "my-provider": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "My Provider",
      "options": {
        "baseURL": "https://api.example.com/v1",
        "apiKey": "{env:MY_PROVIDER_API_KEY}"
      }
    }
  }
}
```

On startup the plugin fetches the model list and populates `models` for you.

To keep manual overrides for specific models *and* still discover the rest, set
`autoModels: true`. Without it, a provider that already defines any models is
left alone:

```json
{
  "provider": {
    "my-provider": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "My Provider",
      "options": {
        "baseURL": "https://api.example.com/v1",
        "apiKey": "{env:MY_PROVIDER_API_KEY}",
        "autoModels": true
      },
      "models": {
        "kimi-k2.7-code-fast": {
          "name": "kimi-k2.7-code-fast",
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "limit": { "context": 262144, "output": 16000 }
        }
      }
    }
  }
}
```

The plugin discovers all other models and merges your metadata on top of the
discovered defaults.

## Provider options

Set these inside `provider.options`:

| Option | Default | Description |
|--------|---------|-------------|
| `autoModels` | `true` for `@ai-sdk/openai-compatible`, otherwise `false` | Whether to auto-discover models for this provider. `false` disables it; `true` both opts a non-openai-compatible provider in and allows discovery alongside a manual `models` block. |
| `baseURL` | — | The OpenAI-compatible API base URL (normally ends with `/v1`). |
| `apiKey` | — | API key used for the `Authorization: Bearer` header. |
| `autoModelsContext` | `128000` | Default context limit for every auto-discovered model of this provider. |
| `autoModelsOutput` | `16384` | Default output limit for every auto-discovered model of this provider. |
| `autoModelsInclude` | — | Case-insensitive regex; only matching model IDs are kept. |
| `autoModelsExclude` | — | Case-insensitive regex; matching model IDs are dropped. |
| `modelLimits` | — | Per-provider regex-based model limits (see [Model context limits](#model-context-limits)). |

Both `baseURL` and `apiKey` must be present in the config for a provider to be
eligible. Credentials stored by `opencode auth login` live in `auth.json` and are
**not** visible to this plugin, so a provider authenticated that way is skipped.

## Plugin options

If you load the plugin via the `plugin` array, you can pass options:

```json
{
  "plugin": [
    ["git+https://github.com/BillJr99/opencode-auto-models.git", {
      "timeout": 10000,
      "modelLimits": [
        { "pattern": "kimi-k2\\.[567]", "context": 262144, "output": 32768 }
      ]
    }]
  ]
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `timeout` | `8000` | Request timeout in milliseconds for `GET /models`. |
| `retries` | `1` | Retry attempts after an initial failure. |
| `retryDelayMs` | `1000` | Base delay between retries; backs off linearly. |
| `dryRun` | `false` | Log what would be fetched without mutating the config. |
| `defaultContext` | `128000` | Fallback context limit for auto-discovered models. |
| `defaultOutput` | `16384` | Fallback output limit for auto-discovered models. |
| `modelLimits` | — | Global regex-based model limits (see below). |

## How it works

When opencode loads the config, the plugin's `config` hook runs. A provider is
eligible when it:

1. uses `npm: "@ai-sdk/openai-compatible"` (or has `options.autoModels: true`),
2. has both `options.baseURL` and `options.apiKey`,
3. has no manual `models` block (or has `options.autoModels: true`).

Eligible providers are fetched in parallel and translated from `data[].id` into
model entries. A provider that fails is logged and left unchanged; the others
are unaffected.

Every provider that is *not* eligible is logged with the specific reason, so an
empty model list is always explainable.

## Model context limits

Most OpenAI-compatible `/models` endpoints do not return context or output
limits, so the plugin applies defaults and lets you define your own via config.
Pass regex-based `modelLimits` either globally in the plugin options or
per-provider in `provider.options`:

```json
{
  "provider": {
    "my-provider": {
      "options": {
        "modelLimits": [
          { "pattern": "kimi-k2\\.[567]", "context": 262144, "output": 32768 }
        ]
      }
    }
  }
}
```

Priority order, highest first:

1. Manual `limit` in `provider.models`.
2. Provider-level `modelLimits`.
3. Plugin-level `modelLimits`.
4. Provider-level `autoModelsContext` / `autoModelsOutput`.
5. Plugin-level `defaultContext` / `defaultOutput`.
6. Built-in fallback of `128000` / `16384`.

There is no built-in table of model families; limits come only from the rules
you supply. Modalities are inferred heuristically from the model ID, which can
produce false positives on third-party providers; override them with a manual
`models` entry where that matters.

## Troubleshooting

Every message this plugin emits is prefixed `[auto-models:<function>]` and is
written both through opencode's logger and to stdout/stderr.

- **Terminal**: `opencode models <provider-id> --print-logs`
- **Desktop**: the newest file in `~/.local/share/opencode/log`
  (`%USERPROFILE%\.local\share\opencode\log` on Windows)

Start by searching for `[auto-models:AutoModelsPlugin] Loaded`. If that line is
absent, the plugin was never loaded and the problem is installation, not
discovery: check that the `plugin` entry is in the config opencode is actually
reading, and prefer the file-copy install in Option 1.

If it is present, the following lines name every provider that was skipped and
why.

## Testing

```bash
node test/run.mjs
```

No dependencies and no opencode install required; the suite stubs the opencode
client and `fetch`.

## License

MIT © Vitaly Kuzyaev <vitkuz573@gmail.com>
