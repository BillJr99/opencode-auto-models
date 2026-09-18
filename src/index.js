/**
 * OpenCode plugin that auto-discovers models from OpenAI-compatible providers.
 *
 * Provider options:
 *   autoModels           - enable/disable (default: true for openai-compatible)
 *   autoModelsContext    - default context limit (default: 128000)
 *   autoModelsOutput     - default output limit (default: 16384)
 *   autoModelsInclude    - regex to include only matching model IDs
 *   autoModelsExclude    - regex to exclude matching model IDs
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
 */

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_LIMITS = { context: 128000, output: 16384 };

// ─── Logging ────────────────────────────────────────────────────────────────

/**
 * opencode's TUI surfaces `client.app.log` with --print-logs, but GUI front-ends
 * (the desktop app) do not. They do capture stdout/stderr into their log file, so
 * every message is mirrored to the console.
 *
 * Both paths are guarded: an unguarded `await client.app.log(...)` that rejects
 * would abort the whole config hook and silently drop every remaining provider.
 */
function createLogger(client) {
  return async function log(level, where, message, extra) {
    const prefixed = `[auto-models:${where}] ${message}`;

    try {
      const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.info;
      consoleFn(prefixed, extra ?? "");
    } catch {
      // A console that throws must not take the plugin down with it.
    }

    try {
      await client.app.log({
        body: { service: "auto-models", level, message: prefixed, ...(extra ? { extra } : {}) },
      });
    } catch (e) {
      try {
        console.error(`[auto-models:createLogger] client.app.log failed: ${errorDetail(e)}`);
      } catch {
        // Nothing left to report through.
      }
    }
  };
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

function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchModels(url, apiKey, timeoutMs, retries, retryDelayMs) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      }, timeoutMs);

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

// ─── Discovery core (runtime-agnostic) ──────────────────────────────────────

/**
 * Decide which providers are eligible, and say out loud why the rest are not.
 * Every skip here used to be a silent `continue`, which made a non-working
 * plugin indistinguishable from a working one on any GUI front-end.
 */
async function collectProviderTasks(providers, settings, log) {
  const tasks = [];

  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== "object") {
      await log("warn", "collectProviderTasks", `Skipping ${providerId}: provider entry is not an object`);
      continue;
    }

    const opts = provider.options ?? {};
    const { baseURL, apiKey } = opts;

    if (!baseURL || !apiKey) {
      await log(
        "info",
        "collectProviderTasks",
        `Skipping ${providerId}: missing ${!baseURL ? "options.baseURL" : "options.apiKey"}. ` +
          `Auto-discovery needs both to be present in opencode.json; credentials stored via ` +
          `\`opencode auth login\` (auth.json) are not visible to this plugin.`
      );
      continue;
    }

    const isOpenAICompatible = provider.npm === "@ai-sdk/openai-compatible";
    const autoModelsFlag = opts.autoModels;

    if (autoModelsFlag === false) {
      await log("info", "collectProviderTasks", `Skipping ${providerId}: options.autoModels is false`);
      continue;
    }

    if (!isOpenAICompatible && autoModelsFlag !== true) {
      await log(
        "info",
        "collectProviderTasks",
        `Skipping ${providerId}: npm is ${JSON.stringify(provider.npm)}, not "@ai-sdk/openai-compatible". ` +
          `Set options.autoModels: true to opt in anyway.`
      );
      continue;
    }

    const existingModels = provider.models;
    if (existingModels && Object.keys(existingModels).length > 0 && autoModelsFlag !== true) {
      await log(
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

    if (settings.dryRun) {
      await log("info", "collectProviderTasks", `[dry-run] Would fetch models for ${providerId} from ${url}`);
      continue;
    }

    tasks.push({ providerId, provider, url, apiKey, existingModels, includeFilter, excludeFilter, providerDefaults, limitRules });
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

/**
 * Fetch every eligible provider in parallel and return the discovered model maps.
 * Runtime-agnostic on purpose: callers decide how to apply the result, so the
 * same core serves the v1 `config` hook and any future v2 registration path.
 */
async function discoverAll(providers, settings, log) {
  const tasks = await collectProviderTasks(providers, settings, log);

  if (tasks.length === 0) {
    await log("info", "discoverAll", "No eligible providers for auto-discovery");
    return [];
  }

  await log("info", "discoverAll", `Discovering models for ${tasks.length} provider(s): ${tasks.map((t) => t.providerId).join(", ")}`);

  const results = await Promise.allSettled(
    tasks.map((t) => fetchModels(t.url, t.apiKey, settings.timeoutMs, settings.retries, settings.retryDelayMs))
  );

  const discoveries = [];

  // Index-carrying loop: recovering the task via results.indexOf(result) was
  // O(n^2) and relied on allSettled returning reference-distinct objects, so a
  // failure could in principle be attributed to the wrong provider.
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const task = tasks[i];

    if (result.status === "rejected") {
      await log("error", "discoverAll", `Discovery failed for ${task.providerId} at ${task.url}: ${errorDetail(result.reason)}`);
      continue;
    }

    const discovered = buildModelMap(task, result.value);

    if (Object.keys(discovered).length === 0) {
      await log("warn", "discoverAll", `No models discovered for ${task.providerId} at ${task.url}`);
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

function resolveSettings(options) {
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
  };
}

// ─── Plugin ─────────────────────────────────────────────────────────────────

export const AutoModelsPlugin = async ({ client }, options) => {
  const log = createLogger(client);
  const settings = resolveSettings(options);

  // If this line is absent from the log, the plugin was never loaded at all —
  // the single most useful signal when diagnosing a GUI front-end.
  await log("info", "AutoModelsPlugin", `Loaded (timeout=${settings.timeoutMs}ms, retries=${settings.retries}${settings.dryRun ? ", dry-run" : ""})`);

  return {
    config: async (config) => {
      try {
        const providers = config.provider ?? {};
        await log("info", "config", `Config hook running over ${Object.keys(providers).length} provider(s)`);

        const discoveries = await discoverAll(providers, settings, log);

        for (const { task, discovered } of discoveries) {
          task.provider.models = mergeWithManual(discovered, task.existingModels);
          await log("info", "config", `Discovered ${Object.keys(discovered).length} model(s) for ${task.providerId}`, {
            models: Object.keys(discovered),
          });
        }
      } catch (e) {
        await log("error", "config", `Config hook failed: ${errorDetail(e)}`);
      }
    },
  };
};
