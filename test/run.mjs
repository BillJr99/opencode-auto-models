/**
 * Runs on plain node with no dependencies: `node test/run.mjs`.
 * Stubs the opencode client and global fetch so discovery can be exercised
 * without an opencode install.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import plugin from "../src/index.js";

const MODELS = [{ id: "kimi-k2.7-code" }, { id: "qwen-vl-max" }, { id: "tiny-1b" }];

/**
 * The detached background refresh means a bug now shows up as an unhandled
 * rejection rather than a failed assertion, so the suite watches for them
 * globally and fails at the end if any escaped.
 */
const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

/**
 * Backstop against a test reaching the developer's real cache directory. Any
 * test that forgets to disable the cache lands here instead of in
 * ~/.cache/opencode/auto-models. Tests that pass an explicit `cacheDir` still
 * win over this, which is what the real-filesystem cases rely on.
 */
const SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), "auto-models-sandbox-"));
process.env.OPENCODE_AUTO_MODELS_CACHE_DIR = SANDBOX;

let fetchCount = 0;
let fetchImpl = async (url) => {
  if (String(url).includes("broken")) throw new Error("ECONNREFUSED");
  if (String(url).includes("unauthorized")) return { ok: false, status: 401, statusText: "Unauthorized" };
  return { ok: true, status: 200, statusText: "OK", json: async () => ({ data: MODELS }) };
};
const defaultFetch = fetchImpl;

globalThis.fetch = async (...args) => {
  fetchCount++;
  return fetchImpl(...args);
};

function resetFetch() {
  fetchCount = 0;
  fetchImpl = defaultFetch;
}

const payload = (ids) => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ data: ids.map((id) => ({ id })) }) });

/** `options` merges into the defaults rather than replacing them. */
function provider({ options = {}, ...rest } = {}) {
  return {
    npm: "@ai-sdk/openai-compatible",
    ...rest,
    options: { baseURL: "https://api.example.com/v1", apiKey: "sk-test", ...options },
  };
}

/**
 * `cache: false` is the default here on purpose. Without it the suite would
 * write into the developer's real ~/.cache/opencode/auto-models, and every run
 * after the first would be served from disk without ever calling the stubbed
 * fetch — the suite would pass while testing nothing.
 */
async function runHook(config, pluginOptions, { logThrows = false, client: customClient } = {}) {
  const messages = [];
  const client = customClient ?? {
    app: {
      log: async ({ body }) => {
        if (logThrows) throw new Error("log transport down");
        messages.push(body);
      },
    },
  };
  const hooks = await plugin.server({ client }, { cache: false, ...pluginOptions });
  await hooks.config(config);
  // The logger is fire-and-forget now, so drain it before asserting on messages.
  await hooks.flushLogs();
  return { config, messages, hooks, text: messages.map((m) => m.message).join("\n") };
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  const silence = console.info, w = console.warn, e = console.error;
  console.info = console.warn = console.error = () => {};
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push({ name, err });
  } finally {
    console.info = silence; console.warn = w; console.error = e;
    resetFetch();
  }
  if (!failures.some((f) => f.name === name)) console.log(`  ok   ${name}`);
  else console.log(`  FAIL ${name}`);
}

await test("discovers and populates an empty models map", async () => {
  const { config } = await runHook({ provider: { p: provider() } });
  assert.deepEqual(Object.keys(config.provider.p.models), ["kimi-k2.7-code", "qwen-vl-max", "tiny-1b"]);
});

await test("applies default limits and infers image modality", async () => {
  const { config } = await runHook({ provider: { p: provider() } });
  assert.deepEqual(config.provider.p.models["tiny-1b"].limit, { context: 128000, output: 16384 });
  assert.deepEqual(config.provider.p.models["qwen-vl-max"].modalities.input, ["text", "image"]);
  assert.deepEqual(config.provider.p.models["tiny-1b"].modalities.input, ["text"]);
});

await test("explains the skip when a manual models block exists", async () => {
  const { config, text } = await runHook({ provider: { p: provider({ models: { mine: { name: "mine" } } }) } });
  assert.deepEqual(Object.keys(config.provider.p.models), ["mine"]);
  assert.match(text, /Skipping p: it already defines 1 model\(s\) manually/);
});

await test("explains the skip when autoModels is false", async () => {
  const { text } = await runHook({ provider: { p: provider({ options: { autoModels: false } }) } });
  assert.match(text, /Skipping p: options\.autoModels is false/);
});

await test("discovers from an unauthenticated endpoint with no apiKey", async () => {
  const { config, text } = await runHook({
    provider: { p: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://api.example.com/v1" } } },
  });
  assert.equal(Object.keys(config.provider.p.models).length, 3, "a local proxy needs no key");
  assert.match(text, /p has no options\.apiKey; querying .* unauthenticated/);
});

await test("omits the Authorization header entirely when there is no apiKey", async () => {
  let seen;
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen = init.headers; return real(url, init); };
  try {
    await runHook({ provider: { p: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://api.example.com/v1" } } } });
    assert.equal("Authorization" in seen, false, "no Bearer undefined");
    await runHook({ provider: { p: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://api.example.com/v1", apiKey: "sk-x" } } } });
    assert.equal(seen.Authorization, "Bearer sk-x");
  } finally {
    globalThis.fetch = real;
  }
});

await test("explains the skip when baseURL is absent", async () => {
  const { text } = await runHook({ provider: { p: { npm: "@ai-sdk/openai-compatible", options: { apiKey: "k" } } } });
  assert.match(text, /Skipping p: no options\.baseURL/);
});

await test("explains the skip for a non-openai-compatible driver", async () => {
  const { text } = await runHook({ provider: { p: { npm: "@ai-sdk/anthropic", options: { baseURL: "https://x/v1", apiKey: "k" } } } });
  assert.match(text, /not "@ai-sdk\/openai-compatible"/);
});

await test("autoModels:true merges manual metadata over discovered defaults", async () => {
  const { config } = await runHook({
    provider: { p: provider({ models: { "tiny-1b": { name: "TINY", limit: { context: 9, output: 9 } } }, options: { autoModels: true } }) },
  });
  assert.deepEqual(Object.keys(config.provider.p.models), ["kimi-k2.7-code", "qwen-vl-max", "tiny-1b"]);
  assert.equal(config.provider.p.models["tiny-1b"].name, "TINY");
  assert.deepEqual(config.provider.p.models["tiny-1b"].limit, { context: 9, output: 9 });
  assert.ok(config.provider.p.models["tiny-1b"].modalities, "discovered modalities survive the merge");
});

await test("modelLimits and exclude filter apply", async () => {
  const { config } = await runHook({
    provider: { p: provider({ options: { modelLimits: [{ pattern: "kimi-k2\\.7", context: 262144, output: 32768 }], autoModelsExclude: "tiny" } }) },
  });
  assert.deepEqual(Object.keys(config.provider.p.models), ["kimi-k2.7-code", "qwen-vl-max"]);
  assert.deepEqual(config.provider.p.models["kimi-k2.7-code"].limit, { context: 262144, output: 32768 });
});

await test("include filter applies", async () => {
  const { config } = await runHook({ provider: { p: provider({ options: { autoModelsInclude: "kimi" } }) } });
  assert.deepEqual(Object.keys(config.provider.p.models), ["kimi-k2.7-code"]);
});

await test("a failing provider is named correctly and does not affect a healthy one", async () => {
  const { config, text } = await runHook({
    provider: {
      ok: provider(),
      bad: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://broken.example/v1", apiKey: "k" } },
    },
  }, { retries: 0 });
  assert.equal(Object.keys(config.provider.ok.models).length, 3);
  assert.equal(config.provider.bad.models, undefined);
  assert.match(text, /Discovery failed for bad at https:\/\/broken\.example\/v1\/models/);
  assert.doesNotMatch(text, /Discovery failed for ok/);
});

await test("an HTTP error is reported with its status", async () => {
  const { text } = await runHook({
    provider: { p: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://unauthorized.example/v1", apiKey: "k" } } },
  }, { retries: 0 });
  assert.match(text, /HTTP 401 Unauthorized/);
});

await test("discovery still succeeds when the log transport throws", async () => {
  const { config } = await runHook({ provider: { p: provider() } }, undefined, { logThrows: true });
  assert.equal(Object.keys(config.provider.p.models).length, 3, "a broken logger must not abort the hook");
});

await test("dryRun reports without mutating the config", async () => {
  const { config, text } = await runHook({ provider: { p: provider() } }, { dryRun: true });
  assert.equal(config.provider.p.models, undefined);
  assert.match(text, /\[dry-run\] Would fetch models for p/);
});

await test("baseURL without a trailing slash still resolves to /models", async () => {
  const { text } = await runHook({ provider: { p: provider({ options: { baseURL: "https://broken.example/v1" } }) } }, { retries: 0 });
  assert.match(text, /https:\/\/broken\.example\/v1\/models/);
});

await test("exports exactly one entry point, carrying both runtimes", async () => {
  const mod = await import("../src/index.js");
  // opencode's v1 loader iterates every export, so a second one registers the
  // hook twice and fetches every provider twice per config load.
  assert.deepEqual(Object.keys(mod), ["default"]);
  assert.equal(mod.default.id, "auto-models");
  assert.equal(typeof mod.default.setup, "function", "v2 reads setup()");
  assert.equal(typeof mod.default.server, "function", "v1 reads server()");
});

await test("logs a load line even before any provider is examined", async () => {
  const { text } = await runHook({ provider: {} });
  assert.match(text, /\[auto-models:server\] Loaded/);
});

// ─── v2 entrypoint ──────────────────────────────────────────────────────────

/**
 * The v2 entrypoint has no hooks object to hang a flush on, so tests that assert
 * on log messages cross one macrotask boundary to let the fire-and-forget log
 * queue drain. Every link in that queue is a `.then`, so one boundary is enough.
 */
const drain = () => new Promise((r) => setTimeout(r, 0));

/** Stand-in for v2's provider domain, matching the documented record shape. */
function makeV2Ctx(records, { setThrows = false } = {}) {
  const messages = [];
  const consoleErrors = [];
  const applied = {};
  return {
    applied,
    messages,
    consoleErrors,
    ctx: {
      // Same reasoning as runHook: without this the v2 path resolves a real
      // cache directory, and a warm hit schedules a detached refresh whose
      // completion log lands in whichever test happens to be capturing the
      // console when it resolves.
      options: { cache: false },
      client: { app: { log: async ({ body }) => messages.push(body) } },
      provider: {
        list: async () => records,
        transform: async (fn) => {
          const original = console.error;
          console.error = (...a) => consoleErrors.push(a.join(" "));
          try {
            const r = fn({
              models: {
                set: (id, models) => {
                  if (setThrows) throw new Error("invalid model record");
                  applied[id] = models;
                },
              },
            });
            assert.equal(r, undefined, "the transform callback must be synchronous");
          } finally {
            console.error = original;
          }
        },
      },
    },
  };
}

const v2Record = (over = {}) => ({
  provider: {
    id: "p",
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: "https://api.example.com/v1", apiKey: "sk-test" },
    ...over,
  },
});

await test("v2 setup discovers models and applies them via editor.models.set", async () => {
  const h = makeV2Ctx([v2Record()]);
  await plugin.setup(h.ctx);
  await drain();
  assert.deepEqual(h.applied.p.map((m) => m.id), ["kimi-k2.7-code", "qwen-vl-max", "tiny-1b"]);
});

await test("v2 models carry the required Model.Info fields", async () => {
  const h = makeV2Ctx([v2Record()]);
  await plugin.setup(h.ctx);
  await drain();
  const m = h.applied.p.find((x) => x.id === "qwen-vl-max");
  assert.equal(m.modelID, "qwen-vl-max");
  assert.equal(m.providerID, "p");
  assert.equal(m.status, "active");
  assert.equal(m.enabled, true);
  assert.deepEqual(m.variants, []);
  assert.deepEqual(m.cost, []);
  assert.equal(typeof m.time.released, "number");
  assert.deepEqual(m.limit, { context: 128000, output: 16384 });
  // v1 `modalities` becomes v2 `capabilities`; there is no `modalities` key.
  assert.deepEqual(m.capabilities.input, ["text", "image"]);
  assert.deepEqual(m.capabilities.output, ["text"]);
  assert.equal(m.capabilities.tools, true);
  assert.equal(m.modalities, undefined);
});

await test("v2 transform callback does no async work inside it", async () => {
  // makeV2Ctx asserts the callback returns undefined rather than a promise:
  // v2 replays transforms on every rebuild and does not await them.
  const h = makeV2Ctx([v2Record()]);
  await plugin.setup(h.ctx);
  await drain();
  assert.ok(h.applied.p, "models were still applied");
});

await test("v2 setup reports a rejected models.set instead of failing silently", async () => {
  const h = makeV2Ctx([v2Record()], { setThrows: true });
  await plugin.setup(h.ctx);
  await drain();
  assert.match(h.consoleErrors.join("\n"), /editor\.models\.set rejected 3 model\(s\) for p: .*invalid model record/s);
});

await test("v2 setup names a provider whose settings cannot be read", async () => {
  const h = makeV2Ctx([{ provider: { id: "mystery", package: "x" } }]);
  await plugin.setup(h.ctx);
  await drain();
  assert.match(h.messages.map((m) => m.message).join("\n"), /Cannot read connection settings for provider mystery/);
});

await test("v2 setup applies the same eligibility rules as v1", async () => {
  const h = makeV2Ctx([v2Record({ settings: { baseURL: "https://api.example.com/v1", apiKey: "k", autoModels: false } })]);
  await plugin.setup(h.ctx);
  await drain();
  assert.equal(h.applied.p, undefined);
  assert.match(h.messages.map((m) => m.message).join("\n"), /Skipping p: options\.autoModels is false/);
});

await test("setup() is silent when a v1 runtime calls it with a v1 input", async () => {
  // A v1 runtime calls server() and then also calls setup() on the same
  // entrypoint object. Discovery already happened; setup() must say nothing.
  const messages = [];
  const consoleErrors = [];
  const real = console.error, realInfo = console.info, realWarn = console.warn;
  console.error = console.info = console.warn = (...a) => consoleErrors.push(a.join(" "));
  try {
    await plugin.setup({
      client: { app: { log: async ({ body }) => messages.push(body) } },
      project: {}, directory: "/tmp", worktree: "/tmp", $: () => {},
    });
  } finally {
    await drain();
    console.error = real; console.info = realInfo; console.warn = realWarn;
  }
  assert.deepEqual(messages, [], "no log lines on a v1 input");
  assert.deepEqual(consoleErrors, [], "and nothing on the console either");
});

await test("setup() still reports a real v2 runtime whose provider domain is broken", async () => {
  const messages = [];
  await plugin.setup({
    options: { cache: false },
    client: { app: { log: async ({ body }) => messages.push(body) } },
    provider: {},
  });
  await drain();
  assert.match(messages.map((m) => m.message).join("\n"), /ctx\.provider exists but has no transform/);
});

// ─── Model-list cache ───────────────────────────────────────────────────────

function memStore() {
  const map = new Map();
  return {
    map,
    dir: "/memory",
    async read(k) { return map.get(k) ?? null; },
    async write(k, v) { map.set(k, v); },
  };
}

const runCached = (config, store, pluginOptions = {}) =>
  runHook(config, { cache: true, cacheStore: store, ...pluginOptions });

/** Rewinds every stored entry's savedAt, to simulate an expired cache. */
function age(store, ms) {
  for (const [k, v] of store.map) {
    const entry = JSON.parse(v);
    entry.savedAt -= ms;
    store.map.set(k, JSON.stringify(entry));
  }
}

const A_LONG_TIME = 90_000_000; // comfortably past the 24h default TTL

await test("a cold cache fetches and writes a versioned entry", async () => {
  const store = memStore();
  const { config } = await runCached({ provider: { p: provider() } }, store);
  assert.equal(Object.keys(config.provider.p.models).length, 3);
  assert.equal(fetchCount, 1);
  assert.equal(store.map.size, 1);

  const entry = JSON.parse([...store.map.values()][0]);
  assert.equal(entry.v, 1);
  assert.equal(entry.providerId, "p");
  assert.equal(entry.url, "https://api.example.com/v1/models");
  assert.equal(entry.keyed, true);
  // The raw payload is cached, never the built model map.
  assert.deepEqual(entry.data.map((m) => m.id), ["kimi-k2.7-code", "qwen-vl-max", "tiny-1b"]);
  assert.equal(JSON.stringify(entry).includes("sk-test"), false, "no credential material on disk");
});

await test("a warm cache serves startup with the network down", async () => {
  const store = memStore();
  await runCached({ provider: { p: provider() } }, store);

  fetchImpl = async () => { throw new Error("network on the startup path"); };
  const { config, hooks } = await runCached({ provider: { p: provider() } }, store);
  assert.equal(Object.keys(config.provider.p.models).length, 3, "a cache hit must not need the network");
  await hooks.settle();
});

await test("startup does not wait for the background refresh", async () => {
  const store = memStore();
  await runCached({ provider: { p: provider() } }, store);

  let release;
  fetchImpl = () => new Promise((r) => { release = () => r(payload(["refreshed-1", "refreshed-2"])); });

  // If the hook awaited the refresh this would never resolve.
  const { config, hooks } = await runCached({ provider: { p: provider() } }, store);
  assert.equal(Object.keys(config.provider.p.models).length, 3, "served from cache while the refresh is still in flight");

  release();
  await hooks.settle();
  assert.deepEqual(
    JSON.parse([...store.map.values()][0]).data.map((m) => m.id),
    ["refreshed-1", "refreshed-2"],
    "the refresh landed in the cache for the next start"
  );
});

await test("a fresh entry still honours the current filters, with no refetch", async () => {
  const store = memStore();
  await runCached({ provider: { p: provider() } }, store);

  fetchImpl = async () => { throw new Error("network on the startup path"); };
  const { config, hooks } = await runCached(
    { provider: { p: provider({ options: { autoModelsExclude: "tiny" } }) } },
    store
  );
  // Proves caching the raw payload rather than the built map is the right call:
  // editing a filter takes effect with no cache bust and no network.
  assert.deepEqual(Object.keys(config.provider.p.models), ["kimi-k2.7-code", "qwen-vl-max"]);
  await hooks.settle();
});

await test("an expired entry is refetched before startup continues", async () => {
  const store = memStore();
  await runCached({ provider: { p: provider() } }, store);
  age(store, A_LONG_TIME);

  fetchImpl = async () => payload(["fresh-1"]);
  const { config, hooks } = await runCached({ provider: { p: provider() } }, store);
  assert.deepEqual(Object.keys(config.provider.p.models), ["fresh-1"]);
  await hooks.settle();
});

await test("an expired entry is served when the refetch fails", async () => {
  const store = memStore();
  await runCached({ provider: { p: provider() } }, store);
  age(store, A_LONG_TIME);

  fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
  const { config, text } = await runCached({ provider: { p: provider() } }, store, { retries: 0 });
  assert.equal(Object.keys(config.provider.p.models).length, 3, "stale models beat no models");
  assert.match(text, /falling back to the expired cached list/);
});

await test("a savedAt in the future is treated as expired, not fresh", async () => {
  const store = memStore();
  await runCached({ provider: { p: provider() } }, store);
  age(store, -A_LONG_TIME); // clock skew, or a resumed VM

  fetchImpl = async () => payload(["recovered"]);
  const { config, hooks } = await runCached({ provider: { p: provider() } }, store);
  assert.deepEqual(Object.keys(config.provider.p.models), ["recovered"], "a bad clock must not pin an entry forever");
  await hooks.settle();
});

await test("a failed fetch writes no cache entry", async () => {
  const store = memStore();
  fetchImpl = async () => { throw new Error("ECONNREFUSED"); };
  const { config } = await runCached({ provider: { p: provider() } }, store, { retries: 0 });
  assert.equal(config.provider.p.models, undefined);
  assert.equal(store.map.size, 0, "an outage must not become sticky for a whole TTL");
});

await test("a corrupt entry is treated as a miss", async () => {
  const store = memStore();
  await runCached({ provider: { p: provider() } }, store);
  store.map.set([...store.map.keys()][0], "{not json");

  fetchCount = 0;
  const { config } = await runCached({ provider: { p: provider() } }, store);
  assert.equal(Object.keys(config.provider.p.models).length, 3);
  assert.equal(fetchCount, 1);
});

await test("a changed baseURL or apiKey does not reuse the old entry", async () => {
  const store = memStore();
  await runCached({ provider: { p: provider() } }, store);
  await runCached({ provider: { p: provider({ options: { baseURL: "https://other.example/v1" } }) } }, store);
  await runCached({ provider: { p: provider({ options: { apiKey: "sk-rotated" } }) } }, store);
  // Rotating to another account's key can legitimately change the model list.
  assert.equal(store.map.size, 3, "the URL and the credential are both part of the key");
});

await test("refresh: true ignores an otherwise fresh entry", async () => {
  const store = memStore();
  await runCached({ provider: { p: provider() } }, store);

  fetchImpl = async () => payload(["forced"]);
  const { config } = await runCached({ provider: { p: provider() } }, store, { refresh: true });
  assert.deepEqual(Object.keys(config.provider.p.models), ["forced"]);
});

await test("autoModelsCacheTtl expires an entry per provider", async () => {
  const store = memStore();
  await runCached({ provider: { p: provider() } }, store);
  age(store, 60_000);

  fetchImpl = async () => payload(["hourly"]);
  const { config, hooks } = await runCached(
    { provider: { p: provider({ options: { autoModelsCacheTtl: 1000 } }) } },
    store
  );
  assert.deepEqual(Object.keys(config.provider.p.models), ["hourly"]);
  await hooks.settle();
});

await test("cache: false fetches every run and writes nothing", async () => {
  const store = memStore();
  await runHook({ provider: { p: provider() } }, { cache: false, cacheStore: store });
  await runHook({ provider: { p: provider() } }, { cache: false, cacheStore: store });
  assert.equal(fetchCount, 2, "no memoisation when the cache is off");
  assert.equal(store.map.size, 0, "and nothing written through the injected store either");
});

await test("a config reload does not fan out a second background refresh", async () => {
  const store = memStore();
  await runCached({ provider: { p: provider() } }, store);

  // opencode re-runs the config hook on every config reload.
  const hooks = await plugin.server({ client: { app: { log: async () => {} } } }, { cache: true, cacheStore: store });
  fetchCount = 0;
  await hooks.config({ provider: { p: provider() } });
  await hooks.config({ provider: { p: provider() } });
  await hooks.settle();
  assert.equal(fetchCount, 1, "one refresh per provider per plugin instance, not per reload");
});

await test("a store whose read and write both reject cannot break discovery", async () => {
  const store = {
    dir: "/broken",
    async read() { throw new Error("EACCES"); },
    async write() { throw new Error("EACCES"); },
  };
  const { config } = await runCached({ provider: { p: provider() } }, store);
  assert.equal(Object.keys(config.provider.p.models).length, 3);
});

await test("dryRun reports the cache state it would use", async () => {
  const store = memStore();
  await runCached({ provider: { p: provider() } }, store);
  const { config, text } = await runCached({ provider: { p: provider() } }, store, { dryRun: true });
  assert.equal(config.provider.p.models, undefined);
  assert.match(text, /\[dry-run\] Would serve p from the cached model list/);
});

// ─── Non-blocking logger ────────────────────────────────────────────────────

await test("a client.app.log that never resolves does not block the config hook", async () => {
  // This deadlocked before the logger stopped being awaited.
  const hooks = await plugin.server({ client: { app: { log: () => new Promise(() => {}) } } }, { cache: false });
  const config = { provider: { p: provider() } };
  await hooks.config(config);
  assert.equal(Object.keys(config.provider.p.models).length, 3);
});

await test("structured log messages keep their order", async () => {
  const { messages } = await runHook({ provider: { p: provider() } });
  const order = messages.map((m) => m.message);
  assert.ok(order[0].includes("Loaded (v1 entrypoint)"), "the load line comes first");
  assert.ok(order.some((m) => m.includes("Config hook running")), "and the hook line after it");
});

// ─── Real filesystem store ──────────────────────────────────────────────────

const withTempDir = async (fn) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-models-"));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

await test("the real filesystem store writes an entry and serves the next start from it", async () => {
  await withTempDir(async (root) => {
    const dir = path.join(root, "cache");
    const { config: cold } = await runHook({ provider: { p: provider() } }, { cache: true, cacheDir: dir });
    assert.equal(Object.keys(cold.provider.p.models).length, 3);

    const files = await fs.readdir(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^p\.[0-9a-f]{8}\.json$/, "slug plus hash, and no leftover .tmp file");

    fetchImpl = async () => { throw new Error("network on the startup path"); };
    const { config: warm, hooks } = await runHook({ provider: { p: provider() } }, { cache: true, cacheDir: dir });
    assert.equal(Object.keys(warm.provider.p.models).length, 3, "served from the real cache file");
    await hooks.settle();
  });
});

await test("a provider id cannot escape the cache directory", async () => {
  await withTempDir(async (root) => {
    const dir = path.join(root, "cache");
    await runHook({ provider: { "../../pwned": provider() } }, { cache: true, cacheDir: dir });

    assert.deepEqual(await fs.readdir(root), ["cache"], "nothing was written outside the cache directory");
    const files = await fs.readdir(dir);
    assert.equal(files.length, 1);
    assert.doesNotMatch(files[0], /[\\/]|\.\./, "the id is slugified, not interpolated");
  });
});

await test("an unwritable cache directory degrades to a plain fetch", async () => {
  await withTempDir(async (root) => {
    const notADir = path.join(root, "file");
    await fs.writeFile(notADir, "");
    const { config, text } = await runHook(
      { provider: { p: provider() } },
      { cache: true, cacheDir: path.join(notADir, "nested") }
    );
    assert.equal(Object.keys(config.provider.p.models).length, 3, "discovery still works without a cache");
    assert.match(text, /Cannot write the model cache/);
  });
});

// A detached background refresh turns a bug into an unhandled rejection rather
// than a failed assertion, so this is the backstop for the whole cache section.
await new Promise((r) => setTimeout(r, 50));
await test("no promise was left unhandled", async () => {
  assert.deepEqual(unhandled.map((e) => String(e)), []);
});

await test("no test wrote to the real cache directory", async () => {
  // Anything here escaped its own `cache: false` and would have polluted the
  // developer's ~/.cache/opencode/auto-models without the sandbox above.
  assert.deepEqual(await fs.readdir(SANDBOX), []);
});
await fs.rm(SANDBOX, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`\n${f.name}\n${f.err.stack}`);
process.exit(failures.length ? 1 : 0);
