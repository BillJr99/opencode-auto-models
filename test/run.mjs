/**
 * Runs on plain node with no dependencies: `node test/run.mjs`.
 * Stubs the opencode client and global fetch so discovery can be exercised
 * without an opencode install.
 */
import assert from "node:assert/strict";
import plugin from "../src/index.js";

const MODELS = [{ id: "kimi-k2.7-code" }, { id: "qwen-vl-max" }, { id: "tiny-1b" }];

globalThis.fetch = async (url) => {
  if (String(url).includes("broken")) throw new Error("ECONNREFUSED");
  if (String(url).includes("unauthorized")) return { ok: false, status: 401, statusText: "Unauthorized" };
  return { ok: true, status: 200, statusText: "OK", json: async () => ({ data: MODELS }) };
};

/** `options` merges into the defaults rather than replacing them. */
function provider({ options = {}, ...rest } = {}) {
  return {
    npm: "@ai-sdk/openai-compatible",
    ...rest,
    options: { baseURL: "https://api.example.com/v1", apiKey: "sk-test", ...options },
  };
}

async function runHook(config, pluginOptions, { logThrows = false } = {}) {
  const messages = [];
  const client = {
    app: {
      log: async ({ body }) => {
        if (logThrows) throw new Error("log transport down");
        messages.push(body);
      },
    },
  };
  const hooks = await plugin.server({ client }, pluginOptions);
  await hooks.config(config);
  return { config, messages, text: messages.map((m) => m.message).join("\n") };
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
  assert.deepEqual(h.applied.p.map((m) => m.id), ["kimi-k2.7-code", "qwen-vl-max", "tiny-1b"]);
});

await test("v2 models carry the required Model.Info fields", async () => {
  const h = makeV2Ctx([v2Record()]);
  await plugin.setup(h.ctx);
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
  assert.ok(h.applied.p, "models were still applied");
});

await test("v2 setup reports a rejected models.set instead of failing silently", async () => {
  const h = makeV2Ctx([v2Record()], { setThrows: true });
  await plugin.setup(h.ctx);
  assert.match(h.consoleErrors.join("\n"), /editor\.models\.set rejected 3 model\(s\) for p: .*invalid model record/s);
});

await test("v2 setup names a provider whose settings cannot be read", async () => {
  const h = makeV2Ctx([{ provider: { id: "mystery", package: "x" } }]);
  await plugin.setup(h.ctx);
  assert.match(h.messages.map((m) => m.message).join("\n"), /Cannot read connection settings for provider mystery/);
});

await test("v2 setup applies the same eligibility rules as v1", async () => {
  const h = makeV2Ctx([v2Record({ settings: { baseURL: "https://api.example.com/v1", apiKey: "k", autoModels: false } })]);
  await plugin.setup(h.ctx);
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
    console.error = real; console.info = realInfo; console.warn = realWarn;
  }
  assert.deepEqual(messages, [], "no log lines on a v1 input");
  assert.deepEqual(consoleErrors, [], "and nothing on the console either");
});

await test("setup() still reports a real v2 runtime whose provider domain is broken", async () => {
  const messages = [];
  await plugin.setup({
    client: { app: { log: async ({ body }) => messages.push(body) } },
    provider: {},
  });
  assert.match(messages.map((m) => m.message).join("\n"), /ctx\.provider exists but has no transform/);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`\n${f.name}\n${f.err.stack}`);
process.exit(failures.length ? 1 : 0);
