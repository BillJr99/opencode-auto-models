// @ts-check
/**
 * opencode v2 adapter. v2 has no config object to mutate: provider inventory
 * is owned by the provider domain and edited through replayable transforms.
 *
 * Two facts about the v2 runtime shape this file:
 *
 * - Providers declared in config are applied by an internal plugin that runs
 *   *after* user plugins. While `setup()` runs, neither `ctx.provider.list()`
 *   nor the transform editor contains them yet, so discovery cannot happen
 *   inside `setup()`. It runs right after, and again whenever opencode reports
 *   `provider.updated`, and publishes its result with `ctx.provider.reload()`.
 * - `setup()` is awaited before later plugins activate, so it registers the
 *   transform and returns without touching the network.
 *
 * The transform callback must be synchronous and cheap: it is replayed on every
 * reload. All network, filesystem and credential work happens in `sync()` and
 * the callback only copies the captured inventory into the editor.
 */

import { Model } from "@opencode/plugin";
import { createLogger, discoverAll, errorDetail, resolveSettings, settleBackground } from "./core.js";

/**
 * @typedef {import("@opencode/plugin").Plugin.Context} Context
 * @typedef {import("@opencode/plugin").Plugin.Cleanup} Cleanup
 * @typedef {import("@opencode/plugin/promise/provider").ProviderEditor} ProviderEditor
 * @typedef {import("@opencode/plugin").Provider.Info} ProviderInfo
 * @typedef {import("@opencode/plugin").Model.Info} ModelInfo
 * @typedef {import("@opencode/client").ConnectionInfo} ConnectionInfo
 *
 * @typedef {{ name: string, limit: { context: number, output: number }, modalities: { input: string[], output: string[] } }} DiscoveredModel
 * @typedef {{ info: ProviderInfo, models: ModelInfo[], connection?: ConnectionInfo }} CapturedProvider
 */

/**
 * v2 accepts the AI SDK package under its v1 name, under the `aisdk:` prefix,
 * and as the native package it rewrites both to. The shared core keys
 * eligibility on the v1 name, so all three are mapped onto it.
 */
const OPENAI_COMPATIBLE_PACKAGES = new Set([
  "@ai-sdk/openai-compatible",
  "aisdk:@ai-sdk/openai-compatible",
  "@opencode/ai/providers/openai-compatible",
]);

/** Event types after which the provider set, or the credentials for it, may have changed. */
const RESYNC_EVENTS = new Set(["provider.updated", "credential.updated", "credential.switched"]);

/**
 * v2 expands `${NAME}` in a provider's baseURL at request time rather than at
 * config load, so the URL `list()` returns may still contain placeholders.
 * @param {string} url
 */
function expandUrlEnv(url) {
  const env = typeof process !== "undefined" && process?.env ? process.env : {};
  return url.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => env[name] ?? match);
}

/**
 * Translate a v2 provider into the `{ npm, options, models }` shape the shared
 * core consumes. v2 keeps arbitrary JSON keys under `settings` (and migrates a
 * v1 `options` block there), so the auto-models keys are read from it as-is.
 * @param {ProviderInfo} info
 * @param {string | undefined} apiKey credential resolved from the active connection, if any
 */
export function toInternalProvider(info, apiKey) {
  /** @type {Record<string, any>} */
  const options = { ...(info.settings ?? {}) };
  if (typeof options.baseURL === "string") options.baseURL = expandUrlEnv(options.baseURL);
  if (apiKey) options.apiKey = apiKey;

  return {
    npm: OPENAI_COMPATIBLE_PACKAGES.has(info.package) ? "@ai-sdk/openai-compatible" : info.package,
    options,
  };
}

/**
 * Translate one discovered model into a complete v2 `Model.Info`, starting from
 * the defaults v2 itself uses so no required field is invented here. v1 has no
 * tool-capability field, so `tools` keeps the v2 default of `true`.
 * @param {string} providerID
 * @param {string} modelID
 * @param {DiscoveredModel} discovered
 * @returns {ModelInfo}
 */
export function toModelInfo(providerID, modelID, discovered) {
  const base = Model.Info.default(
    /** @type {import("@opencode/plugin").Provider.ID} */ (providerID),
    /** @type {import("@opencode/plugin").Model.ID} */ (modelID)
  );
  return {
    ...base,
    name: discovered.name,
    capabilities: {
      ...base.capabilities,
      input: [...discovered.modalities.input],
      output: [...discovered.modalities.output],
    },
    limit: { context: discovered.limit.context, output: discovered.limit.output },
  };
}

/**
 * Copy the captured inventory into the provider editor. Synchronous and free of
 * I/O by contract: opencode replays it on every reload.
 *
 * A provider the editor already holds keeps its identity and every source model
 * it already has, so explicit metadata wins over discovered defaults; only
 * models it lacks are added. A provider the editor does not hold yet (a
 * config-only provider, which opencode applies after user plugins) is added
 * with the info `list()` reported, and opencode's config plugin then layers the
 * user's own provider and model settings on top.
 * @param {ProviderEditor} editor
 * @param {Map<string, CapturedProvider>} captured
 * @param {ReturnType<typeof createLogger>} log
 */
export function applyInventory(editor, captured, log) {
  for (const [providerID, entry] of captured) {
    try {
      const record = editor.get(providerID);

      if (record) {
        const added = entry.models.filter((m) => !record.models.has(m.id));
        if (added.length > 0) editor.models.set(providerID, [...record.models.values(), ...added]);
        continue;
      }

      editor.add({
        info: entry.info,
        models: entry.models,
        ...(entry.connection ? { sourceConnection: entry.connection } : {}),
      });
    } catch (e) {
      // A throw here would make opencode disable the whole plugin.
      log("error", "applyInventory", `Could not apply discovered models for ${providerID}: ${errorDetail(e)}`);
    }
  }
}

/**
 * The active connection's key for a provider, when it has one. v2 keeps
 * credentials in its own store (it imports opencode v1's auth.json once) and
 * prefers them over `settings.apiKey` at request time, so /models is queried
 * with the same key inference will use. Only plain keys are used; an OAuth
 * grant is reported by type and ignored, as on v1. Key material is never logged.
 * @param {Context} ctx
 * @param {ProviderInfo} info
 * @param {ReturnType<typeof createLogger>} log
 * @returns {Promise<{ key?: string, connection?: ConnectionInfo }>}
 */
async function resolveConnectionKey(ctx, info, log) {
  const connections = ctx.integration?.connection;
  if (!connections || typeof connections.active !== "function") return {};

  try {
    const connection = await connections.active(info.integrationID ?? info.id);
    if (!connection) return {};
    const credential = await connections.resolve(connection);
    if (credential?.type === "key" && credential.key) return { key: credential.key, connection };
    if (credential) {
      log(
        "warn",
        "resolveConnectionKey",
        `${info.id} has an active ${JSON.stringify(credential.type)} connection, which this plugin cannot use for /models`
      );
    }
  } catch (e) {
    log("warn", "resolveConnectionKey", `Cannot resolve the active connection for ${info.id}: ${errorDetail(e)}`);
  }
  return {};
}

/**
 * Non-reversible, like the cache key, so the fingerprint never holds a secret.
 * @param {string} key
 */
function hashKey(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/**
 * v2 entrypoint, called by opencode v2's plugin loader with the plugin context.
 * @param {Context} ctx
 * @returns {Promise<Cleanup | void>}
 */
export async function setupV2(ctx) {
  if (typeof ctx?.provider?.transform !== "function" || typeof ctx?.provider?.list !== "function") {
    // opencode 1.18.x embeds the v2 *beta* plugin runtime and calls setup()
    // during `opencode run` with that beta context (`catalog`, no `provider`).
    // The same process has already called server(), which does the real work
    // on v1, so this is expected and stays quiet.
    if (ctx && typeof ctx === "object" && "catalog" in ctx) return;
    console.warn(
      "[auto-models:setup] Called without an opencode v2 provider domain (ctx.provider.transform/list); " +
        "not discovering. On opencode v1 the loader calls server() instead."
    );
    return;
  }

  /** @type {Record<string, any>} */
  const options = { ...(ctx.options ?? {}) };
  // v2 migrated auth.json into its own credential store, so the file is now a
  // stale copy. It is read only when the user points at it explicitly.
  const explicitAuthFile =
    (typeof options.authFile === "string" && options.authFile) || readEnvAuthFile() || undefined;

  const log = createLogger(undefined);
  const settings = resolveSettings(options, log);
  settings.authFile = explicitAuthFile ?? null;

  log("info", "setup", "Loaded (v2 entrypoint)");

  /** @type {Map<string, CapturedProvider>} */
  let captured = new Map();
  let fingerprint = "";
  let disposed = false;
  /** @type {Promise<void> | null} */
  let running = null;
  let pending = false;

  // Providers that exist before user plugins run are opencode's own catalog
  // (models.dev, built-in integrations). v1 only ever showed this plugin the
  // providers in the user's config, so these are left alone unless a provider
  // opts in with `autoModels: true`. Seeded from list() for the first sync and
  // kept current from the editor, which sees the whole pre-plugin catalog.
  /** @type {Set<string>} */
  let builtIn = new Set();
  try {
    builtIn = new Set((await ctx.provider.list()).data.map((p) => p.id));
  } catch (e) {
    log("warn", "setup", `Cannot list providers during setup: ${errorDetail(e)}`);
  }

  await ctx.provider.transform((editor) => {
    // Read before applying: on every replay the editor starts from the
    // pre-plugin state, so this never includes providers this plugin added.
    builtIn = new Set(editor.list().map((r) => r.provider.id));
    applyInventory(editor, captured, log);
  });

  async function syncOnce() {
    const { data } = await ctx.provider.list();

    /** @type {Record<string, ReturnType<typeof toInternalProvider>>} */
    const providers = {};
    /** @type {Map<string, { info: ProviderInfo, connection?: ConnectionInfo }>} */
    const infos = new Map();
    const parts = [];

    const skipped = [];
    for (const raw of data) {
      const info = /** @type {ProviderInfo} */ (/** @type {unknown} */ (raw));
      if (builtIn.has(info.id) && info.settings?.autoModels !== true) {
        skipped.push(info.id);
        parts.push([info.id, "built-in"]);
        continue;
      }
      const { key, connection } = await resolveConnectionKey(ctx, info, log);
      providers[info.id] = toInternalProvider(info, key);
      infos.set(info.id, { info, connection });
      parts.push([info.id, info.package, info.settings ?? null, key ? hashKey(key) : null]);
    }

    // Our own reload() raises provider.updated as well; an unchanged provider
    // set must end here, or every reload would trigger another one.
    const next = JSON.stringify(parts);
    if (next === fingerprint) return;
    fingerprint = next;

    if (skipped.length > 0) {
      log(
        "info",
        "setup",
        `Leaving opencode's built-in provider(s) alone: ${skipped.join(", ")}. ` +
          `Set autoModels: true in a provider's settings to discover its models anyway.`
      );
    }
    log("info", "setup", `Discovery running over ${Object.keys(providers).length} configured provider(s)`);
    const discoveries = await discoverAll(providers, settings, log);

    /** @type {Map<string, CapturedProvider>} */
    const nextCaptured = new Map();
    for (const { task, discovered } of discoveries) {
      const entry = infos.get(task.providerId);
      if (!entry) continue;
      const models = Object.entries(discovered).map(([id, m]) => toModelInfo(task.providerId, id, m));
      nextCaptured.set(task.providerId, { info: entry.info, models, connection: entry.connection });
      log("info", "setup", `Discovered ${models.length} model(s) for ${task.providerId}`, {
        models: Object.keys(discovered),
      });
    }

    const changed = JSON.stringify([...nextCaptured]) !== JSON.stringify([...captured]);
    captured = nextCaptured;
    if (changed && !disposed) await ctx.provider.reload();
  }

  /** Serialized, and coalesced: events that land mid-sync cause one more pass, not one each. */
  function sync() {
    if (disposed) return Promise.resolve();
    if (running) {
      pending = true;
      return running;
    }
    running = (async () => {
      do {
        pending = false;
        try {
          await syncOnce();
        } catch (e) {
          log("error", "setup", `Discovery failed: ${errorDetail(e)}`);
        }
      } while (pending && !disposed);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  /** @type {AsyncIterator<any> | undefined} */
  let events;
  if (typeof ctx.event?.subscribe === "function") {
    (async () => {
      try {
        events = ctx.event.subscribe()[Symbol.asyncIterator]();
        while (!disposed) {
          const next = await events.next();
          if (next.done) break;
          if (RESYNC_EVENTS.has(next.value?.type)) sync();
        }
      } catch (e) {
        if (!disposed) log("warn", "setup", `Event stream ended; later provider changes need a restart: ${errorDetail(e)}`);
      }
    })();
  }

  // After setup() returns, so providers from config have a chance to land.
  setTimeout(sync, 0);

  /** @type {Cleanup & { sync?: () => Promise<void>, settle?: () => Promise<void> }} */
  const cleanup = async () => {
    disposed = true;
    try {
      await events?.return?.();
    } catch {
      // The stream may already be closed.
    }
  };
  // Not opencode API: test seams for awaiting deliberately detached work.
  cleanup.sync = async () => {
    await sync();
    while (running) await running;
  };
  cleanup.settle = () => settleBackground(settings, log);
  return cleanup;
}

function readEnvAuthFile() {
  const env = typeof process !== "undefined" && process?.env ? process.env : {};
  return env.OPENCODE_AUTO_MODELS_AUTH_FILE || undefined;
}
