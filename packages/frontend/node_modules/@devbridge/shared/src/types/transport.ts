// packages/shared/src/types/transport.ts

export type TransportType =
  | 'usb-hid'
  | 'serial'
  | 'ble'
  | 'tcp'
  | 'usb-native'
  | 'ffi';

export interface TransportCapabilities {
  canSubscribe:      boolean;
  canRequest:        boolean;
  canBroadcast:      boolean;
  maxPacketSize:     number;
  isWireless:        boolean;
  requiresIsolation: boolean;
}

export interface EndpointInfo {
  id:          string;
  direction:   'in' | 'out' | 'bidir';
  type:        'interrupt' | 'bulk' | 'control' | 'stream' | 'notification';
  description?: string;
}

// ── Transport Config union ───────────────────────────────────────

export interface UsbHidConfig {
  transportType: 'usb-hid';
  vendorId:      number;
  productId:     number;
  serialNumber?: string;
  usagePage?:    number;
  usage?:        number;
}

export interface SerialConfig {
  transportType: 'serial';
  path:          string;        // e.g. 'COM3' or '/dev/ttyUSB0'
  baudRate:      number;
  dataBits?:     5 | 6 | 7 | 8;
  stopBits?:     1 | 1.5 | 2;
  parity?:       'none' | 'even' | 'odd' | 'mark' | 'space';
  flowControl?:  'none' | 'hardware' | 'software';
  readTimeout?:  number;        // ms
}

export interface BleConfig {
  transportType:  'ble';
  address:        string;       // MAC or UUID
  serviceUUIDs?:  string[];
  characteristicUUIDs?: string[];
  mtu?:           number;
}

export interface TcpConfig {
  transportType:  'tcp';
  host:           string;
  port:           number;
  keepAlive?:     boolean;
  heartbeatMs?:   number;
  reconnectMs?:   number;
}

export interface UsbNativeConfig {
  transportType:  'usb-native';
  vendorId:       number;
  productId:      number;
  interface?:     number;
  endpointIn?:    number;
  endpointOut?:   number;
}

export interface FfiConfig {
  transportType:  'ffi';
  dllPath:        string;
  functions:      FfiFunctionDef[];
  callbacks?:     FfiCallbackDef[];
  pollIntervalMs?: number;
}

export interface FfiFunctionDef {
  name:       string;
  returnType: string;
  argTypes:   string[];
}

export interface FfiCallbackDef {
  name:       string;
  returnType: string;
  argTypes:   string[];
}

export type TransportConfig =
  | UsbHidConfig
  | SerialConfig
  | BleConfig
  | TcpConfig
  | UsbNativeConfig
  | FfiConfig;

// ── Runtime interfaces (depends on EventEmitter — server-side only) ──

import type { DeviceInfo } from './device.js';

export interface ITransport extends NodeJS.EventEmitter {
  readonly transportType: TransportType;
  readonly deviceId:      string;

  connect(config: TransportConfig): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getInfo(): DeviceInfo;
  getCapabilities(): TransportCapabilities;
  getEndpoints(): EndpointInfo[];

  send(buffer: Buffer): Promise<void>;
  request(buffer: Buffer, timeoutMs?: number): Promise<Buffer>;

  subscribe(endpointId: string): Promise<void>;
  unsubscribe(endpointId: string): Promise<void>;
  subscribeAll(): Promise<void>;
}

export interface IDeviceScanner extends NodeJS.EventEmitter {
  readonly transportType: TransportType;
  scan(): Promise<import('./device.js').RawDeviceInfo[]>;
  startWatching(): void;
  stopWatching():  void;
}
