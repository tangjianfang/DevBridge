// packages/server/src/plugin-loader/__tests__/plugin-loader.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { Script } from 'node:vm';
import type { ChildProcess } from 'node:child_process';
import { build } from 'esbuild';
import { sandboxPlugin } from '../sandbox-plugin.js';
import { validatePluginExports, RUNTIME_FORBIDDEN } from '../plugin-validator.js';
import { PluginMatcher } from '../plugin-matcher.js';
import { PluginLoader, setPluginLoaderIpcSend } from '../plugin-loader.js';
import type { PluginManifest, RawDeviceInfo } from '@devbridge/shared';

// ── Helper: run a CJS bundle in vm with proper module context ───────────────

/** Minimum globals needed to execute an esbuild CJS bundle. */
const VM_BUNDLE_GLOBALS = {
  Object, Array, Function, Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError,
  String, Number, Boolean, Symbol, BigInt, Math, Date, JSON, RegExp,
  Map, Set, WeakMap, WeakSet,
  Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
  Float32Array, Float64Array, ArrayBuffer, DataView,
  Proxy, Reflect, Promise, WeakRef, FinalizationRegistry,
  parseInt, parseFloat, isFinite, isNaN,
  encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
};

import { createContext } from 'node:vm';

function runCjsBundle(code: string): { module: { exports: Record<string, unknown> } } {
  const fakeModule: { exports: Record<string, unknown> } = { exports: {} };
  const ctx = createContext({
    ...VM_BUNDLE_GLOBALS,
    module:  fakeModule,
    exports: fakeModule.exports,
  });
  new Script(code).runInContext(ctx, { timeout: 5000 });
  return { module: fakeModule };
}

// ── Mock ChildProcess helper ──────────────────────────────────────────────────

/**
 * A minimal ChildProcess mock built on EventEmitter.
 * Allows tests to:
 *   - inspect messages sent to the child via `sent`
 *   - inject replies via `reply(type, payload)`
 *   - simulate crashes via `crash(code?)`
 */
class MockChildProcess extends EventEmitter {
  readonly sent: Array<{ type: string; payload?: unknown }> = [];
  pid = 99_000 + Math.trunc(Math.random() * 1000);
  killed = false;

  send(msg: unknown): boolean {
    const m = msg as { type: string; payload?: unknown };
    this.sent.push(m);
    return true;
  }

  kill(): void {
    this.killed = true;
    // Don't auto-emit 'exit' here — callers can do that explicitly
  }

  /** Simulate child sending a message back to parent */
  reply(type: string, payload?: unknown): void {
    this.emit('message', { type, payload });
  }

  /** Simulate a crash */
  crash(code = 1): void {
    this.emit('exit', code, null);
  }

  /** Simulate a successful graceful stop */
  respondToStop(): void {
    // On receiving PLUGIN_STOP, respond with PLUGIN_STOPPED
    this.reply('PLUGIN_STOPPED', {});
  }
}

// ── Sample manifests ──────────────────────────────────────────────────────────

const USB_HID_MANIFEST_VID_PID: PluginManifest = {
  name: '@vendor/plugin-hid', version: '1.0.0', entry: 'index.js',
  match: [{ transport: 'usb-hid', vendorId: 0x1234, productId: 0x5678 }],
};

const USB_HID_MANIFEST_VID_ONLY: PluginManifest = {
  name: '@vendor/plugin-hid-vid', version: '1.0.0', entry: 'index.js',
  match: [{ transport: 'usb-hid', vendorId: 0x1234 }],
};

const USB_HID_MANIFEST_TRANSPORT_ONLY: PluginManifest = {
  name: '@vendor/plugin-hid-any', version: '1.0.0', entry: 'index.js',
  match: [{ transport: 'usb-hid' }],
};

const SERIAL_MANIFEST: PluginManifest = {
  name: '@vendor/plugin-serial', version: '1.0.0', entry: 'index.js',
  match: [{ transport: 'serial', pathPattern: '/dev/tty*' }],
};

/** Sample raw device matching USB-HID with VID 0x1234, PID 0x5678 */
const USB_DEVICE: RawDeviceInfo = {
  transportType: 'usb-hid',
  address:       '0000:1234:5678',
  vendorId:      0x1234,
  productId:     0x5678,
};

// ── Minimal valid plugin source ───────────────────────────────────────────────

const VALID_PLUGIN_SOURCE = `
export default function createPlugin(_ctx) {
  return {
    async init(_c) {},
    async onConnect(_c, _i) {},
    async onBeforeDisconnect(_c) {},
    async onDisconnect(_c, _r) {},
    async destroy(_c) {},
  };
}
`;

// ── Suite 1: sandboxPlugin ────────────────────────────────────────────────────

describe('sandboxPlugin — esbuild AST intercept', () => {
  it('stubs child_process: bundled output contains the throwing proxy', async () => {
    const result = await build({
      stdin:    { contents: `require('child_process');`, loader: 'js' },
      bundle:   true,
      format:   'cjs',
      platform: 'node',
      write:    false,
      plugins:  [sandboxPlugin(['child_process'])],
      logLevel: 'silent',
    });

    const code = result.outputFiles?.[0]?.text ?? '';
    expect(code).toContain('Plugin is not allowed to use');
    expect(code).toContain('child_process');
  });

  it('throws at runtime when the plugin function calls child_process.exec', async () => {
    // The exported function defers the proxy access to call-time
    const result = await build({
      stdin: {
        contents: `module.exports = function callChild() { require('child_process').exec('ls'); };`,
        loader: 'js',
      },
      bundle:   true,
      format:   'cjs',
      platform: 'node',
      write:    false,
      plugins:  [sandboxPlugin(['child_process'])],
      logLevel: 'silent',
    });

    const code = result.outputFiles?.[0]?.text ?? '';
    expect(code.length).toBeGreaterThan(0);

    // Load the module (should succeed — the proxy trap only fires when exec is called)
    const mod = runCjsBundle(code);

    // Call the exported function — this accesses child_process.exec → proxy throws
    expect(() => (mod.module.exports as () => void)()).toThrow(
      /Plugin is not allowed to use 'child_process'/,
    );
  });

  it('does not block non-forbidden modules (passes through normal JS code)', async () => {
    // Uses only built-in JSON — no external require needed
    const result = await build({
      stdin: {
        contents: `module.exports = JSON.stringify({ hello: 'sandbox' });`,
        loader:   'js',
      },
      bundle:   true,
      format:   'cjs',
      platform: 'node',
      write:    false,
      plugins:  [sandboxPlugin(['child_process'])],  // child_process blocked; JSON is fine
      logLevel: 'silent',
    });

    const code = result.outputFiles?.[0]?.text ?? '';
    const mod  = runCjsBundle(code);
    expect(mod.module.exports).toBe(JSON.stringify({ hello: 'sandbox' }));
  });
});

// ── Suite 2: validatePluginExports — vm sandbox ────────────────────────────

describe('validatePluginExports — vm runtime protection', () => {
  it('accepts a valid plugin with a default-exported function', async () => {
    const cjsCode = `module.exports.default = function() { return {}; };`;
    await expect(validatePluginExports(cjsCode, 3000)).resolves.toBeUndefined();
  });

  it('rejects a plugin missing a default export', async () => {
    const cjsCode = `module.exports = { notDefault: 42 };`;
    await expect(validatePluginExports(cjsCode, 3000)).rejects.toThrow(/default-export/);
  });

  it('blocks dynamically-required forbidden modules at runtime', async () => {
    // Even if esbuild didn't intercept it (e.g. dynamic eval), sandboxRequire throws
    for (const mod of RUNTIME_FORBIDDEN) {
      const cjsCode = `
        try { require(${JSON.stringify(mod)}); } catch(e) { throw e; }
        module.exports.default = function(){};
      `;
      await expect(validatePluginExports(cjsCode, 3000)).rejects.toThrow(
        new RegExp(`Plugin is not allowed to use '${mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
      );
    }
  });

  it('throws Script execution timed out when plugin has an infinite loop', async () => {
    const cjsCode = `while(true){} module.exports.default = function(){};`;
    // Use a short timeout (200ms) so the test runs quickly
    await expect(validatePluginExports(cjsCode, 200)).rejects.toThrow(/timed out/i);
  }, 5_000); // allow 5s for this test
});

// ── Suite 3: PluginMatcher ─────────────────────────────────────────────────

describe('PluginMatcher', () => {
  it('returns null when no manifests match', () => {
    expect(PluginMatcher.match(USB_DEVICE, [SERIAL_MANIFEST])).toBeNull();
  });

  it('returns the only matching manifest', () => {
    const result = PluginMatcher.match(USB_DEVICE, [USB_HID_MANIFEST_TRANSPORT_ONLY, SERIAL_MANIFEST]);
    expect(result?.name).toBe('@vendor/plugin-hid-any');
  });

  it('prefers VID+PID match (+310) over VID-only (+110) over transport-only (+10)', () => {
    const result = PluginMatcher.match(USB_DEVICE, [
      USB_HID_MANIFEST_TRANSPORT_ONLY,  // +10
      USB_HID_MANIFEST_VID_ONLY,        // +110
      USB_HID_MANIFEST_VID_PID,         // +310  ← best
      SERIAL_MANIFEST,                  // +0
    ]);
    expect(result?.name).toBe('@vendor/plugin-hid');
  });

  it('scoreManifest returns 0 for wrong transport type', () => {
    expect(PluginMatcher.scoreManifest(USB_DEVICE, SERIAL_MANIFEST)).toBe(0);
  });

  it('scoreManifest returns +310 for transport+VID+PID', () => {
    expect(PluginMatcher.scoreManifest(USB_DEVICE, USB_HID_MANIFEST_VID_PID)).toBe(310);
  });

  it('scoreManifest returns +110 for transport+VID (no productId match)', () => {
    const raw: RawDeviceInfo = { ...USB_DEVICE, productId: 0x9999 };
    expect(PluginMatcher.scoreManifest(raw, USB_HID_MANIFEST_VID_PID)).toBe(110);
  });

  it('scoreManifest returns +10 for transport-only match', () => {
    expect(PluginMatcher.scoreManifest(USB_DEVICE, USB_HID_MANIFEST_TRANSPORT_ONLY)).toBe(10);
  });
});

// ── Suite 4: hotUpdate ────────────────────────────────────────────────────

describe('PluginLoader.hotUpdate()', () => {
  let loader: PluginLoader;
  let ipcMessages: Array<{ type: string }>;
  let mockChild: MockChildProcess;
  const PLUGIN_ID = 'test-plugin';

  beforeEach(() => {
    ipcMessages = [];
    setPluginLoaderIpcSend(msg => ipcMessages.push(msg as { type: string }));

    mockChild = new MockChildProcess();
    loader    = new PluginLoader();

    loader._registerPlugin(PLUGIN_ID, USB_HID_MANIFEST_VID_PID, mockChild as unknown as ChildProcess);
  });

  afterEach(() => {
    setPluginLoaderIpcSend(() => {});
  });

  it('hotUpdate succeeds: status becomes running, PLUGIN_HOT_UPDATED sent', async () => {
    // Auto-respond to PLUGIN_HOT_UPDATE
    const origSend = mockChild.send.bind(mockChild);
    mockChild.send = (msg: unknown) => {
      origSend(msg);
      const m = msg as { type: string };
      if (m.type === 'PLUGIN_HOT_UPDATE') {
        setImmediate(() => mockChild.reply('PLUGIN_HOT_UPDATED', {}));
      }
      return true;
    };

    const info = await loader.hotUpdate(PLUGIN_ID, VALID_PLUGIN_SOURCE);

    expect(info.status).toBe('running');
    expect(ipcMessages.some(m => m.type === 'PLUGIN_HOT_UPDATED')).toBe(true);
  }, 15_000);

  it('hotUpdate rollback: invalid source sets status to error, old process unchanged', async () => {
    const invalidSource = `export const x = 42;`; // no default export

    await expect(loader.hotUpdate(PLUGIN_ID, invalidSource)).rejects.toThrow();

    const info = loader.getInfo(PLUGIN_ID);
    expect(info?.status).toBe('running'); // rolled back
    expect(info?.lastError).toBeDefined();
  }, 15_000);
});

// ── Suite 5: crash + restart ──────────────────────────────────────────────

describe('PluginLoader — crash and restart', () => {
  let loader: PluginLoader;
  let ipcMessages: Array<{ type: string }>;

  beforeEach(() => {
    ipcMessages = [];
    setPluginLoaderIpcSend(msg => ipcMessages.push(msg as { type: string }));
    loader = new PluginLoader();
  });

  afterEach(() => {
    setPluginLoaderIpcSend(() => {});
  });

  it('crash triggers PLUGIN_CRASHED IPC and increments restartCount', () => {
    const mockChild = new MockChildProcess();
    loader._registerPlugin('crash-plugin', USB_HID_MANIFEST_VID_PID, mockChild as unknown as ChildProcess);

    mockChild.crash(1);

    expect(ipcMessages.some(m => m.type === 'PLUGIN_CRASHED')).toBe(true);
    const info = loader.getInfo('crash-plugin');
    expect(info?.restartCount).toBeGreaterThanOrEqual(1);
  });

  it('status becomes "error" after maxRestarts crashes', () => {
    const mockChild = new MockChildProcess();
    loader._registerPlugin('crash-exhaust', USB_HID_MANIFEST_VID_PID, mockChild as unknown as ChildProcess);

    const info = loader.getInfo('crash-exhaust')!;
    info.restartCount = 3; // simulate already at max

    mockChild.crash(1);

    expect(info.status).toBe('error');
    expect(ipcMessages.some(m => m.type === 'PLUGIN_CRASHED')).toBe(true);
  });
});

// ── Suite 6: graceful stop ────────────────────────────────────────────────

describe('PluginLoader — graceful stop (PLUGIN_UNLOAD)', () => {
  let loader: PluginLoader;

  beforeEach(() => {
    setPluginLoaderIpcSend(() => {});
    loader = new PluginLoader();
  });

  afterEach(() => {
    setPluginLoaderIpcSend(() => {});
  });

  it('PLUGIN_STOP is sent to child; process killed after PLUGIN_STOPPED', async () => {
    const mockChild = new MockChildProcess();

    // Auto-respond to PLUGIN_STOP
    const origSend = mockChild.send.bind(mockChild);
    mockChild.send = (msg: unknown) => {
      origSend(msg);
      const m = msg as { type: string };
      if (m.type === 'PLUGIN_STOP') {
        setImmediate(() => mockChild.reply('PLUGIN_STOPPED', {}));
      }
      return true;
    };

    loader._registerPlugin('stop-plugin', USB_HID_MANIFEST_VID_PID, mockChild as unknown as ChildProcess);

    await (loader as unknown as { _drainAndKill(id: string, reason: string): Promise<void> })._drainAndKill('stop-plugin', 'test unload');

    const stopMsg = mockChild.sent.find(m => m.type === 'PLUGIN_STOP');
    expect(stopMsg).toBeDefined();
    expect(mockChild.killed).toBe(true);
  });

  it('stop() is idempotent — second call does not throw', async () => {
    await expect(loader.stop()).resolves.toBeUndefined();
    await expect(loader.stop()).resolves.toBeUndefined();
  });
});

// ── Suite 7: health() ─────────────────────────────────────────────────────

describe('PluginLoader — health()', () => {
  it('returns healthy with 0 plugins initially', async () => {
    const loader = new PluginLoader();
    const h = await loader.health();
    expect(h.status).toBe('healthy');
    expect((h.details as Record<string, number>)['plugins']).toBe(0);
  });
});
