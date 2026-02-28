// packages/frontend/src/mw/index.ts

export { wsClient, WsClient } from './ws/ws-client.js';
export { wsEventBus, batchEmit, flushBatchEmit } from './ws/ws-event-bus.js';
export { useDeviceStore } from './stores/device-store.js';
export { useNotificationStore } from './stores/notification-store.js';
export { useMetricsStore } from './stores/metrics-store.js';
export { usePluginStore } from './stores/plugin-store.js';
export { commandService } from './commands/command-service.js';
export { parseBinaryFrame } from './protocol/binary-frame.js';
export type { ParsedBinaryFrame } from './protocol/binary-frame.js';
export type { DeviceStoreState } from './stores/device-store.js';
export type { NotificationStoreState, Notification } from './stores/notification-store.js';
export type { MetricsStoreState, MetricsSnapshot } from './stores/metrics-store.js';
export type { PluginStoreState } from './stores/plugin-store.js';
export type { CommandService } from './commands/command-service.js';
