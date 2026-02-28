// packages/frontend/src/mw/stores/device-store.ts

import { create } from 'zustand';
import type { DeviceInfo, DeviceEvent } from '@devbridge/shared';

const MAX_EVENTS_PER_DEVICE = 200;

export interface DeviceStoreState {
  devices:     Map<string, DeviceInfo>;
  eventBuffer: Map<string, DeviceEvent[]>; // deviceId → last 200 events
  wsStatus:    'connecting' | 'open' | 'closed' | 'reconnecting';

  // Actions
  upsertDevice(info: DeviceInfo): void;
  removeDevice(deviceId: string): void;
  appendEvent(event: DeviceEvent): void;
  setWsStatus(status: DeviceStoreState['wsStatus']): void;

  // Selectors (pure, not stored in state)
  getDevice(deviceId: string): DeviceInfo | undefined;
  getConnectedDevices(): DeviceInfo[];
}

export const useDeviceStore = create<DeviceStoreState>((set, get) => ({
  devices:     new Map(),
  eventBuffer: new Map(),
  wsStatus:    'connecting',

  upsertDevice(info) {
    set(s => {
      s.devices.set(info.deviceId, info);
      return { devices: new Map(s.devices) };
    });
  },

  removeDevice(deviceId) {
    set(s => {
      s.devices.delete(deviceId);
      s.eventBuffer.delete(deviceId);
      return {
        devices:     new Map(s.devices),
        eventBuffer: new Map(s.eventBuffer),
      };
    });
  },

  appendEvent(event) {
    set(s => {
      const buf  = s.eventBuffer.get(event.deviceId) ?? [];
      const next = [...buf, event].slice(-MAX_EVENTS_PER_DEVICE);
      s.eventBuffer.set(event.deviceId, next);
      return { eventBuffer: new Map(s.eventBuffer) };
    });
  },

  setWsStatus(status) {
    set({ wsStatus: status });
  },

  getDevice(deviceId)   { return get().devices.get(deviceId); },
  getConnectedDevices() {
    return [...get().devices.values()].filter(d => d.status === 'connected');
  },
}));
