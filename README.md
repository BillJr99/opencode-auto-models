# opencode-auto-models

An [OpenCode](https://opencode.ai/) plugin that automatically discovers available
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
- **Safe defaults**: requests time out after 5 seconds and failures are logged,
  so a slow provider cannot hang OpenCode startup.
- **Lightweight caching**: discovered models are cached in memory for 5 minutes
  to avoid hitting the API on every config reload.

## Installation

### Option 1 — Install from GitHub (recommended)

Add the plugin to your OpenCode config:

```json
{
  "plugin": [
    "git+https://github.com/BillJr99/opencode-auto-models.git"
  ]
}
```

OpenCode will install and load it automatically on the next start.

### Option 2 — Local project plugin

Copy the plugin into your project's OpenCode plugins directory:

```bash
mkdir -p .opencode/plugins
cp /path/to/opencode-auto-models/src/index.ts .opencode/plugins/auto-models.ts
```

### Option 3 — Global plugin

Copy the plugin into the global OpenCode plugins directory:

```bash
mkdir -p ~/.config/opencode/plugins
cp /path/to/opencode-auto-models/src/index.ts ~/.config/opencode/plugins/auto-models.ts
```

## Usage

Define a provider that uses the OpenAI-compatible driver and leave the `models`
block empty:

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

On startup the plugin will fetch the model list and populate `models` for you.

You can also keep manual overrides for specific models you care about:

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
          "modalities": {
            "input": ["text", "image"],
            "output": ["text"]
          },
          "limit": {
            "context": 262144,
            "output": 16000
          }
        }
      }
    }
  }
}
```

The plugin will discover all other models and merge the manual metadata on top
of the defaults.

## Provider options

Set these inside `provider.options`:

| Option | Default | Description |
|--------|---------|-------------|
| `autoModels` | `true` for `@ai-sdk/openai-compatible`, otherwise `false` | Whether to auto-discover models for this provider. Use `false` to disable. |
| `baseURL` | — | The OpenAI-compatible API base URL (must end with `/v1`). |
| `apiKey` | — | API key used for the `Authorization: Bearer` header. |
| `autoModelsContext` | `128000` | Default context limit for every auto-discovered model of this provider. |
| `autoModelsOutput` | `16384` | Default output limit for every auto-discovered model of this provider. |
| `modelLimits` | — | Per-provider regex-based model limits (see [Model context limits](#model-context-limits)). |

## Plugin options

If you load the plugin via the `plugin` array, you can pass options:

```json
{
  "plugin": [
    ["git+https://github.com/BillJr99/opencode-auto-models.git", {
      "timeout": 10000,
      "cacheTtl": 600000,
      "modelLimits": [
        { "pattern": "kimi-k2\\.[567]", "context": 262144, "output": 32768 }
      ]
    }]
  ]
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `timeout` | `5000` | Request timeout in milliseconds for `GET /models`. |
| `cacheTtl` | `300000` | How long to keep discovered models in memory, in milliseconds. |
| `dryRun` | `false` | If `true`, log what would be fetched without mutating the config. |
| `defaultContext` | `128000` | Fallback context limit for auto-discovered models when no heuristic matches. |
| `defaultOutput` | `16384` | Fallback output limit for auto-discovered models when no heuristic matches. |
| `modelLimits` | — | Global regex-based model limits (see [Model context limits](#model-context-limits)). |

## How it works

When OpenCode loads the config, the plugin's `config` hook is executed. For each
provider that:

1. uses `npm: "@ai-sdk/openai-compatible"` (or has `options.autoModels: true`),
2. has `options.baseURL` and `options.apiKey`,
3. has no manual `models` block (or `options.autoModels: true`),

the plugin sends an authenticated `GET {baseURL}/models` request and translates
`data[].id` into model entries.

If the request fails, the provider is left unchanged and the error is logged via
`client.app.log`.

## Model context limits

Most OpenAI-compatible `/models` endpoints do not return context or output
limits, so the plugin applies defaults and lets you define your own limits via
config. You can pass regex-based `modelLimits` either globally in the plugin
options or per-provider in `provider.options`:

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

The plugin also ships with a small provider-agnostic heuristic table for common
upstream model families (e.g. `kimi-k2.7*`, `kimi-k2.6*`, `kimi-k2.5*` → 256K
context).

The priority order is:

1. Manual `limit` in `provider.models` (highest priority).
2. Provider-level `modelLimits`.
3. Provider-level `autoModelsContext` / `autoModelsOutput`.
4. Plugin-level `modelLimits`.
5. Built-in heuristic for the model ID.
6. Plugin-level `defaultContext` / `defaultOutput`.
7. Hardcoded fallback of `128000` / `16384`.

This means `kimi-k2.7-code` and `kimi-k2.6` will show a 256K context window
instead of the generic 128K, whether you define them yourself or rely on the
built-in heuristics.

## Testing

You can verify discovery with a temporary provider:

```json
{
  "provider": {
    "my-provider-test": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "My Provider Test",
      "options": {
        "baseURL": "https://api.example.com/v1",
        "apiKey": "YOUR_API_KEY"
      }
    }
  }
}
```

Then run:

```bash
opencode models my-provider-test --print-logs
```

You should see a log line like:

```
Discovered 11 model(s) for my-provider-test
```

## License

MIT © Vitaly Kuzyaev <vitkuz573@gmail.com>
