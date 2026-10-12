# opencode-auto-models

An [opencode](https://opencode.ai/) plugin that automatically discovers available
models from OpenAI-compatible providers, so you don't have to maintain a manual
`models` block in your config.

One package supports both opencode generations, and each runtime uses its own
native plugin API:

```
same package
    │
    ├── opencode v1  ──  server()  →  config hook fills provider.<id>.models
    │
    └── opencode v2  ──  setup(ctx) →  ctx.provider.transform publishes the inventory
```

Both paths share one discovery core, which handles fetching, retries, caching,
credentials, filters, limits and logging. Nothing is duplicated between them,
so a provider configured the same way gets the same models on either version.

## Features

- **Auto-discovery**: calls `GET {baseURL}/models` for every eligible provider
  and adds the models it reports.
- **opencode v1 and v2 from one install**: the package's default export carries
  a v1 `server()` and a v2 `setup()` (built with `Plugin.define` from
  `@opencode/plugin`). Each runtime's loader calls only its own entrypoint, so
  the right path is chosen automatically, with no version sniffing. Each
  entrypoint also checks that it received its own runtime's input and says so
  in the log if not.
- **Manual overrides preserved**: models you list yourself keep their
  metadata, and every other model the endpoint reports is added alongside them.
- **Universal**: works with any provider that uses the OpenAI-compatible driver
  (`@ai-sdk/openai-compatible` on v1; that name, `aisdk:@ai-sdk/openai-compatible`
  or `@opencode/ai/providers/openai-compatible` on v2), or any provider
  explicitly opted in with `autoModels: true`.
- **Fast startup**: each provider's model list is cached on disk and served
  immediately, then refreshed in the background, so after the first run
  discovery needs no network request on the startup path. On v2 a refresh that
  changed the list is applied live; on v1 it takes effect on the next start.
- **Loud about failures**: every provider it skips, and every reason, is logged.
  A plugin that quietly does nothing is indistinguishable from one that is not
  installed, which is the failure mode this is built to avoid.
- **Safe defaults**: requests time out and are retried once, one failing
  provider cannot affect another, and API keys are never logged or cached.

## Requirements

- **opencode v1**: 1.18.29 or newer. The plugin ships an object entrypoint,
  which v1 recognises from 1.18.29 onward. Tested with 1.18.29 and 1.18.34.
- **opencode v2**: 2.0.x. Tested with 2.0.22.

Check your version with `opencode --version`.

The package has one runtime dependency, `@opencode/plugin` (the official v2
plugin API). opencode installs it for you when it installs the plugin from git,
on both v1 and v2. Node is only needed to run the test suite or to prepare a
local checkout (see [Installation](#installation)).

## Installation

The package is installed from git or from a local checkout; it is not
published to the npm registry.

### opencode v1

Add the git URL to the singular `plugin` array in `opencode.json`:

```json
{
  "plugin": [
    "git+https://github.com/BillJr99/opencode-auto-models.git"
  ]
}
```

opencode installs the package, including its dependency, at startup. This
requires a working `git` binary in the environment opencode itself runs in,
which is not always the environment your shell has. If the plugin appears in
your config but never runs, check `~/.cache/opencode/packages/` to see whether
the install produced anything, or use a local checkout instead.

### opencode v2

Install with the plugin command, which downloads the package, installs its
dependency and adds it to your global config:

```bash
opencode plugin add github:BillJr99/opencode-auto-models
# equivalently
opencode plugin add git+https://github.com/BillJr99/opencode-auto-models.git
```

This adds an entry to the plural `plugins` array. To pass options, edit that
entry into the object form:

```json
{
  "plugins": [
    {
      "package": "github:BillJr99/opencode-auto-models",
      "options": { "timeout": 10000 }
    }
  ]
}
```

### opencode v2 under WSL and in the Windows desktop app

A WSL install and the Windows desktop app are two separate opencode installs.
Each has its own global config, its own package cache and its own model cache,
so the plugin must be installed in each one, and installing it in one does not
affect the other.

**WSL (Linux).** Run the plugin command inside WSL. opencode installs git
plugins with the `git` binary of the environment it runs in, so `git` must be
installed inside WSL (`sudo apt install git` on Ubuntu):

```bash
opencode --version      # 2.0.x
opencode plugin add github:BillJr99/opencode-auto-models
opencode plugin list    # confirms v2 found the plugin
```

If the git install does not take, use a [local checkout](#local-checkout-v1-or-v2)
in the WSL filesystem and add its `src` directory to `plugins`, for example
`"plugins": ["/home/<you>/opencode-auto-models/src"]`.

**Windows desktop app.** The desktop app runs its own Windows-side opencode
server, which never sees the WSL install. If the Windows `opencode` command is
on your `PATH`, run the same command from PowerShell. This needs a Windows
`git` (for example Git for Windows) on the `PATH` of the environment opencode
runs in, which is the most common reason a git install silently produces
nothing:

```powershell
opencode plugin add github:BillJr99/opencode-auto-models
```

Without the Windows CLI, or if that install does not take, use a local checkout
on the Windows side and add it to the Windows global config by hand:

```powershell
git clone https://github.com/BillJr99/opencode-auto-models.git "$env:USERPROFILE\opencode-auto-models"
cd "$env:USERPROFILE\opencode-auto-models"
npm install --omit=dev
```

```json
{
  "plugins": ["C:/Users/<You>/opencode-auto-models/src"]
}
```

Restart the desktop app afterwards. Running `opencode plugin add` once with the
Windows CLI is the surest way to find the config file the desktop app reads,
since the command writes to it. Do not point the Windows app at a checkout
inside WSL (`\\wsl$\...`): its `node_modules` were installed for Linux and the
path is only reachable while WSL is running.

The desktop app does not show v2 plugin output, so check that the plugin loaded
with a foreground server as described under [Troubleshooting](#troubleshooting);
in PowerShell, set the password with `$env:OPENCODE_PASSWORD = "secret"` before
running `opencode serve`. To force a reinstall, clear the package cache on the
side that is misbehaving, as shown below.

### Local checkout (v1 or v2)

Clone the repository and install its dependency once:

```bash
git clone https://github.com/BillJr99/opencode-auto-models.git
cd opencode-auto-models
npm install --omit=dev
```

Then point opencode at the checkout:

- **v1**: point at the entry file, `"plugin": ["file:///path/to/opencode-auto-models/src/index.js"]`.
- **v2**: point at the `src` directory, `"plugins": ["/path/to/opencode-auto-models/src"]`. A
  v2 local plugin path must be a directory containing `index.js`, which is
  why it is `src`, not the repository root.

Copying `src/index.js` alone into a plugins directory no longer works. The
entrypoint imports the shared core and the `@opencode/plugin` dependency, so
the plugin needs the rest of the checkout and its `node_modules`.

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

On v2, `opencode plugin update` refreshes package plugins as well.

This is the *package* cache, holding the plugin code itself. It is separate from
the model-list cache this plugin keeps under `auto-models/`, which is cleared
independently; see [Clearing the cache](#clearing-the-cache). WSL and Windows
keep separate trees, so clearing one does not touch the other.

## Usage

Define a provider that uses the OpenAI-compatible driver and leave the models
out entirely.

**opencode v1** (`provider`, with `npm` and `options`):

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

**opencode v2** (`providers`, with `package` and `settings`):

```json
{
  "providers": {
    "my-provider": {
      "name": "My Provider",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://api.example.com/v1",
        "apiKey": "{env:MY_PROVIDER_API_KEY}"
      }
    }
  }
}
```

opencode v2 also reads the v1 form above and migrates it, carrying every key in
`options` (including this plugin's) into `settings`. An unchanged v1 config
therefore keeps working after an upgrade.

A provider that already lists some models is still discovered: the listed
entries are kept and act as overrides, and every other model the endpoint
reports is added alongside them. On v1:

```json
{
  "provider": {
    "my-provider": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://api.example.com/v1" },
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

On v2 the same block sits under `providers.<id>.models`, using v2's model
fields (`capabilities` rather than `modalities`). To leave a provider's list
exactly as written, set `autoModels: false`.

## Provider options

Set these inside the provider's `options` on v1, or its `settings` on v2:

| Option | Default | Description |
|--------|---------|-------------|
| `autoModels` | `true` for an OpenAI-compatible driver, otherwise `false` | Whether to auto-discover models for this provider. `false` disables it; `true` opts another driver in, and on v2 also opts in one of opencode's built-in providers (see [How it works](#how-it-works)). A manual models block does not disable discovery; it is merged on top. |
| `baseURL` | none | The OpenAI-compatible API base URL (normally ends with `/v1`). |
| `apiKey` | none | API key used for the `Authorization: Bearer` header. See the credential order below. |
| `autoModelsContext` | `128000` | Default context limit for every auto-discovered model of this provider. |
| `autoModelsOutput` | `16384` | Default output limit for every auto-discovered model of this provider. |
| `autoModelsInclude` | none | Case-insensitive regex; only matching model IDs are kept. |
| `autoModelsExclude` | none | Case-insensitive regex; matching model IDs are dropped. |
| `autoModelsCacheTtl` | inherits `cacheTtl` | Cache lifetime in milliseconds for this provider only. |
| `modelLimits` | none | Per-provider regex-based model limits (see [Model context limits](#model-context-limits)). |

A `baseURL` is required. The key used to list models is resolved as follows.

**On opencode v1**:

1. `options.apiKey` in the config.
2. The key stored by `opencode auth login` in opencode's `auth.json`, for the
   same provider id. The id you picked in `opencode auth login` must match the
   provider's key under `provider` in `opencode.json`.
3. No key: the request is sent unauthenticated, which suits local proxies.

`auth.json` is read from `$XDG_DATA_HOME/opencode/auth.json`, otherwise
`~/.local/share/opencode/auth.json` (`%USERPROFILE%\.local\share\opencode\auth.json`
on Windows). Override the path with the `authFile` plugin option or the
`OPENCODE_AUTO_MODELS_AUTH_FILE` environment variable.

**On opencode v2**:

1. The provider's active connection (a key saved with `opencode auth` or
   `/connect`, or an environment variable listed in the provider's `env`),
   read through v2's integration API. v2 itself prefers this over
   `settings.apiKey` when it sends requests, so the model list is fetched with
   the same key inference will use, and the discovered inventory is bound to
   that connection.
2. `settings.apiKey` in the config.
3. `auth.json`, only if you point at it explicitly with `authFile` or
   `OPENCODE_AUTO_MODELS_AUTH_FILE`. v2 keeps credentials in its own database
   and treats `auth.json` as legacy, so it is not read by default.
4. No key: the request is sent unauthenticated.

On both versions only plain API keys are used; OAuth credentials are logged by
type and ignored. A key is never logged and never written to the model cache.

## Plugin options

On **v1**, pass options as the second element of a `plugin` entry:

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

On **v2**, use the object form of a `plugins` entry:

```json
{
  "plugins": [
    {
      "package": "github:BillJr99/opencode-auto-models",
      "options": {
        "timeout": 10000,
        "modelLimits": [
          { "pattern": "kimi-k2\\.[567]", "context": 262144, "output": 32768 }
        ]
      }
    }
  ]
}
```

The options are the same on both versions:

| Option | Default | Description |
|--------|---------|-------------|
| `timeout` | `8000` | Request timeout in milliseconds for `GET /models`. |
| `retries` | `1` | Retry attempts after an initial failure. |
| `retryDelayMs` | `1000` | Base delay between retries; backs off linearly. |
| `dryRun` | `false` | Log what would be fetched without changing any models. |
| `defaultContext` | `128000` | Fallback context limit for auto-discovered models. |
| `defaultOutput` | `16384` | Fallback output limit for auto-discovered models. |
| `modelLimits` | none | Global regex-based model limits (see below). |
| `cache` | `true` | Cache each provider's model list on disk (see [Startup cost](#startup-cost)). |
| `cacheTtl` | `86400000` | Cache lifetime in milliseconds, 24 hours by default. |
| `cacheDir` | auto | Override the cache directory. |
| `awaitExpired` | `false` | Refetch an entry older than `cacheTtl` before applying it, rather than serving it and refreshing in the background. |
| `refresh` | `false` | Ignore cached entries for this run and refetch everything. |
| `authFile` | auto on v1, unset on v2 | Path to opencode's `auth.json`. See the credential order above. |

## Startup cost

Each provider's raw `/models` response is cached on disk, and discovery is
stale-while-revalidate:

- **Cache exists** (fresh or expired): the cached list is applied immediately,
  with no request on the startup path, and the list is refetched in the
  background. A failed refresh leaves the served list and the cache entry as
  they were.
- **No cache** (a first run or a newly added provider): the list is fetched
  before the models are applied, and the cache is written.

What happens to a background refresh depends on the version. **v2** compares
the refreshed list with the one it served and, if they differ, republishes the
inventory with `ctx.provider.reload()`, so new or removed models appear in the
running session a moment later. **v1** builds its model catalog once, from the
config hook, and has no way to rebuild it, so on v1 the refreshed list takes
effect on the next start.

`cacheTtl` therefore no longer decides whether startup waits; it marks an
entry as expired, which only changes the log line. Set `awaitExpired: true` to
restore the blocking behavior: an expired entry is then refetched before the
models are applied, and served only if that refetch fails. This is mostly
useful on v1, where it trades a slower start after expiry for never running a
whole session on a list older than `cacheTtl`. An entry dated in the future
(clock skew, a resumed VM) is always refetched first, because its age is
unknown.

The raw response is what gets cached, not the processed model list, so editing
`autoModelsInclude`, `autoModelsExclude`, `modelLimits` or the context defaults
takes effect on the very next start with no refetch and no cache clearing.

A provider whose model list changes often, such as a local Ollama or llama.cpp
server, can shorten its own lifetime with `autoModelsCacheTtl` without
affecting the others.

The two versions differ in when the models become visible:

- **v1** awaits the plugin before it builds its model catalog, so discovered
  models are present from the first moment. A cold cache makes startup wait
  for the `/models` round trip.
- **v2** applies providers from your config only after user plugins have
  started, so discovery cannot run inside `setup()`. It runs immediately
  afterwards, and its result is published with `ctx.provider.reload()`. opencode
  starts without waiting for it, and the models appear a moment later; with a
  warm cache that is typically well under a second. On a cold cache, a one-shot
  command that names a discovered model as soon as opencode starts (for example
  the very first `opencode run --standalone --model my-provider/some-model`)
  can report the model as unavailable. Running it again, once the list is
  cached, works.

### Clearing the cache

Entries live under opencode's own cache root, so deleting that directory is the
universal reset:

```bash
# macOS / Linux / WSL
rm -rf ~/.cache/opencode/auto-models

# Windows (PowerShell), including the Windows desktop app
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
never holds API keys, and it is written with owner-only permissions. Its file
names include a one-way fingerprint of the key, so switching to another
account's key does not reuse the previous account's list.

This is the *model-list* cache only. The plugin code itself lives in opencode's
package cache alongside it; if you are trying to make opencode pick up a
reinstalled or updated plugin rather than a refreshed model list, see
[Forcing a reinstall](#forcing-a-reinstall).

## How it works

A provider is eligible for discovery when it:

1. uses an OpenAI-compatible driver (or sets `autoModels: true`),
2. has a `baseURL`,
3. does not set `autoModels: false`.

Eligible providers are fetched in parallel, and each `data[].id` becomes a model
with a name, context and output limits, and inferred input modalities. A
provider that fails is logged and left unchanged; the others are unaffected.
Every provider that is *not* eligible is logged with the specific reason, so an
empty model list is always explainable.

### On opencode v1

The plugin's `config` hook runs when opencode loads the config. It discovers
models for the providers under `provider` and writes them into each provider's
`models` map, with any manual entries merged on top.

### On opencode v2

`setup(ctx)` registers a provider transform with `ctx.provider.transform` and
returns without touching the network, because v2 waits for it before starting
later plugins. Discovery then runs in the background:

1. `ctx.provider.list()` supplies the providers, including their `settings`, which
   is where v2 keeps this plugin's options.
2. Credentials are resolved through the provider's active connection.
3. The shared core fetches or serves the cached model lists and applies the
   same filters and limits as on v1.
4. Each model is translated into a v2 `Model.Info`, starting from v2's own
   defaults (`Model.Info.default`).
5. `ctx.provider.reload()` replays the transform, which copies the inventory into
   the provider domain:
   - A provider opencode already holds keeps its identity and every model it
     already has, and only missing models are added (`editor.models.set`).
   - A provider opencode does not hold yet, which is the case for a provider
     defined only in your config, is added with `editor.add`. opencode then
     layers your own provider and model settings on top of it.

The transform callback is synchronous and only copies data that was gathered
beforehand, as v2 requires. Discovery runs again whenever opencode reports that
providers or credentials changed (`provider.updated`, `credential.updated`,
`credential.switched`). A provider set that has not changed since the last run
is a no-op, so the plugin's own reload never triggers another discovery.

A background cache refresh that changed a provider's list triggers one more
discovery pass, which reads the refreshed entry and reloads the inventory. An
unchanged refresh does nothing, and the extra pass never schedules a refresh of
its own.

### Differences between v1 and v2

| | opencode v1 | opencode v2 |
|---|---|---|
| Provider config | `provider.<id>`, `npm`, `options` | `providers.<id>`, `package`, `settings` (the v1 form is migrated automatically) |
| Plugin config | `plugin: [url \| [url, options]]` | `plugins: [package \| { package, options }]` |
| Entry point | `server()` → `config` hook | `setup(ctx)` → `ctx.provider.transform` |
| Models visible | before the catalog is built | a moment after startup (see [Startup cost](#startup-cost)) |
| Background refresh | takes effect on the next start | applied live when the list changed |
| Providers considered | only those in your config | those in your config; opencode's built-in providers (models.dev, bundled integrations) only with `autoModels: true` |
| Credential order | `apiKey`, then `auth.json` | active connection, then `apiKey`, then `auth.json` only if configured |
| Manual model metadata | shallow-merged over the discovered entry | applied by opencode over the discovered entry, field by field (for example, a manual `limit.context` keeps the discovered `limit.output`) |
| Modalities | `modalities.input/output` | `capabilities.input/output`; `capabilities.tools` keeps v2's default of `true`, since v1 has no equivalent field |
| Structured logs | `client.app.log` plus the console | console only (v2 gives plugins no logger) |

On v2, opencode's own catalog (models.dev and built-in integrations) already
lists those providers' models. That is why built-in providers are left alone
unless you opt one in. v1 never showed them to this plugin at all.

## Model context limits

Most OpenAI-compatible `/models` endpoints do not return context or output
limits, so the plugin applies defaults and lets you define your own via config.
Pass regex-based `modelLimits` either globally in the plugin options or
per-provider in the provider's `options` (v1) or `settings` (v2):

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

1. Manual `limit` on the model in your config.
2. Provider-level `modelLimits`.
3. Plugin-level `modelLimits`.
4. Provider-level `autoModelsContext` / `autoModelsOutput`.
5. Plugin-level `defaultContext` / `defaultOutput`.
6. Built-in fallback of `128000` / `16384`.

There is no built-in table of model families; limits come only from the rules
you supply. Modalities are inferred heuristically from the model ID, which can
produce false positives on third-party providers; override them with a manual
model entry where that matters.

## Troubleshooting

Every message this plugin emits is prefixed `[auto-models:<function>]`.

**On opencode v1**, messages go through opencode's logger and to stdout/stderr:

- **Terminal**: `opencode models <provider-id> --print-logs`
- **Desktop**: the newest file in `~/.local/share/opencode/log`
  (`%USERPROFILE%\.local\share\opencode\log` on Windows), or use
  **Help → Export logs**, which zips the desktop and server logs together.

Start by searching for `[auto-models:server] Loaded (v1 entrypoint)`.

**On opencode v2**, plugins run inside the opencode server, and v2 gives them
no logger, so messages go to the server's stdout/stderr. The background
service does not keep that output; to see it, run the server in the foreground
and point a client at it:

```bash
OPENCODE_PASSWORD=secret opencode serve --port 4096
# in another terminal
OPENCODE_PASSWORD=secret opencode models --server http://127.0.0.1:4096
```

Start by searching for `[auto-models:setup] Loaded (v2 entrypoint)`. `opencode plugin list` shows whether v2 found the plugin at all.

On either version, if the load line is absent, the plugin was never loaded and
the problem is installation, not discovery: check that the plugin entry is in
the config opencode is actually reading.

If it is present, the following lines name every provider that was skipped and
why. Lines from `resolveTaskData` say whether a provider was served from cache
or fetched. If a model you just added upstream is missing, the cached list is
one start behind; see [Clearing the cache](#clearing-the-cache). On v2, also see
the startup timing note under [Startup cost](#startup-cost).

## Testing

```bash
npm install
npm test            # node test/run.mjs
npm run typecheck   # tsc --noEmit
```

The suite needs no opencode install. It stubs `fetch`, the v1 client and a v2
plugin context, and covers the following:

- **Shared core**: `/models` handling, retries, filters, model limits, the
  cache, credential resolution and failure isolation.
- **v1**: the config hook, manual overrides, and the `server()` guard.
- **v2**:
  - setup and discovery after `provider.updated`, with no reload loop;
  - updating existing providers in place versus adding new ones;
  - translated models validated against the real `Model.Info` schema from
    `@opencode/plugin`;
  - built-in provider handling;
  - connection credentials, with no secrets in logs or cache;
  - a synchronous, I/O-free transform callback;
  - the `setup()` guard.
- **Dual entrypoint**: the single default export carries `id`, `setup` and
  `server`, and each path runs without the other.

The cache is exercised both through an in-memory store and against a real
temporary directory. The suite fails if any background promise is left
unhandled or if any test writes to a real cache directory.

`npm run typecheck` checks `src/`. The v2 adapter and entrypoint are
`@ts-check`ed against `@opencode/plugin`'s own type definitions. Both commands
run on every push and pull request via GitHub Actions, across Node 20 and 22 on
Linux, macOS and Windows.

The plugin has also been run against the real opencode CLIs, 1.18.29 and
1.18.34 on v1 and 2.0.22 on v2, using a local fake OpenAI-compatible server.
Those runs covered:

- loading from git and from a local checkout;
- listing discovered models;
- running a prompt against one;
- restarting from cache;
- manual model overrides;
- credential use.

## License

MIT © Vitaly Kuzyaev <vitkuz573@gmail.com>
