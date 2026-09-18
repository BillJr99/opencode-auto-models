/**
 * Runs on plain node with no dependencies: `node test/run.mjs`.
 * Stubs the opencode client and global fetch so discovery can be exercised
 * without an opencode install.
 */
import assert from "node:assert/strict";
import { AutoModelsPlugin } from "../src/index.js";

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
  const hooks = await AutoModelsPlugin({ client }, pluginOptions);
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

await test("logs a load line even before any provider is examined", async () => {
  const { text } = await runHook({ provider: {} });
  assert.match(text, /\[auto-models:AutoModelsPlugin\] Loaded/);
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

await test("explains the skip when apiKey is absent", async () => {
  const { text } = await runHook({ provider: { p: { npm: "@ai-sdk/openai-compatible", options: { baseURL: "https://x/v1" } } } });
  assert.match(text, /Skipping p: missing options\.apiKey/);
  assert.match(text, /auth\.json/);
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

await test("exports exactly one plugin entry point", async () => {
  const mod = await import("../src/index.js");
  // opencode's v1 loader iterates every export, so a duplicate registers the
  // hook twice and fetches every provider twice per config load.
  assert.deepEqual(Object.keys(mod), ["AutoModelsPlugin"]);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`\n${f.name}\n${f.err.stack}`);
process.exit(failures.length ? 1 : 0);
