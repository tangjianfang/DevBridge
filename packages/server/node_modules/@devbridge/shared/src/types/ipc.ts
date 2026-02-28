// packages/shared/src/types/ipc.ts

export interface IPCMessage<T = unknown> {
  type:          string;    // UPPER_SNAKE_CASE
  source:        string;    // sender serviceId
  target:        string;    // receiver serviceId; '*' = broadcast
  correlationId: string;    // UUID v4
  payload:       T;
  timestamp:     bigint;    // process.hrtime.bigint() nanoseconds
}

export function createIPCMessage<T>(
  type:           string,
  source:         string,
  target:         string,
  payload:        T,
  correlationId?: string,
): IPCMessage<T> {
  return {
    type,
    source,
    target,
    correlationId: correlationId ?? crypto.randomUUID(),
    payload,
    timestamp: process.hrtime.bigint(),
  };
}

// ── Well-known IPC types (string constants) ───────────────────────

export const IPC = {
  // DeviceManager → *
  DEVICE_STATUS_CHANGED: 'DEVICE_STATUS_CHANGED',
  DATA_RECEIVED:         'DATA_RECEIVED',
  BINARY_FRAME:          'BINARY_FRAME',

  // CommandDispatcher → DeviceManager
  COMMAND_SEND:          'COMMAND_SEND',
  SUBSCRIBE_EVENTS:      'SUBSCRIBE_EVENTS',

  // CommandDispatcher → GatewayService
  COMMAND_RESULT:        'COMMAND_RESULT',
  BROADCAST_RESULT:      'BROADCAST_RESULT',

  // PluginLoader → *
  PLUGIN_LOADED:         'PLUGIN_LOADED',
  PLUGIN_STATUS:         'PLUGIN_STATUS',
  PLUGIN_HOT_UPDATED:    'PLUGIN_HOT_UPDATED',
  PLUGIN_CRASHED:        'PLUGIN_CRASHED',

  // Main → PluginLoader
  PLUGIN_LOAD:            'PLUGIN_LOAD',
  PLUGIN_UNLOAD:          'PLUGIN_UNLOAD',
  PLUGIN_HOT_UPDATE_SOURCE: 'PLUGIN_HOT_UPDATE_SOURCE',
  PLUGIN_RESTART:         'PLUGIN_RESTART',

  // Protocol
  PROTOCOL_HOT_UPDATED:  'PROTOCOL_HOT_UPDATED',

  // Observability
  LOG_ENTRY:             'LOG_ENTRY',
  METRICS_UPDATE:        'METRICS_UPDATE',
  NOTIFICATION:          'NOTIFICATION',

  // Health
  HEALTH_PING:           'HEALTH_PING',
  HEALTH_PONG:           'HEALTH_PONG',
} as const;

export type IPCType = (typeof IPC)[keyof typeof IPC];
