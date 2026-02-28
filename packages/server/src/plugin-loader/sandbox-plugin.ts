// packages/server/src/plugin-loader/sandbox-plugin.ts

import type { Plugin } from 'esbuild';

/**
 * An esbuild plugin that intercepts imports of forbidden native modules and
 * replaces them with a Proxy stub that throws at runtime.
 */
export function sandboxPlugin(forbidden: readonly string[]): Plugin {
  return {
    name: 'devbridge-sandbox',
    setup(build) {
      for (const mod of forbidden) {
        // Escape the module name for use in a regex
        const escaped = mod.replace(/\//g, '\\/').replace(/\./g, '\\.');
        build.onResolve({ filter: new RegExp(`^${escaped}(/.*)?$`) }, () => ({
          path:      mod,
          namespace: 'devbridge-sandbox-stub',
        }));
      }
      build.onLoad({ filter: /.*/, namespace: 'devbridge-sandbox-stub' }, (args) => ({
        contents: `module.exports = new Proxy({}, {
  get(_t, prop) {
    throw new Error(
      '[DevBridge] Plugin is not allowed to use \\'' + '${args.path}' + '\\'. ' +
      'Use PluginContext API (sendCommand / readReport / writeReport / onEvent) instead.'
    );
  },
  apply() {
    throw new Error('[DevBridge] Plugin is not allowed to use \\'' + '${args.path}' + '\\'.');
  }
});`,
        loader: 'js',
      }));
    },
  };
}
