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
- **Near-instant startup**: each provider's model list is cached on disk and
  refreshed in the background, so after the first run opencode starts without
  waiting on a single network request.
- **Dependency-free plain JavaScript**: a single file with no third-party
  dependencies and no build step, so it loads anywhere opencode runs, including
  the Windows desktop app. Its only import is an optional, guarded
  `node:fs/promises` for the cache; without it the plugin simply runs uncached.
- **Built for opencode v1**: see [Requirements](#requirements).
- **Loud about failures**: every provider it skips, and every reason, is logged.
  A plugin that quietly does nothing is indistinguishable from one that is not
  installed, which is the failure mode this is built to avoid.
- **Safe defaults**: requests time out and are retried once, and one failing
  provider cannot affect another.

## Requirements

opencode **1.18.29 or newer**, on the v1 line. Nothing else: no Node, no Bun,
no package manager and no build step are needed to run the plugin, because
opencode loads it with its own embedded runtime. (Node is only needed to run
the test suite.)

The plugin ships a single object entrypoint, `{ id, server }`, which is what
v1's loader reads. Object entrypoints landed in opencode 1.18.29, so on an
older build the plugin is not recognised. Check with `opencode --version` and
update if needed.

opencode v2 is not supported. It is still in beta, and its catalog API has no
way to add a model, which is the only thing this plugin does; see
[How it works](#how-it-works).

## Installation

### Option 1 — Install from git

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
but never runs, use Option 2 and check `~/.cache/opencode/packages/` to see
whether the install actually produced anything.

### Forcing a reinstall

opencode unpacks a git plugin install into a package cache and reuses
what it finds there, so a half-finished install, or a version you have since
changed, can persist across restarts. Deleting the package cache makes opencode
install from scratch on the next start:

```bash
# macOS / Linux / WSL
rm -rf ~/.cache/opencode/packages

# Windows (PowerShell)
Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\opencode\packages"
```

This is the *package* cache, holding the plugin code itself. It is separate from
the model-list cache this plugin keeps under `auto-models/`, which is cleared
independently; see [Clearing the cache](#clearing-the-cache). Clearing one does
not clear the other, and as noted there, WSL and Windows keep separate trees, so
clearing one of those does not touch the other either.

### Option 2 — Copy the file (works everywhere, no resolution step)

The plugin is one dependency-free JavaScript file. Copying it needs no package
manager, no `git`, and no TypeScript loader:

```bash
# Global, macOS/Linux
mkdir -p ~/.config/opencode/plugins
cp src/index.js ~/.config/opencode/plugins/auto-models.mjs

# Project-local
mkdir -p .opencode/plugins
cp src/index.js .opencode/plugins/auto-models.mjs
```

On Windows, copy it to
`C:\Users\<You>\.config\opencode\plugins\auto-models.mjs`. From WSL that is
`/mnt/c/Users/<You>/.config/opencode/plugins/auto-models.mjs`, which is the
easiest way to get the file across.

Use the `.mjs` extension rather than `.js`. A plugins directory has no
`package.json`, so Node cannot tell whether a loose `.js` file is ESM or
CommonJS: it attempts CommonJS, fails, warns
`MODULE_TYPELESS_PACKAGE_JSON`, and falls back to ESM. The module loads
either way, but `.mjs` declares ESM outright and avoids relying on that
fallback. A git install does not face the question, because the repository's
`package.json` sets `"type": "module"`.

Files in these directories are loaded automatically at startup.

Note that the WSL and Windows installs of opencode have separate config trees on
separate filesystems, so a plugin installed under WSL is not visible to the
Windows desktop app and vice versa.

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
| `autoModelsCacheTtl` | inherits `cacheTtl` | Cache lifetime in milliseconds for this provider only. |
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
| `cache` | `true` | Cache each provider's model list on disk (see [Startup cost](#startup-cost)). |
| `cacheTtl` | `86400000` | Cache lifetime in milliseconds, 24 hours by default. |
| `cacheDir` | auto | Override the cache directory. |
| `refresh` | `false` | Ignore cached entries for this run and refetch everything. |

## Startup cost

opencode awaits the plugin before it builds its model catalog, so without a
cache every start waits for a `GET /models` round trip to every provider. The
plugin cannot simply move that work into the background: opencode reads the
provider config as soon as the hook returns, so a hook that returns early yields
a catalog with no models at all, and there is no way to rebuild it afterwards.

What it does instead is take the *network* off the startup path rather than the
wait. Each provider's raw `/models` response is cached on disk. A start that
finds a usable entry applies it immediately and issues no request at all,
refreshing the list in the background for the next start. Only a first run, a
newly added provider, or an entry older than `cacheTtl` fetches before startup
continues, and an expired entry whose refetch fails is still used rather than
leaving you with no models.

The raw response is what gets cached, not the processed model list, so editing
`autoModelsInclude`, `autoModelsExclude`, `modelLimits` or the context defaults
takes effect on the very next start with no refetch and no cache clearing.

A provider whose model list changes often, such as a local Ollama or llama.cpp
server, can shorten its own lifetime with `autoModelsCacheTtl` in
`provider.options` without affecting the others.

### Clearing the cache

Entries live under opencode's own cache root, so deleting that directory is the
universal reset:

```bash
# macOS / Linux / WSL
rm -rf ~/.cache/opencode/auto-models

# Windows (PowerShell) — including the Windows desktop app
Remove-Item -Recurse -Force "$env:USERPROFILE\.cache\opencode\auto-models"
```

A WSL install and a Windows install keep separate cache trees on separate
filesystems, exactly as they do for config and plugins, so clearing one does not
touch the other. From WSL, the Windows copy is at
`/mnt/c/Users/<You>/.cache/opencode/auto-models`.

To refetch once without deleting anything, set `refresh: true` in the plugin
options or run opencode with `OPENCODE_AUTO_MODELS_REFRESH=1`. To disable the
cache entirely, set `cache: false`.

The directory is resolved in this order: the `cacheDir` plugin option,
`OPENCODE_AUTO_MODELS_CACHE_DIR`, `$XDG_CACHE_HOME/opencode/auto-models`, then
the per-platform default shown above. If none of them resolve, the plugin runs
uncached rather than failing.

The cache holds each provider's `/models` URL and the model list it returned. It
never holds API keys, and it is written with owner-only permissions.

This is the *model-list* cache only. The plugin code itself lives in opencode's
package cache alongside it; if you are trying to make opencode pick up a
reinstalled or updated plugin rather than a refreshed model list, see
[Forcing a reinstall](#forcing-a-reinstall).

## How it works

### On opencode v1

The plugin's `config` hook runs when opencode loads the config. A provider is
eligible when it:

1. uses `npm: "@ai-sdk/openai-compatible"` (or has `options.autoModels: true`),
2. has both `options.baseURL` and `options.apiKey`,
3. has no manual `models` block (or has `options.autoModels: true`).

Eligible providers are fetched in parallel and translated from `data[].id` into
model entries. A provider that fails is logged and left unchanged; the others
are unaffected.

Every provider that is *not* eligible is logged with the specific reason, so an
empty model list is always explainable.

### opencode v2

Not supported, and nothing in this plugin tries to be.

v2 is still in beta, and it replaced the config object with domain objects: the
inventory is edited through `ctx.catalog.transform`, whose draft can update,
remove and re-default models but cannot **add** one, and nothing else in the v2
context or SDK can either. Discovering models you have not listed is the whole
of what this plugin does, so there is nothing there to build on yet.

If v2 grows a way to add catalog entries, the discovery core here is
runtime-agnostic and needs only a new apply step.

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
  (`%USERPROFILE%\.local\share\opencode\log` on Windows), or use
  **Help → Export logs**, which zips the desktop and server logs together.

Start by searching for `[auto-models:server] Loaded`. If that line is absent, the plugin was never loaded and the
problem is installation, not discovery: check that the `plugin` entry is in the
config opencode is actually reading, and prefer the file-copy install in
Option 2.

If it is present, the following lines name every provider that was skipped and
why.

Lines from `resolveTaskData` say whether a provider was served from cache or
fetched. If a model you just added upstream is missing, the cached list is one
start behind; see [Clearing the cache](#clearing-the-cache).

## Testing

```bash
node test/run.mjs
```

Requires Node, which is a development-time dependency only. No packages to
install and no opencode install required; the suite stubs the opencode client
and `fetch`. The cache is exercised both through an
in-memory store and against a real temporary directory, and the suite fails if
any background promise is left unhandled or if any test writes to a real cache
directory.

`npm run typecheck` runs `tsc --noEmit` over `src/`. Both run on every push and
pull request via GitHub Actions, across Node 20 and 22 on Linux, macOS and
Windows.

## License

MIT © Vitaly Kuzyaev <vitkuz573@gmail.com>
