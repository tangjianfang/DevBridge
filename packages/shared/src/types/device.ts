// packages/shared/src/types/device.ts

import type { TransportType } from './transport.js';

export type DeviceStatus =
  | 'scanning'
  | 'identified'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'detached'
  | 'removed'
  | 'error';

export interface DeviceInfo {
  deviceId:       string;          // transportType:hash16
  transportType:  TransportType;
  status:         DeviceStatus;
  name:           string;
  address:        string;          // COM3 | usb:1-2 | BLE:MAC | ip:port
  vendorId?:      number;
  productId?:     number;
  serialNumber?:  string;
  protocolName?:  string;
  pluginId?:      string;
  lastSeenAt:     number;          // Date.now()
  connectedAt?:   number;
  reconnectCount: number;
  metadata?:      Record<string, unknown>;
}

export interface RawDeviceInfo {
  transportType:  TransportType;
  address:        string;
  name?:          string;
  vendorId?:      number;
  productId?:     number;
  serialNumber?:  string;
  raw?:           unknown;         // transport-specific raw descriptor
}

export interface DeviceEvent {
  deviceId:             string;
  channel:              'command' | 'event';
  messageType:          string;
  data:                 Record<string, unknown>;
  timestamp:            bigint;
  characteristicUUID?:  string;   // BLE
  reportId?:            number;   // HID
}
