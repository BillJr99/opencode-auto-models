// @ts-check
/**
 * One package, two opencode plugin APIs.
 *
 * opencode v1 and v2 load the same default export and each takes the half it
 * understands, so the runtime is detected by its own loader rather than by
 * sniffing versions:
 *
 *   - v1 (1.18.29+, the first release with object entrypoints) calls
 *     `server(input, options)` and uses the returned hooks. 1.18.x also embeds
 *     the v2 *beta* runtime and, during `opencode run`, calls `setup()` with
 *     that beta context, which has no provider domain; `setup()` recognises it
 *     and returns without doing anything.
 *   - v2 reads `id` and `setup(ctx)` (the `Plugin.define` half) and ignores
 *     `server`.
 *
 * Each half is a thin adapter over the same discovery core (`./core.js`):
 * `./v1.js` mutates the config object in the `config` hook, `./v2.js` publishes
 * the inventory through `ctx.provider.transform`. Neither translates the other's
 * hooks.
 *
 * Each entrypoint also checks that it was handed its own runtime's input and
 * says so in the log if not, rather than failing silently.
 *
 * This is the module's only export on purpose: the v1 loader iterates every
 * export, so a second one would register the hook twice and fetch every
 * provider twice per config load.
 */

import { Plugin } from "@opencode/plugin";
import { createV1Hooks } from "./v1.js";
import { setupV2 } from "./v2.js";

export default {
  ...Plugin.define({
    id: "auto-models",
    setup: setupV2,
  }),

  /**
   * @param {any} input
   * @param {Record<string, any> | undefined} options
   */
  async server(input, options) {
    if (typeof input?.client?.app?.log !== "function") {
      console.warn(
        "[auto-models:server] Called without an opencode v1 plugin input (no client.app.log); " +
          "continuing with console-only logging. On opencode v2 the loader calls setup() instead."
      );
    }
    const { log, hooks } = createV1Hooks(input ?? {}, options);
    // If this line is absent from the log, the plugin was never loaded at all —
    // the single most useful signal when diagnosing a GUI front-end.
    log("info", "server", "Loaded (v1 entrypoint)");
    return hooks;
  },
};
