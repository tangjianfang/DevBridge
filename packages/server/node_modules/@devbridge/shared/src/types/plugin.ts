// packages/shared/src/types/plugin.ts

import type { TransportType, FfiFunctionDef, FfiCallbackDef } from './transport.js';
import type { DeviceInfo, DeviceEvent } from './device.js';
import type { CommandResult } from './gateway.js';

export interface PluginMatchRule {
  transport:    TransportType;
  vendorId?:    number;
  productId?:   number;
  pathPattern?: string;         // serial glob
  namePrefix?:  string;         // BLE
  serviceUUID?: string;         // BLE
  portRange?:   [number, number]; // TCP
  dllPattern?:  string;         // FFI glob
}

export interface PluginFfiConfig {
  dlls: Array<{
    id:        string;
    path:      string;
    stability: 'stable' | 'unstable';
  }>;
  functions:  FfiFunctionDef[];
  callbacks?: FfiCallbackDef[];
  pollIntervalMs?: number;
}

export interface PluginManifest {
  name:         string;
  version:      string;
  description?: string;
  match:        PluginMatchRule[];
  protocol?:    string;
  entry:        string;             // relative to manifest dir
  /**
   * true (default): runs in dedicated Child Process
   * false: allowed to share a stable-group process (only if all dlls are stable)
   */
  isolation?:   boolean;           // default: true
  ffiConfig?:   PluginFfiConfig;
  reconnect?: {
    maxAttempts:      number;      // -1 = infinite
    initialDelay:     number;
    multiplier:       number;
    maxDelay:         number;
  };
}

// ── Plugin context (provided to plugin handler) ────────────────────

export interface PluginContext {
  readonly deviceId: string;
  readonly manifest: PluginManifest;

  sendCommand(commandId: string, params: Record<string, unknown>): Promise<CommandResult>;
  readReport(reportId?: number): Promise<Buffer>;
  writeReport(reportId: number, data: Buffer): Promise<void>;
  onEvent(callback: (event: DeviceEvent) => void): () => void;
  logger: {
    info(msg: string,  meta?: Record<string, unknown>): void;
    warn(msg: string,  meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
  flush(): Promise<void>;
}

// ── Plugin factory + lifecycle ─────────────────────────────────────

export interface IDevicePlugin {
  init(ctx: PluginContext): Promise<void>;
  onConnect(ctx: PluginContext, info: DeviceInfo): Promise<void>;
  onBeforeDisconnect(ctx: PluginContext): Promise<void>;
  onDisconnect(ctx: PluginContext, reason: string): Promise<void>;
  destroy(ctx: PluginContext): Promise<void>;
}

export type PluginFactory = (ctx: PluginContext) => IDevicePlugin;

// ── Plugin runtime info ────────────────────────────────────────────

export type PluginStatus =
  | 'idle' | 'loading' | 'running' | 'draining'
  | 'stopping' | 'crashed' | 'restarting' | 'error';

export interface PluginInfo {
  pluginId:         string;
  version:          string;
  status:           PluginStatus;
  manifestPath:     string;
  pid?:             number;
  assignedDevices:  string[];
  restartCount:     number;
  lastError?:       string;
  loadedAt?:        number;
}
