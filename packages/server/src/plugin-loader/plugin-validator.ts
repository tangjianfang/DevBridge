// packages/server/src/plugin-loader/plugin-validator.ts

import { Script, createContext } from 'node:vm';

/**
 * Modules that plugins are never allowed to require at runtime.
 * These are checked in the vm sandbox in addition to the esbuild AST intercept.
 */
export const RUNTIME_FORBIDDEN = [
  'child_process', 'worker_threads', 'cluster',
  'node-hid', 'serialport', '@abandonware/noble',
] as const;

/**
 * Safe built-ins to expose in the vm sandbox.
 * Provides standard JS globals without exposing Node.js-specific ones (process, require, etc.).
 */
const VM_SAFE_GLOBALS = {
  // Core objects + constructors
  Object, Array, Function, Error, TypeError, RangeError, SyntaxError,
  ReferenceError, EvalError, URIError,
  // Primitives
  String, Number, Boolean, Symbol, BigInt,
  // Math + dates
  Math, Date, JSON,
  // Collections
  Map, Set, WeakMap, WeakSet,
  // Typed arrays
  Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
  Float32Array, Float64Array, ArrayBuffer, DataView,
  // Modern
  Proxy, Reflect, Promise, WeakRef, FinalizationRegistry,
  // Utilities
  parseInt, parseFloat, isFinite,
  encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  // Suppress console output from plugins
  console: {
    log:   (..._args: unknown[]) => {},
    warn:  (..._args: unknown[]) => {},
    error: (..._args: unknown[]) => {},
    info:  (..._args: unknown[]) => {},
    debug: (..._args: unknown[]) => {},
  },
};

/**
 * Validates a compiled CJS plugin bundle by:
 * 1. Running it inside a vm sandbox with a configurable timeout (DoS guard)
 * 2. Confirming it default-exports a function (PluginFactory)
 * 3. Blocking any attempt to `require()` forbidden modules
 *
 * @throws if the plugin code is invalid, forbidden, or times out.
 */
export async function validatePluginExports(cjsCode: string, vmTimeoutMs = 3000): Promise<void> {
  const mod: { exports: Record<string, unknown> } = { exports: {} };

  const sandboxRequire = (id: string): never => {
    if (RUNTIME_FORBIDDEN.some(f => id === f || id.startsWith(f + '/'))) {
      throw new Error(`[DevBridge] Plugin is not allowed to use '${id}'.`);
    }
    throw new Error(
      `[DevBridge] require() is not available in sandbox validation context. (module: '${id}')`,
    );
  };

  // Build the vm context: safe built-ins + module/exports/require injection.
  // Using createContext isolates from the host global but provides standard JS APIs.
  const ctx = createContext({
    ...VM_SAFE_GLOBALS,
    module:  mod,
    exports: mod.exports,
    require: sandboxRequire,
  });

  // Run the plugin code directly inside the vm context.
  // The timeout covers the entire execution (including any blocking code like while(true)).
  const script = new Script(cjsCode);
  script.runInContext(ctx, { timeout: vmTimeoutMs });

  if (typeof mod.exports['default'] !== 'function') {
    throw new Error('Plugin must default-export a PluginFactory function');
  }
}
