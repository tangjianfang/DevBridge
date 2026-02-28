// packages/server/src/transport/usb-native/usb-native-transport.ts

import type {
  TransportConfig,
  UsbNativeConfig,
  TransportCapabilities,
  EndpointInfo,
} from '@devbridge/shared';
import type { DeviceInfo } from '@devbridge/shared';
import { BaseTransport } from '../base-transport.js';

type UsbLib = typeof import('usb');
type UsbDevice = import('usb').usb.Device;
type UsbInterface = import('usb').usb.Interface;
type InEndpoint = import('usb').usb.InEndpoint;
type OutEndpoint = import('usb').usb.OutEndpoint;

let usb: UsbLib | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  usb = require('usb') as UsbLib;
} catch {
  // optional dep
}

export class UsbNativeTransport extends BaseTransport {
  readonly transportType = 'usb-native' as const;
  readonly deviceId:     string;

  private device?: UsbDevice;
  private ifaces:  UsbInterface[] = [];
  private inEps:   InEndpoint[]   = [];
  private outEp?:  OutEndpoint;
  private config?: UsbNativeConfig;

  constructor(deviceId: string = '') {
    super();
    this.deviceId = deviceId || 'usb-native:pending';
  }

  static readonly capabilities: TransportCapabilities = {
    canSubscribe:      true,
    canRequest:        true,
    canBroadcast:      false,
    maxPacketSize:     65536,
    isWireless:        false,
    requiresIsolation: false,
  };

  getCapabilities(): TransportCapabilities { return UsbNativeTransport.capabilities; }

  getEndpoints(): EndpointInfo[] {
    return [
      { id: 'usb-native-in',  direction: 'in',  type: 'bulk' },
      { id: 'usb-native-out', direction: 'out', type: 'bulk' },
    ];
  }

  async connect(config: TransportConfig): Promise<void> {
    if (!usb) {
      throw Object.assign(
        new Error('TRANSPORT_CONNECT_FAILED: usb (libusb) is not installed'),
        { errorCode: 'TRANSPORT_CONNECT_FAILED' },
      );
    }
    const cfg = config as UsbNativeConfig;
    this.config = cfg;

    const found = usb.findByIds(cfg.vendorId, cfg.productId);
    if (!found) {
      throw Object.assign(
        new Error(`TRANSPORT_CONNECT_FAILED: USB device ${cfg.vendorId}:${cfg.productId} not found`),
        { errorCode: 'TRANSPORT_CONNECT_FAILED' },
      );
    }

    this.device = found;
    this.device.open();

    for (const ifaceCfg of cfg.interfaces ?? []) {
      const iface = this.device.interface(ifaceCfg.number);
      if (iface.isKernelDriverActive?.()) iface.detachKernelDriver();
      iface.claim();
      this.ifaces.push(iface);

      for (const epCfg of ifaceCfg.endpoints) {
        const ep = iface.endpoint(epCfg.address);
        if (ep instanceof (usb as typeof usb).usb.InEndpoint) {
          const inEp = ep as InEndpoint;
          inEp.on('data', (buf: Buffer) => this.emitData(buf, `usb-native-in-${epCfg.address}`));
          inEp.on('error', (e: Error) => this.emit('error', e));
          inEp.startPoll();
          this.inEps.push(inEp);
        } else {
          this.outEp = ep as OutEndpoint;
        }
      }
    }

    this.device.on('disconnect', () => this.setConnected(false, 'usb-native-disconnect'));
    this.setConnected(true);
  }

  async disconnect(): Promise<void> {
    for (const ep of this.inEps) ep.stopPoll();
    for (const iface of this.ifaces) { try { iface.release(); } catch { /* ignore */ } }
    try { this.device?.close(); } catch { /* ignore */ }
    this.inEps = []; this.ifaces = []; this.outEp = undefined; this.device = undefined;
    this.setConnected(false);
  }

  async send(buffer: Buffer): Promise<void> {
    if (!this.outEp) {
      throw Object.assign(
        new Error('TRANSPORT_SEND_FAILED: no OUT endpoint'),
        { errorCode: 'TRANSPORT_SEND_FAILED' },
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.outEp!.transfer(buffer, (err) => {
        if (err) reject(
          Object.assign(
            new Error(`TRANSPORT_SEND_FAILED: ${err.message}`),
            { errorCode: 'TRANSPORT_SEND_FAILED', cause: err },
          ),
        );
        else resolve();
      });
    });
  }

  getInfo(): DeviceInfo {
    return {
      deviceId:       this.deviceId,
      transportType:  this.transportType,
      status:         this._connected ? 'connected' : 'disconnected',
      name:           `USB ${this.config?.vendorId?.toString(16) ?? ''}:${this.config?.productId?.toString(16) ?? ''}`,
      address:        `usb-native:${this.config?.vendorId ?? 0}:${this.config?.productId ?? 0}`,
      vendorId:       this.config?.vendorId,
      productId:      this.config?.productId,
      lastSeenAt:     Date.now(),
      reconnectCount: 0,
    };
  }
}
