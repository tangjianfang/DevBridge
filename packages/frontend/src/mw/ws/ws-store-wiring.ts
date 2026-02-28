// packages/frontend/src/mw/ws/ws-store-wiring.ts
//
// Connects wsEventBus events to Zustand store actions.
// Call initStoreWiring() once during app startup.

import { wsEventBus, batchEmit } from './ws-event-bus.js';
import { useDeviceStore } from '../stores/device-store.js';
import { useNotificationStore } from '../stores/notification-store.js';
import { useMetricsStore } from '../stores/metrics-store.js';
import { usePluginStore } from '../stores/plugin-store.js';
import type { DeviceInfo, DeviceEvent, PluginInfo } from '@devbridge/shared';
import type { MetricsSnapshot } from '../stores/metrics-store.js';
import type { Notification } from '../stores/notification-store.js';

let _initialized = false;

export function initStoreWiring(): void {
  if (_initialized) return;
  _initialized = true;

  const ds  = useDeviceStore.getState;
  const ns  = useNotificationStore.getState;
  const ms  = useMetricsStore.getState;
  const ps  = usePluginStore.getState;

  wsEventBus.on('device:connected',    (payload: unknown) => ds().upsertDevice(payload as DeviceInfo));
  wsEventBus.on('device:disconnected', (payload: unknown) => {
    const p = payload as { deviceId: string };
    const existing = ds().getDevice(p.deviceId);
    if (existing) ds().upsertDevice({ ...existing, status: 'disconnected' });
  });
  wsEventBus.on('device:reconnecting', (payload: unknown) => {
    const p = payload as { deviceId: string };
    const existing = ds().getDevice(p.deviceId);
    if (existing) ds().upsertDevice({ ...existing, status: 'reconnecting' });
  });
  wsEventBus.on('device:removed',  (payload: unknown) => {
    ds().removeDevice((payload as { deviceId: string }).deviceId);
  });
  wsEventBus.on('device:status',   (payload: unknown) => {
    const p = payload as Partial<DeviceInfo> & { deviceId: string };
    const existing = ds().getDevice(p.deviceId);
    if (existing) ds().upsertDevice({ ...existing, ...p });
  });
  wsEventBus.on('device:event',    (payload: unknown) => ds().appendEvent(payload as DeviceEvent));

  wsEventBus.on('notification',    (payload: unknown) => ns().push(payload as Omit<Notification, 'id' | 'read'>));
  wsEventBus.on('metrics:update',  (payload: unknown) => ms().push(payload as MetricsSnapshot));
  wsEventBus.on('plugin:status',   (payload: unknown) => ps().upsertPlugin(payload as PluginInfo));

  wsEventBus.on('ws:open',  () => ds().setWsStatus('open'));
  wsEventBus.on('ws:close', () => ds().setWsStatus('closed'));
  wsEventBus.on('ws:reconnect-exhausted', () => {
    ns().push({
      severity:  'error',
      message:   'WebSocket reconnect exhausted — connection lost',
      timestamp: Date.now(),
    });
  });
}

/** Reset wiring (for tests). */
export function resetStoreWiring(): void {
  _initialized = false;
  wsEventBus.removeAllListeners();
}
