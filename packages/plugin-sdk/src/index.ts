// packages/plugin-sdk/src/index.ts

// Re-export shared types needed by plugin authors
export type {
  PluginManifest,
  PluginMatchRule,
  PluginContext,
  IDevicePlugin,
  PluginFactory,
  PluginInfo,
  PluginStatus,
} from '@devbridge/shared';

export type { DeviceInfo, DeviceEvent } from '@devbridge/shared';
export type { CommandResult } from '@devbridge/shared';

// ── IPC RPC helper (used internally by createPluginContext) ───────────────────

type IpcRpcOptions = { timeoutMs?: number };

function ipcRpc(
  msg: { type: string; payload: Record<string, unknown> },
  opts: IpcRpcOptions = {},
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const correlationId = Math.random().toString(36).slice(2);
    const timeoutMs = opts.timeoutMs ?? 10_000;

    const timer = setTimeout(() => {
      process.off('message', handler as NodeJS.MessageListener);
      reject(new Error(`IPC RPC timeout for '${msg.type}'`));
    }, timeoutMs);

    const handler = (response: unknown) => {
      const r = response as { type: string; correlationId?: string; payload: Record<string, unknown> };
      if (r.type === `${msg.type}_REPLY` && r.correlationId === correlationId) {
        clearTimeout(timer);
        process.off('message', handler as NodeJS.MessageListener);
        resolve(r.payload);
      }
    };

    process.on('message', handler as NodeJS.MessageListener);
    process.send!({ ...msg, correlationId });
  });
}

// ── createPluginContext ────────────────────────────────────────────────────────

import type { PluginContext, PluginManifest } from '@devbridge/shared';

/**
 * Creates a PluginContext object for use inside a plugin Child Process.
 *
 * DevBridge injects `DEVBRIDGE_DEVICE_ID` and `DEVBRIDGE_MANIFEST` into the
 * child process environment before calling `plugin.init(ctx)`.
 */
export function createPluginContext(): PluginContext {
  const deviceId  = process.env['DEVBRIDGE_DEVICE_ID'] ?? '';
  const manifest: PluginManifest = JSON.parse(
    process.env['DEVBRIDGE_MANIFEST'] ?? '{}',
  ) as PluginManifest;

  return {
    deviceId,
    manifest,

    async sendCommand(commandId, params) {
      const result = await ipcRpc({ type: 'COMMAND_SEND', payload: { commandId, params } });
      return result as Awaited<ReturnType<PluginContext['sendCommand']>>;
    },

    async readReport(reportId) {
      const res = await ipcRpc({ type: 'READ_REPORT', payload: { reportId } });
      return Buffer.from(res['buffer'] as Iterable<number>);
    },

    async writeReport(reportId, data) {
      await ipcRpc({ type: 'WRITE_REPORT', payload: { reportId, data: Array.from(data) } });
    },

    onEvent(callback) {
      const handler = (msg: unknown) => {
        const m = msg as { type: string; payload: unknown };
        if (m.type === 'DEVICE_EVENT') callback(m.payload as Parameters<typeof callback>[0]);
      };
      process.on('message', handler as NodeJS.MessageListener);
      return () => process.off('message', handler as NodeJS.MessageListener);
    },

    logger: {
      info:  (msg, meta) => process.send?.({ type: 'LOG_ENTRY', payload: { level: 'info',  msg, meta } }),
      warn:  (msg, meta) => process.send?.({ type: 'LOG_ENTRY', payload: { level: 'warn',  msg, meta } }),
      error: (msg, meta) => process.send?.({ type: 'LOG_ENTRY', payload: { level: 'error', msg, meta } }),
    },

    async flush() {
      await ipcRpc({ type: 'FLUSH_PENDING', payload: {} }, { timeoutMs: 30_000 });
    },
  };
}
