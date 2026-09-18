/**
 * OpenCode plugin that auto-discovers models from OpenAI-compatible providers.
 *
 * Provider options:
 *   autoModels           - enable/disable (default: true for openai-compatible)
 *   autoModelsContext    - default context limit (default: 128000)
 *   autoModelsOutput     - default output limit (default: 16384)
 *   autoModelsInclude    - regex to include only matching model IDs
 *   autoModelsExclude    - regex to exclude matching model IDs
 *   autoModelsCacheTtl   - per-provider cache lifetime in ms
 *   modelLimits          - [{ pattern, context, output }] per-model overrides
 *
 * Plugin options:
 *   timeout              - fetch timeout ms (default: 8000)
 *   retries              - retry count on failure (default: 1)
 *   retryDelayMs         - base delay between retries (default: 1000)
 *   defaultContext       - fallback context limit
 *   defaultOutput        - fallback output limit
 *   modelLimits          - global per-model overrides
 *   dryRun               - log what would be fetched without mutating the config
 *   cache                - on-disk model-list cache (default: true)
 *   cacheDir             - override the cache directory
 *   cacheTtl             - cache lifetime in ms (default: 86400000, 24h)
 *   refresh              - ignore cached entries for this run
 */

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_LIMITS = { context: 128000, output: 16384 };
const DEFAULT_CACHE_TTL_MS = 86_400_000;
const CACHE_VERSION = 1;

// ─── Logging ────────────────────────────────────────────────────────────────

/**
 * opencode's TUI surfaces `client.app.log` with --print-logs, but GUI front-ends
 * (the desktop app) do not. They do capture stdout/stderr into their log file, so
 * every message is mirrored to the console.
 *
 * `client.app.log` is an HTTP round trip to the local opencode server, and the
 * `config` hook runs on opencode's startup critical path. Awaiting one log call
 * per provider therefore cost O(providers) sequential round trips before a single
 * model was fetched. The structured call is now chained onto a queue and never
 * awaited by the caller: `log()` returns as soon as the synchronous console
 * mirror is written.
 *
 * Chaining rather than firing in parallel keeps messages in order. The only loss
 * window is a process exit before the queue drains, and the console mirror —
 * which is what GUI front-ends actually capture — is always already written by
 * then.
 */
function createLogger(client) {
  let queue = Promise.resolve();
  let transportBroken = false;

  const log = function log(level, where, message, extra) {
    const prefixed = `[auto-models:${where}] ${message}`;

    try {
      const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
      consoleFn(prefixed, extra ?? "");
    } catch {
      // A console that throws must not take the plugin down with it.
    }

    // One dead transport should produce one line, not one per message.
    if (transportBroken) return;

    queue = queue
      .then(() =>
        client.app.log({
          body: { service: "auto-models", level, message: prefixed, ...(extra ? { extra } : {}) },
        })
      )
      .catch((e) => {
        transportBroken = true;
        try {
          console.error(
            `[auto-models:createLogger] client.app.log failed; further structured logs are suppressed: ${errorDetail(e)}`
          );
        } catch {
          // Nothing left to report through.
        }
      });
  };

  /** Drains the queue. Used by tests; never called on the startup path. */
  log.idle = () => queue;

  return log;
}

function errorDetail(err) {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function compileLimitRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.map((r) => ({
    limits: { context: r.context, output: r.output },
    pattern: new RegExp(r.pattern, "i"),
  }));
}

function inferModelLimits(modelId, rules, defaults) {
  for (const rule of rules) {
    if (rule.pattern.test(modelId)) return rule.limits;
  }
  return defaults;
}

function inferModalities(modelId) {
  const input = ["text"];
  const output = ["text"];

  if (/(?:^|[-._])(?:vl|vlm|visual)\b|vision|gemma-[34]|llama-[34].*vision|gpt-4o|claude|gemini/i.test(modelId))
    input.push("image");
  if (/\baudio\b|gpt-4o-audio|gemini.*audio/i.test(modelId))
    input.push("audio");

  return { input: [...new Set(input)], output };
}

/**
 * An 8s abort timer that is never unref'd holds the event loop open long after
 * the request it guarded has settled.
 */
function unrefTimer(timer) {
  try {
    timer?.unref?.();
  } catch {
    // A runtime whose timers are plain numbers has nothing to unref.
  }
  return timer;
}

function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = unrefTimer(setTimeout(() => controller.abort(), timeoutMs));
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchModels(url, apiKey, timeoutMs, retries, retryDelayMs) {
  // A local proxy or self-hosted endpoint often needs no credential at all.
  // Sending `Authorization: Bearer undefined` to one is worse than sending
  // nothing, so the header is omitted unless a key was configured.
  const headers = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, { headers }, timeoutMs);

      if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

      const body = await response.json();
      return body?.data ?? [];
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(retryDelayMs * (attempt + 1));
    }
  }
  throw lastErr;
}

// ─── Model-list cache ───────────────────────────────────────────────────────

/**
 * Without a cache, every opencode start re-fetches every provider's /models
 * before the model catalog can be built. Discovery cannot simply be detached
 * instead: opencode awaits the `config` hook and only then reads `cfg.provider`,
 * so a hook that returns early yields a catalog with no models, and v1 exposes
 * no way to rebuild it afterwards. The fix is therefore to take the *network*
 * off the startup path rather than the await — serve startup from disk and
 * refresh in the background for the next start.
 *
 * What is cached is the raw `/models` payload, never the built model map.
 * Filters, limit rules and modality inference are applied afterwards in
 * `buildModelMap`, so editing `autoModelsExclude` or `modelLimits` takes effect
 * on the very next start with no network and no cache bust.
 */

/** Memoized so N providers trigger one import, not N. */
let fsModulePromise;
function loadFs() {
  if (!fsModulePromise) {
    // A static import would break the plugin at *load* time on any runtime
    // without node:fs, which would end the copy-one-file install story. The
    // rejection is handled here at creation, so it can never surface as an
    // unhandled rejection even if no caller ever awaits this.
    fsModulePromise = import("node:fs/promises").then(
      (m) => m,
      () => null
    );
  }
  return fsModulePromise;
}

function readEnv() {
  return typeof process !== "undefined" && process?.env ? process.env : {};
}

function readPlatform() {
  return typeof process !== "undefined" && process ? process.platform : "";
}

/** FNV-1a, inline, so the file keeps its no-dependency guarantee (no node:crypto). */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Co-located under opencode's own cache root, so "delete ~/.cache/opencode"
 * remains the universal reset — the README already points users there for
 * `packages/`.
 */
function resolveCacheDir(options, env, sep) {
  if (typeof options?.cacheDir === "string" && options.cacheDir) return options.cacheDir;
  if (env.OPENCODE_AUTO_MODELS_CACHE_DIR) return env.OPENCODE_AUTO_MODELS_CACHE_DIR;
  if (env.XDG_CACHE_HOME) return [env.XDG_CACHE_HOME, "opencode", "auto-models"].join(sep);
  // On Windows, opencode itself uses the dot-directory layout rather than
  // AppData (%USERPROFILE%\.config\opencode\plugins,
  // %USERPROFILE%\.local\share\opencode\log), so matching it is what keeps
  // "delete the opencode cache directory" a single instruction on every OS.
  if (sep === "\\" && env.USERPROFILE) return [env.USERPROFILE, ".cache", "opencode", "auto-models"].join(sep);
  if (env.HOME) return [env.HOME, ".cache", "opencode", "auto-models"].join(sep);
  if (env.LOCALAPPDATA) return [env.LOCALAPPDATA, "opencode", "auto-models"].join(sep);
  return null;
}

/**
 * Provider ids come from user config, so an id of `../../../etc` must not be
 * able to escape the cache directory. The slug is also what makes the directory
 * legible to a human running `ls`.
 */
function slugifyProviderId(providerId) {
  return (
    String(providerId)
      .replace(/[^A-Za-z0-9._-]/g, "_")
      // Collapse dot runs and strip leading punctuation so the result cannot be
      // `..`, a dotfile, or anything else a shell or a glob treats specially.
      .replace(/\.{2,}/g, "_")
      .replace(/^[._-]+/, "")
      .slice(0, 40) || "provider"
  );
}

/**
 * Keyed on the resolved URL and on a fingerprint of the credential, because
 * rotating to a different account's key can legitimately change the model list
 * and a plain "keyed/anon" bit would serve the old account's models for a whole
 * TTL. The fingerprint only ever feeds this filename; no credential material is
 * written into the cache file.
 */
function cacheKeyFor(providerId, url, apiKey) {
  return `${slugifyProviderId(providerId)}.${fnv1a(`${url} ${apiKey ? fnv1a(apiKey) : "anon"}`)}`;
}

function createNullStore() {
  return { dir: null, async read() { return null; }, async write() {} };
}

function createFsStore(dir, sep, log) {
  let writable = true;
  let ensured = null;
  const pathFor = (key) => `${dir}${sep}${key}.json`;

  return {
    dir,
    async read(key) {
      const fs = await loadFs();
      if (!fs) return null;
      try {
        return await fs.readFile(pathFor(key), "utf8");
      } catch {
        // A missing file, an unreadable directory and a runtime without fs are
        // all just a cache miss.
        return null;
      }
    },
    async write(key, text) {
      if (!writable) return;
      const fs = await loadFs();
      if (!fs) {
        writable = false;
        return;
      }

      const target = pathFor(key);
      const tmp = `${target}.${Math.random().toString(36).slice(2)}.tmp`;

      try {
        if (!ensured) ensured = fs.mkdir(dir, { recursive: true, mode: 0o700 });
        await ensured;
        await fs.writeFile(tmp, text, { mode: 0o600 });
        // Atomic on POSIX, and replace-semantics on Windows, so a second
        // opencode instance can never observe a half-written file.
        await fs.rename(tmp, target);
      } catch (e) {
        writable = false;
        ensured = null;
        log("warn", "createFsStore", `Cannot write the model cache at ${dir}; continuing without it: ${errorDetail(e)}`);
        try {
          await fs.unlink(tmp);
        } catch {
          // The temp file may never have been created.
        }
      }
    },
  };
}

function serializeEntry(task, data, now) {
  return JSON.stringify({
    v: CACHE_VERSION,
    providerId: task.providerId,
    url: task.url,
    keyed: !!task.apiKey,
    savedAt: now,
    data,
  });
}

/** Anything unparseable, versioned differently or written for another URL is a miss. */
function readEntry(text, task, now) {
  if (typeof text !== "string") return null;

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!parsed || parsed.v !== CACHE_VERSION) return null;
  if (parsed.providerId !== task.providerId || parsed.url !== task.url) return null;
  if (!Array.isArray(parsed.data)) return null;

  const savedAt = typeof parsed.savedAt === "number" ? parsed.savedAt : 0;
  // A savedAt in the future — clock skew, a resumed VM — must never read as
  // fresh, or a bad clock pins the entry forever.
  const age = savedAt > now ? Infinity : now - savedAt;

  return { data: parsed.data, savedAt, age };
}

// ─── Discovery core (runtime-agnostic) ──────────────────────────────────────

/**
 * Decide which providers are eligible, and say out loud why the rest are not.
 * Every skip here used to be a silent `continue`, which made a non-working
 * plugin indistinguishable from a working one on any GUI front-end.
 */
function collectProviderTasks(providers, settings, log) {
  const tasks = [];

  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== "object") {
      log("warn", "collectProviderTasks", `Skipping ${providerId}: provider entry is not an object`);
      continue;
    }

    const opts = provider.options ?? {};
    const { baseURL, apiKey } = opts;

    if (!baseURL) {
      log(
        "info",
        "collectProviderTasks",
        `Skipping ${providerId}: no options.baseURL, so there is no /models endpoint to query.`
      );
      continue;
    }

    if (!apiKey) {
      // Not a skip: unauthenticated endpoints are a normal case.
      log(
        "info",
        "collectProviderTasks",
        `${providerId} has no options.apiKey; querying ${baseURL} unauthenticated. ` +
          `Note that credentials stored via \`opencode auth login\` (auth.json) are not visible ` +
          `to this plugin, so set options.apiKey here if this endpoint needs one.`
      );
    }

    const isOpenAICompatible = provider.npm === "@ai-sdk/openai-compatible";
    const autoModelsFlag = opts.autoModels;

    if (autoModelsFlag === false) {
      log("info", "collectProviderTasks", `Skipping ${providerId}: options.autoModels is false`);
      continue;
    }

    if (!isOpenAICompatible && autoModelsFlag !== true) {
      log(
        "info",
        "collectProviderTasks",
        `Skipping ${providerId}: npm is ${JSON.stringify(provider.npm)}, not "@ai-sdk/openai-compatible". ` +
          `Set options.autoModels: true to opt in anyway.`
      );
      continue;
    }

    const existingModels = provider.models;
    if (existingModels && Object.keys(existingModels).length > 0 && autoModelsFlag !== true) {
      log(
        "info",
        "collectProviderTasks",
        `Skipping ${providerId}: it already defines ${Object.keys(existingModels).length} model(s) manually. ` +
          `Set options.autoModels: true to discover additional models and merge your overrides on top.`
      );
      continue;
    }

    const includeFilter = opts.autoModelsInclude ? new RegExp(opts.autoModelsInclude, "i") : null;
    const excludeFilter = opts.autoModelsExclude ? new RegExp(opts.autoModelsExclude, "i") : null;

    const providerDefaults = {
      context: typeof opts.autoModelsContext === "number" ? opts.autoModelsContext : settings.defaults.context,
      output: typeof opts.autoModelsOutput === "number" ? opts.autoModelsOutput : settings.defaults.output,
    };

    const limitRules = [...compileLimitRules(opts.modelLimits), ...settings.globalRules];
    const url = new URL("models", baseURL.endsWith("/") ? baseURL : `${baseURL}/`).toString();
    const cacheTtlMs = typeof opts.autoModelsCacheTtl === "number" ? opts.autoModelsCacheTtl : settings.cacheTtlMs;

    tasks.push({
      providerId,
      provider,
      url,
      apiKey,
      existingModels,
      includeFilter,
      excludeFilter,
      providerDefaults,
      limitRules,
      cacheTtlMs,
      cacheKey: cacheKeyFor(providerId, url, apiKey),
    });
  }

  return tasks;
}

/** Turn a provider's /models payload into an opencode `models` map. */
function buildModelMap(task, data) {
  const discovered = {};

  for (const model of data) {
    const id = model.id;
    if (!id) continue;
    if (task.includeFilter && !task.includeFilter.test(id)) continue;
    if (task.excludeFilter && task.excludeFilter.test(id)) continue;

    discovered[id] = {
      name: model.name || id,
      limit: inferModelLimits(id, task.limitRules, task.providerDefaults),
      modalities: inferModalities(id),
    };
  }

  return discovered;
}

async function fetchAndCache(task, settings) {
  const data = await fetchModels(task.url, task.apiKey, settings.timeoutMs, settings.retries, settings.retryDelayMs);
  // Only a successful response is written. Caching a failure as `[]` would make
  // a transient outage sticky for a whole TTL and indistinguishable from a
  // provider that genuinely serves no models.
  try {
    await settings.store.write(task.cacheKey, serializeEntry(task, data, settings.now()));
  } catch {
    // Writing is best effort: the cache is an optimisation and must never be
    // able to fail a discovery that already succeeded.
  }
  return data;
}

/**
 * Warm the cache for the NEXT start. Deliberately detached, and deliberately
 * limited to the cache: by the time this resolves, opencode has already read
 * `cfg.provider` and built its model catalog, so mutating the config here would
 * advertise models the catalog does not contain.
 *
 * The per-settings guard matters because the `config` hook is not once per
 * process — opencode re-runs it on every config reload, and without this a few
 * edits to opencode.json would fan out a refresh per provider per edit.
 */
function scheduleRefresh(task, settings, log) {
  if (settings.refreshed.has(task.cacheKey)) return;
  settings.refreshed.add(task.cacheKey);

  settings.background.push(
    fetchAndCache(task, settings).then(
      (data) =>
        log(
          "info",
          "scheduleRefresh",
          `Refreshed the cached model list for ${task.providerId} (${data.length} model(s)) for the next start`
        ),
      (e) => log("warn", "scheduleRefresh", `Background refresh failed for ${task.providerId}: ${errorDetail(e)}`)
    )
  );
}

/**
 * Stale-while-revalidate, per provider:
 *   fresh  -> serve from disk, no blocking network, refresh in the background
 *   stale  -> fetch; on failure fall back to the stale copy rather than leaving
 *             the provider empty when a usable answer is already on disk
 *   miss   -> fetch (exactly today's behavior)
 */
/** Reading is best effort too, so an injected or broken store cannot fail discovery. */
async function readCached(task, settings) {
  if (!settings.cache || settings.refresh) return null;
  try {
    return readEntry(await settings.store.read(task.cacheKey), task, settings.now());
  } catch {
    return null;
  }
}

/** `age` is Infinity for a future-dated entry, which must not reach a log line. */
function describeAge(age) {
  return Number.isFinite(age) ? `${Math.round(age / 1000)}s old` : "dated in the future";
}

async function resolveTaskData(task, settings, log) {
  const entry = await readCached(task, settings);

  if (entry && entry.age <= task.cacheTtlMs) {
    log(
      "info",
      "resolveTaskData",
      `Serving ${task.providerId} from the cached model list (${task.cacheKey}, ${entry.data.length} model(s), ` +
        `${describeAge(entry.age)}); refreshing in the background for the next start`
    );
    scheduleRefresh(task, settings, log);
    return entry.data;
  }

  if (!entry) return fetchAndCache(task, settings);

  try {
    return await fetchAndCache(task, settings);
  } catch (e) {
    log(
      "warn",
      "resolveTaskData",
      `Refresh failed for ${task.providerId}; falling back to the expired cached list ` +
        `(${entry.data.length} model(s), ${describeAge(entry.age)}): ${errorDetail(e)}`
    );
    return entry.data;
  }
}

/**
 * Fetch every eligible provider in parallel and return the discovered model maps.
 * Runtime-agnostic on purpose: callers decide how to apply the result, so the
 * same core serves the v1 `config` hook and any future v2 registration path.
 */
async function discoverAll(providers, settings, log) {
  const tasks = collectProviderTasks(providers, settings, log);

  if (tasks.length === 0) {
    log("info", "discoverAll", "No eligible providers for auto-discovery");
    return [];
  }

  if (settings.dryRun) {
    for (const task of tasks) {
      const entry = await readCached(task, settings);

      if (entry && entry.age <= task.cacheTtlMs) {
        log(
          "info",
          "discoverAll",
          `[dry-run] Would serve ${task.providerId} from the cached model list ` +
            `(${entry.data.length} model(s), ${describeAge(entry.age)}) and refresh it in the background`
        );
      } else {
        log("info", "discoverAll", `[dry-run] Would fetch models for ${task.providerId} from ${task.url}`);
      }
    }
    return [];
  }

  log("info", "discoverAll", `Discovering models for ${tasks.length} provider(s): ${tasks.map((t) => t.providerId).join(", ")}`);

  const results = await Promise.allSettled(tasks.map((t) => resolveTaskData(t, settings, log)));

  const discoveries = [];

  // Index-carrying loop: recovering the task via results.indexOf(result) was
  // O(n^2) and relied on allSettled returning reference-distinct objects, so a
  // failure could in principle be attributed to the wrong provider.
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const task = tasks[i];

    if (result.status === "rejected") {
      log("error", "discoverAll", `Discovery failed for ${task.providerId} at ${task.url}: ${errorDetail(result.reason)}`);
      continue;
    }

    const discovered = buildModelMap(task, result.value);

    if (Object.keys(discovered).length === 0) {
      log("warn", "discoverAll", `No models discovered for ${task.providerId} at ${task.url}`);
      continue;
    }

    discoveries.push({ task, discovered });
  }

  return discoveries;
}

/** Discovered defaults first, the user's manual metadata merged on top. */
function mergeWithManual(discovered, existingModels) {
  const merged = { ...discovered };
  if (!existingModels) return merged;

  for (const [id, manual] of Object.entries(existingModels)) {
    merged[id] = { ...discovered[id], ...manual };
  }
  return merged;
}

function resolveSettings(options, log) {
  const env = readEnv();
  const sep = readPlatform() === "win32" ? "\\" : "/";

  // `cache: false` must not merely skip reads: an injected store would still be
  // written through, so disabling the cache swaps the store out entirely.
  const cacheEnabled = options?.cache !== false;
  const dir = cacheEnabled ? resolveCacheDir(options, env, sep) : null;
  const store = cacheEnabled ? options?.cacheStore ?? (dir ? createFsStore(dir, sep, log) : createNullStore()) : createNullStore();
  const cache = cacheEnabled && (!!options?.cacheStore || !!dir);

  return {
    dryRun: options?.dryRun === true,
    timeoutMs: typeof options?.timeout === "number" ? options.timeout : DEFAULT_TIMEOUT_MS,
    retries: typeof options?.retries === "number" ? options.retries : DEFAULT_RETRIES,
    retryDelayMs: typeof options?.retryDelayMs === "number" ? options.retryDelayMs : DEFAULT_RETRY_DELAY_MS,
    defaults: {
      context: typeof options?.defaultContext === "number" ? options.defaultContext : DEFAULT_LIMITS.context,
      output: typeof options?.defaultOutput === "number" ? options.defaultOutput : DEFAULT_LIMITS.output,
    },
    globalRules: compileLimitRules(options?.modelLimits),
    cache,
    cacheTtlMs: typeof options?.cacheTtl === "number" ? options.cacheTtl : DEFAULT_CACHE_TTL_MS,
    refresh: options?.refresh === true || env.OPENCODE_AUTO_MODELS_REFRESH === "1",
    store,
    now: typeof options?.now === "function" ? options.now : Date.now,
    // Scoped per plugin instance rather than module-wide, so a config reload
    // reuses the guard while a fresh instance starts clean.
    refreshed: new Set(),
    background: [],
  };
}

/** Awaits every detached refresh and drains the log queue. Used by tests. */
async function settleBackground(settings, log) {
  while (settings.background.length > 0) {
    await Promise.allSettled(settings.background.splice(0));
  }
  await log.idle();
}

// ─── v1 entrypoint ──────────────────────────────────────────────────────────

function createV1Hooks({ client }, options) {
  const log = createLogger(client);
  const settings = resolveSettings(options, log);

  return {
    log,
    hooks: {
      config: async (config) => {
        try {
          const providers = config.provider ?? {};
          log("info", "config", `Config hook running over ${Object.keys(providers).length} provider(s)`);

          const discoveries = await discoverAll(providers, settings, log);

          for (const { task, discovered } of discoveries) {
            task.provider.models = mergeWithManual(discovered, task.existingModels);
            log("info", "config", `Discovered ${Object.keys(discovered).length} model(s) for ${task.providerId}`, {
              models: Object.keys(discovered),
            });
          }
        } catch (e) {
          log("error", "config", `Config hook failed: ${errorDetail(e)}`);
        }
      },

      // Not opencode hooks: opencode dispatches by known hook name, so these are
      // inert there. They exist so the test suite can await work that is
      // deliberately detached from the startup path.
      flushLogs: () => log.idle(),
      settle: () => settleBackground(settings, log),
    },
  };
}

// ─── v2 entrypoint ──────────────────────────────────────────────────────────

/**
 * v2 removed the mutable global config object and the `config` hook with it.
 * Provider inventories are edited through `ctx.provider.transform`.
 *
 * Two constraints shape the code below. The transform callback must be
 * synchronous, and it is replayed on every rebuild, so all network work happens
 * before it and only the assignment happens inside. And v2 models are
 * `Model.Info` records with a fixed shape, not the loose `{name, limit,
 * modalities}` entries v1 accepts.
 */

/** Documented shape is ProviderRecord.provider; the rest are tolerated fallbacks. */
function readProviderInfo(record) {
  return record?.provider ?? record?.info ?? record ?? null;
}

function readProviderSettings(record) {
  const info = readProviderInfo(record);
  return info?.settings ?? info?.options ?? null;
}

/** Reshape a v2 record so the shared discovery core can judge eligibility. */
function asDiscoveryProvider(record) {
  const info = readProviderInfo(record) ?? {};
  const pkg = info.package ?? info.npm;
  return {
    npm: typeof pkg === "string" && pkg.includes("openai-compatible") ? "@ai-sdk/openai-compatible" : pkg,
    options: readProviderSettings(record) ?? {},
    models: undefined,
  };
}

/**
 * Build a v2 Model.Info. v1 carries `modalities`; v2 carries the same
 * information under `capabilities`, alongside required bookkeeping fields.
 */
function toModelInfo(providerID, modelID, model) {
  return {
    id: modelID,
    modelID,
    providerID,
    name: model.name ?? modelID,
    capabilities: {
      tools: true,
      input: model.modalities?.input ?? ["text"],
      output: model.modalities?.output ?? ["text"],
    },
    variants: [],
    time: { released: 0 },
    cost: [],
    status: "active",
    enabled: true,
    limit: { context: model.limit?.context, output: model.limit?.output },
  };
}

async function loadDiscoveries(ctx, settings, log) {
  const records = (await ctx.provider.list?.()) ?? [];
  const providers = {};

  for (const record of records) {
    const info = readProviderInfo(record);
    const id = info?.id;
    if (!id) continue;

    if (!readProviderSettings(record)) {
      log("warn", "setup", `Cannot read connection settings for provider ${id}; skipping it`);
      continue;
    }
    providers[id] = asDiscoveryProvider(record);
  }

  return discoverAll(providers, settings, log);
}

/**
 * A v2 context exposes domain objects; `provider` is the one this plugin needs.
 * A v1 plugin input has no domains at all, carrying `client`, `project`,
 * `directory`, `worktree` and `$` instead.
 *
 * This matters because a v1 runtime calls `server()` and then also calls
 * `setup()` on the same entrypoint object. Discovery has already happened by
 * then, so `setup()` must recognise the v1 input and return without doing or
 * reporting anything. Detecting v2 positively, rather than inferring it from a
 * missing `transform`, keeps that case apart from a genuine v2 runtime whose
 * provider domain is broken.
 */
function isV2Context(ctx) {
  return !!ctx && typeof ctx.provider === "object" && ctx.provider !== null;
}

async function runV2Discovery(ctx) {
  if (!isV2Context(ctx)) return;

  const log = createLogger(ctx?.client ?? { app: { log: async () => {} } });
  const settings = resolveSettings(ctx?.options, log);

  log("info", "setup", "Loaded (v2 entrypoint)");

  if (typeof ctx.provider.transform !== "function") {
    log("error", "setup", "ctx.provider exists but has no transform(); cannot auto-discover models on this runtime");
    return;
  }

  // Held outside the transform so a later reload() replays the callback against
  // refreshed data without re-running discovery inside it.
  const source = { discoveries: [] };

  try {
    source.discoveries = await loadDiscoveries(ctx, settings, log);
  } catch (e) {
    log("error", "setup", `Discovery failed: ${errorDetail(e)}`);
    return;
  }

  try {
    await ctx.provider.transform((editor) => {
      for (const { task, discovered } of source.discoveries) {
        const models = Object.entries(discovered).map(([id, model]) => toModelInfo(task.providerId, id, model));
        try {
          editor.models.set(task.providerId, models);
        } catch (e) {
          // Report a rejected record shape by name rather than leaving an empty
          // provider and no explanation. Synchronous on purpose: the transform
          // callback cannot await.
          console.error(`[auto-models:setup] editor.models.set rejected ${models.length} model(s) for ${task.providerId}: ${errorDetail(e)}`);
        }
      }
    });

    for (const { task, discovered } of source.discoveries) {
      log("info", "setup", `Discovered ${Object.keys(discovered).length} model(s) for ${task.providerId}`, {
        models: Object.keys(discovered),
      });
    }
  } catch (e) {
    log("error", "setup", `Provider transform failed: ${errorDetail(e)}`);
  }
}

// ─── Entrypoint ─────────────────────────────────────────────────────────────

/**
 * One default export serving both runtimes, per opencode's v1-to-v2 migration
 * guide: v1 calls `server()` and ignores `setup()`, v2 does the reverse.
 *
 * Object entrypoints require opencode 1.18.29 or newer. This is the module's
 * only export on purpose: the v1 loader iterates every export, so a second one
 * would register the hook twice and fetch every provider twice per config load.
 *
 * `id` and `setup` are declared literally rather than through
 * `Plugin.define()` so the plugin keeps zero dependencies and can be dropped
 * into a plugins directory as a single file.
 */
export default {
  id: "auto-models",
  async setup(ctx) {
    await runV2Discovery(ctx);
  },
  async server(input, options) {
    const { log, hooks } = createV1Hooks(input, options);
    // If this line is absent from the log, the plugin was never loaded at all —
    // the single most useful signal when diagnosing a GUI front-end.
    log("info", "server", "Loaded (v1 entrypoint)");
    return hooks;
  },
};
