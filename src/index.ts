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
 */

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 1000;
const DEFAULT_LIMITS = { context: 128000, output: 16384 };

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

// ─── Plugin ─────────────────────────────────────────────────────────────────

export const AutoModelsPlugin = async ({ client }, options) => {
  const dryRun = options?.dryRun === true;
  const timeoutMs = typeof options?.timeout === "number" ? options.timeout : DEFAULT_TIMEOUT_MS;
  const retries = typeof options?.retries === "number" ? options.retries : DEFAULT_RETRIES;
  const retryDelayMs = typeof options?.retryDelayMs === "number" ? options.retryDelayMs : DEFAULT_RETRY_DELAY_MS;

  const globalDefaults = {
    context: typeof options?.defaultContext === "number" ? options.defaultContext : DEFAULT_LIMITS.context,
    output: typeof options?.defaultOutput === "number" ? options.defaultOutput : DEFAULT_LIMITS.output,
  };
  const globalRules = compileLimitRules(options?.modelLimits);

  return {
    config: async (config) => {
      const providers = config.provider ?? {};
      const tasks = [];

      for (const [providerId, provider] of Object.entries(providers)) {
        if (!provider || typeof provider !== "object") continue;

        const opts = provider.options ?? {};
        const { baseURL, apiKey } = opts;
        if (!baseURL || !apiKey) continue;

        const isOpenAICompatible = provider.npm === "@ai-sdk/openai-compatible";
        const autoModelsFlag = opts.autoModels;

        if (autoModelsFlag === false) continue;
        if (!isOpenAICompatible && autoModelsFlag !== true) continue;

        const existingModels = provider.models;
        if (existingModels && Object.keys(existingModels).length > 0 && autoModelsFlag !== true) continue;

        const includeFilter = opts.autoModelsInclude ? new RegExp(opts.autoModelsInclude, "i") : null;
        const excludeFilter = opts.autoModelsExclude ? new RegExp(opts.autoModelsExclude, "i") : null;

        const providerDefaults = {
          context: typeof opts.autoModelsContext === "number" ? opts.autoModelsContext : globalDefaults.context,
          output: typeof opts.autoModelsOutput === "number" ? opts.autoModelsOutput : globalDefaults.output,
        };

        const limitRules = [
          ...compileLimitRules(opts.modelLimits),
          ...globalRules,
        ];

        const url = new URL("models", baseURL.endsWith("/") ? baseURL : `${baseURL}/`).toString();

        if (dryRun) {
          await client.app.log({ body: { service: "auto-models", level: "info", message: `[dry-run] Would fetch models for ${providerId} from ${url}` } });
          continue;
        }

        tasks.push({ providerId, provider, url, apiKey, existingModels, includeFilter, excludeFilter, providerDefaults, limitRules });
      }

      if (tasks.length === 0) return;

      const results = await Promise.allSettled(
        tasks.map(async (t) => {
          const data = await fetchModels(t.url, t.apiKey, timeoutMs, retries, retryDelayMs);
          return { task: t, data };
        })
      );

      for (const result of results) {
        if (result.status === "rejected") {
          const task = tasks[results.indexOf(result)];
          await client.app.log({ body: { service: "auto-models", level: "error", message: `Discovery failed for ${task?.providerId}: ${result.reason?.message ?? String(result.reason)}` } });
          continue;
        }

        const { task, data } = result.value;
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

        if (Object.keys(discovered).length > 0) {
          const merged = { ...discovered };
          if (task.existingModels) {
            for (const [id, manual] of Object.entries(task.existingModels)) {
              merged[id] = { ...discovered[id], ...manual };
            }
          }
          task.provider.models = merged;
          await client.app.log({ body: { service: "auto-models", level: "info", message: `Discovered ${Object.keys(discovered).length} model(s) for ${task.providerId}`, extra: { models: Object.keys(discovered) } } });
        } else {
          await client.app.log({ body: { service: "auto-models", level: "warn", message: `No models discovered for ${task.providerId} at ${task.url}` } });
        }
      }
    },
  };
};

export default AutoModelsPlugin;
