// packages/server/src/transport/usb-hid/usb-hid-transport.ts

import type {
  TransportConfig,
  UsbHidConfig,
  TransportCapabilities,
  EndpointInfo,
} from '@devbridge/shared';
import type { DeviceInfo } from '@devbridge/shared';
import { BaseTransport } from '../base-transport.js';

let HID: typeof import('node-hid') | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  HID = require('node-hid') as typeof import('node-hid');
} catch {
  // optional dep — will throw on connect() if not installed
}

export class UsbHidTransport extends BaseTransport {
  readonly transportType = 'usb-hid' as const;
  readonly deviceId:     string;

  private device?: import('node-hid').HID;
  private config?: UsbHidConfig;

  constructor(deviceId: string = '') {
    super();
    this.deviceId = deviceId || 'usb-hid:pending';
  }

  static readonly capabilities: TransportCapabilities = {
    canSubscribe:      true,
    canRequest:        true,
    canBroadcast:      false,
    maxPacketSize:     64,
    isWireless:        false,
    requiresIsolation: false,
  };

  getCapabilities(): TransportCapabilities {
    return UsbHidTransport.capabilities;
  }

  getEndpoints(): EndpointInfo[] {
    return [
      { id: 'hid-in',  direction: 'in',    type: 'interrupt' },
      { id: 'hid-out', direction: 'out',   type: 'interrupt' },
    ];
  }

  async connect(config: TransportConfig): Promise<void> {
    if (!HID) {
      throw Object.assign(
        new Error('TRANSPORT_CONNECT_FAILED: node-hid is not installed'),
        { errorCode: 'TRANSPORT_CONNECT_FAILED' },
      );
    }
    const cfg = config as UsbHidConfig;
    this.config = cfg;

    try {
      this.device = new HID.HID(cfg.vendorId, cfg.productId);
      this.device.on('data', (buf: Buffer) => this.emitData(buf, 'hid-in'));
      this.device.on('error', (err: Error) => {
        this.emit('error', err);
        this.setConnected(false, err.message);
      });
      this.setConnected(true);
    } catch (err) {
      throw Object.assign(
        new Error(`TRANSPORT_CONNECT_FAILED: ${(err as Error).message}`),
        { errorCode: 'TRANSPORT_CONNECT_FAILED', cause: err },
      );
    }
  }

  async disconnect(): Promise<void> {
    this.device?.close();
    this.device = undefined;
    this.setConnected(false);
  }

  async send(buffer: Buffer): Promise<void> {
    if (!this.device) {
      throw Object.assign(
        new Error('TRANSPORT_SEND_FAILED: not connected'),
        { errorCode: 'TRANSPORT_SEND_FAILED' },
      );
    }
    try {
      // HID write prepends a 0x00 report ID byte if not present
      const payload = buffer[0] === 0x00 ? [...buffer] : [0x00, ...buffer];
      this.device.write(payload);
    } catch (err) {
      throw Object.assign(
        new Error(`TRANSPORT_SEND_FAILED: ${(err as Error).message}`),
        { errorCode: 'TRANSPORT_SEND_FAILED', cause: err },
      );
    }
  }

  getInfo(): DeviceInfo {
    return {
      deviceId:       this.deviceId,
      transportType:  this.transportType,
      status:         this._connected ? 'connected' : 'disconnected',
      name:           `HID ${this.config?.vendorId?.toString(16) ?? ''}:${this.config?.productId?.toString(16) ?? ''}`,
      address:        `usb-hid:${this.config?.vendorId ?? 0}:${this.config?.productId ?? 0}`,
      vendorId:       this.config?.vendorId,
      productId:      this.config?.productId,
      lastSeenAt:     Date.now(),
      reconnectCount: 0,
    };
  }
}
