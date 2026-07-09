/**
 * OpenCode plugin that auto-discovers models from OpenAI-compatible providers.
 *
 * For every provider that:
 *   - uses the `@ai-sdk/openai-compatible` npm driver (or has `options.autoModels: true`)
 *   - has `options.baseURL` and `options.apiKey`
 *   - does not already have a non-empty `models` block (unless `options.autoModels: true`)
 *
 * the plugin calls `GET {baseURL}/models` and fills/merges `provider.models` with the
 * returned IDs, so you don't have to list them manually.
 */

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map();

const DEFAULT_LIMITS = {
  context: 128000,
  output: 16384,
};

// Built-in heuristics for common upstream model families.
// External rules passed via config take precedence over these.
const BUILT_IN_LIMIT_RULES = [
  { pattern: /kimi-k2\.7/i, limits: { context: 262144, output: 32768 } },
  { pattern: /kimi-k2\.6/i, limits: { context: 262144, output: 32768 } },
  { pattern: /kimi-k2\.5/i, limits: { context: 262144, output: 32768 } },
];

function compileLimitRules(rules) {
  if (!Array.isArray(rules)) return [];
  return rules.map((rule) => ({
    limits: { context: rule.context, output: rule.output },
    pattern: new RegExp(rule.pattern, "i"),
  }));
}

function inferModelLimits(modelId, rules, defaults) {
  for (const rule of rules) {
    if (rule.pattern.test(modelId)) {
      return rule.limits;
    }
  }
  return defaults;
}

function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

export const AutoModelsPlugin = async ({ client }, options) => {
  const dryRun = options?.dryRun === true;
  const timeoutMs =
    typeof options?.timeout === "number" ? options.timeout : DEFAULT_TIMEOUT_MS;
  const cacheTtlMs =
    typeof options?.cacheTtl === "number"
      ? options.cacheTtl
      : DEFAULT_CACHE_TTL_MS;

  return {
    config: async (config) => {
      const providers = config.provider ?? {};

      for (const [providerId, provider] of Object.entries(providers)) {
        if (!provider || typeof provider !== "object") continue;

        const opts = provider.options ?? {};
        const baseURL = opts.baseURL;
        const apiKey = opts.apiKey;

        // Skip providers without the required OpenAI-compatible endpoint/credentials.
        if (!baseURL || !apiKey) continue;

        const isOpenAICompatible = provider.npm === "@ai-sdk/openai-compatible";
        const autoModelsFlag = opts.autoModels;

        // Honor explicit opt-out.
        if (autoModelsFlag === false) continue;

        // Only auto-populate OpenAI-compatible providers, unless explicitly opted in.
        if (!isOpenAICompatible && autoModelsFlag !== true) continue;

        // Respect existing manual configuration unless the user explicitly forces auto-discovery.
        const existingModels = provider.models;
        if (
          existingModels &&
          Object.keys(existingModels).length > 0 &&
          autoModelsFlag !== true
        ) {
          continue;
        }

        const providerDefaultLimits = {
          context:
            typeof opts.autoModelsContext === "number"
              ? opts.autoModelsContext
              : typeof options?.defaultContext === "number"
              ? options.defaultContext
              : DEFAULT_LIMITS.context,
          output:
            typeof opts.autoModelsOutput === "number"
              ? opts.autoModelsOutput
              : typeof options?.defaultOutput === "number"
              ? options.defaultOutput
              : DEFAULT_LIMITS.output,
        };

        const externalRules = [
          ...compileLimitRules(opts.modelLimits),
          ...compileLimitRules(options?.modelLimits),
        ];
        const limitRules = [...externalRules, ...BUILT_IN_LIMIT_RULES];

        if (dryRun) {
          await client.app.log({
            body: {
              service: "auto-models",
              level: "info",
              message: `Would fetch models for ${providerId} from ${baseURL}`,
            },
          });
          continue;
        }

        // Check in-memory cache so we don't hit the API on every config reload.
        const cached = cache.get(providerId);
        let discovered = {};

        if (cached && Date.now() - cached.fetchedAt < cacheTtlMs) {
          discovered = cached.models;
        } else {
          try {
            const url = new URL(
              "models",
              baseURL.endsWith("/") ? baseURL : `${baseURL}/`
            ).toString();
            const response = await fetchWithTimeout(
              url,
              {
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  Accept: "application/json",
                },
              },
              timeoutMs
            );

            if (!response.ok) {
              throw new Error(
                `Failed to fetch models for ${providerId}: ${response.status} ${response.statusText}`
              );
            }

            const body = await response.json();
            const data = body?.data ?? [];

            for (const model of data) {
              const id = model.id;
              if (!id) continue;
              discovered[id] = {
                name: model.name || id,
                limit: inferModelLimits(id, limitRules, providerDefaultLimits),
              };
            }

            cache.set(providerId, { models: discovered, fetchedAt: Date.now() });

            if (Object.keys(discovered).length > 0) {
              await client.app.log({
                body: {
                  service: "auto-models",
                  level: "info",
                  message: `Discovered ${Object.keys(discovered).length} model(s) for ${providerId}`,
                  extra: { models: Object.keys(discovered) },
                },
              });
            } else {
              await client.app.log({
                body: {
                  service: "auto-models",
                  level: "warn",
                  message: `No models discovered for ${providerId} at ${url}`,
                },
              });
            }
          } catch (err) {
            const message = err?.message ?? String(err);
            await client.app.log({
              body: {
                service: "auto-models",
                level: "error",
                message: `Auto-model discovery failed for ${providerId}: ${message}`,
              },
            });
            continue;
          }
        }

        if (Object.keys(discovered).length === 0) continue;

        // Merge discovered models with any manual overrides. Manual entries win.
        const merged = { ...discovered };
        if (existingModels) {
          for (const [id, manual] of Object.entries(existingModels)) {
            merged[id] = { ...discovered[id], ...manual };
          }
        }

        provider.models = merged;
      }
    },
  };
};

export default AutoModelsPlugin;
