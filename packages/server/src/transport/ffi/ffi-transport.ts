// packages/server/src/transport/ffi/ffi-transport.ts
//
// ⚠️  This file may only be require()'d inside a child_process.fork() Child Process.
//     Never import this from the main process or Worker Threads.

import type {
  TransportConfig,
  FfiConfig,
  TransportCapabilities,
  EndpointInfo,
} from '@devbridge/shared';
import type { DeviceInfo } from '@devbridge/shared';
import { BaseTransport } from '../base-transport.js';

export class FfiTransport extends BaseTransport {
  readonly transportType = 'ffi' as const;
  readonly deviceId:     string;

  private libs        = new Map<string, Record<string, (...args: unknown[]) => unknown>>();
  private config?:    FfiConfig;
  private pollTimer?: ReturnType<typeof setInterval>;
  // Must hold strong ref to FFI Callback to prevent GC crash
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _callbackRef?: unknown;

  constructor(deviceId: string = '') {
    super();
    this.deviceId = deviceId || 'ffi:pending';
  }

  static readonly capabilities: TransportCapabilities = {
    canSubscribe:      true,
    canRequest:        true,
    canBroadcast:      false,
    maxPacketSize:     65535,
    isWireless:        false,
    requiresIsolation: true,
  };

  getCapabilities(): TransportCapabilities { return FfiTransport.capabilities; }

  getEndpoints(): EndpointInfo[] {
    return [
      { id: 'ffi-in',  direction: 'in',    type: 'stream' },
      { id: 'ffi-out', direction: 'out',   type: 'stream' },
    ];
  }

  async connect(config: TransportConfig): Promise<void> {
    const cfg = config as FfiConfig;
    this.config = cfg;

    // Dynamic require — ONLY valid inside Child Process
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffi = require('node-ffi-napi') as typeof import('node-ffi-napi');

    for (const dllDef of cfg.dlls) {
      const libDef: Record<string, [string, string[]]> = {};
      for (const fn of cfg.functions) {
        libDef[fn.name] = [fn.returnType, fn.argTypes];
      }
      const lib = ffi.Library(dllDef.path, libDef) as Record<string, (...args: unknown[]) => unknown>;
      this.libs.set(dllDef.id, lib);
    }

    // Prefer callback-based notifications; fall back to polling
    if (cfg.callbacks?.length) {
      this.registerCallbacks(cfg.callbacks, ffi);
    } else {
      this.startPoll(cfg.pollIntervalMs ?? 2000);
    }

    this.setConnected(true);
  }

  async disconnect(): Promise<void> {
    this.stopPoll();
    this.libs.clear();
    this._callbackRef = undefined;
    this.setConnected(false);
  }

  async send(buffer: Buffer): Promise<void> {
    const core = this.libs.get('core');
    if (!core) {
      throw Object.assign(
        new Error('TRANSPORT_SEND_FAILED: FFI core lib not loaded'),
        { errorCode: 'TRANSPORT_SEND_FAILED' },
      );
    }
    const sendFn = core['SDK_SendCommand'] as ((buf: Buffer, len: number) => number) | undefined;
    if (!sendFn) {
      throw Object.assign(
        new Error('TRANSPORT_SEND_FAILED: SDK_SendCommand not found in DLL'),
        { errorCode: 'TRANSPORT_SEND_FAILED' },
      );
    }
    const ret = sendFn(buffer, buffer.length);
    if (ret !== 0) {
      throw Object.assign(
        new Error(`TRANSPORT_SEND_FAILED: SDK_SendCommand returned ${ret}`),
        { errorCode: 'TRANSPORT_SEND_FAILED' },
      );
    }
  }

  private registerCallbacks(
    defs: NonNullable<FfiConfig['callbacks']>,
    ffi: typeof import('node-ffi-napi'),
  ): void {
    const cb = ffi.Callback(
      'void', ['int', 'pointer', 'int'],
      (eventType: number, dataPtr: Buffer, dataLen: number) => {
        const data = Buffer.from(dataPtr.slice(0, dataLen));
        this.emitEvent(data, `ffi-callback-${eventType}`);
      },
    );
    // Strong ref — prevents GC from collecting the callback and causing native crash
    this._callbackRef = cb;
    const core = this.libs.get('core');
    if (core) {
      (core['SDK_RegisterCallback'] as ((cb: unknown) => void) | undefined)?.(cb);
    }
  }

  private startPoll(intervalMs: number): void {
    this.pollTimer = setInterval(() => {
      const core = this.libs.get('core');
      if (!core) { this.stopPoll(); return; }
      try {
        const isConnFn = core['SDK_IsConnected'] as (() => number) | undefined;
        const ok = isConnFn?.() ?? 1;
        if (!ok) this.setConnected(false, 'FFI_POLL_DISCONNECTED');
      } catch {
        this.setConnected(false, 'FFI_POLL_ERROR');
      }
    }, intervalMs);
  }

  private stopPoll(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
  }

  getInfo(): DeviceInfo {
    return {
      deviceId:       this.deviceId,
      transportType:  this.transportType,
      status:         this._connected ? 'connected' : 'disconnected',
      name:           `FFI ${this.config?.dlls?.[0]?.id ?? ''}`,
      address:        `ffi:${this.config?.dlls?.[0]?.path ?? 'unknown'}`,
      lastSeenAt:     Date.now(),
      reconnectCount: 0,
    };
  }
}
