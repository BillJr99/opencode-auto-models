/**
 * opencode v1 adapter. v1 hands the plugin its whole config object through the
 * `config` hook and builds the model catalog from `cfg.provider` once the hook
 * resolves, so discovered models are applied by mutating that object in place.
 */

import { createLogger, discoverAll, errorDetail, mergeWithManual, resolveSettings, settleBackground } from "./core.js";

export function createV1Hooks({ client }, options) {
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
