// packages/server/src/transport/ble/ble-transport.ts

import type {
  TransportConfig,
  BleConfig,
  TransportCapabilities,
  EndpointInfo,
} from '@devbridge/shared';
import type { DeviceInfo } from '@devbridge/shared';
import { BaseTransport } from '../base-transport.js';

type Noble = typeof import('@abandonware/noble');

let noble: Noble | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  noble = require('@abandonware/noble') as Noble;
} catch {
  // optional dep
}

export class BleTransport extends BaseTransport {
  readonly transportType = 'ble' as const;
  readonly deviceId:     string;

  private config?: BleConfig;
  private peripheral?: import('@abandonware/noble').Peripheral;
  private characteristics = new Map<string, import('@abandonware/noble').Characteristic>();
  private writeCharacteristic?: import('@abandonware/noble').Characteristic;

  constructor(deviceId: string = '') {
    super();
    this.deviceId = deviceId || 'ble:pending';
  }

  static readonly capabilities: TransportCapabilities = {
    canSubscribe:      true,
    canRequest:        true,
    canBroadcast:      false,
    maxPacketSize:     512,
    isWireless:        true,
    requiresIsolation: false,
  };

  getCapabilities(): TransportCapabilities { return BleTransport.capabilities; }

  getEndpoints(): EndpointInfo[] {
    return [
      { id: 'ble-notify',  direction: 'in',    type: 'notification' },
      { id: 'ble-write',   direction: 'out',   type: 'bulk' },
    ];
  }

  async connect(config: TransportConfig): Promise<void> {
    if (!noble) {
      throw Object.assign(
        new Error('TRANSPORT_CONNECT_FAILED: @abandonware/noble is not installed'),
        { errorCode: 'TRANSPORT_CONNECT_FAILED' },
      );
    }
    const cfg = config as BleConfig;
    this.config = cfg;

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(Object.assign(
          new Error('TRANSPORT_CONNECT_FAILED: BLE connection timeout'),
          { errorCode: 'TRANSPORT_CONNECT_FAILED' },
        ));
      }, 10000);

      noble!.once('stateChange', (state: string) => {
        if (state !== 'poweredOn') {
          clearTimeout(timeout);
          return reject(Object.assign(
            new Error(`TRANSPORT_CONNECT_FAILED: BLE adapter state = ${state}`),
            { errorCode: 'TRANSPORT_CONNECT_FAILED' },
          ));
        }
        noble!.startScanning(cfg.serviceUUIDs ?? [], false);
      });

      noble!.on('discover', async (p: import('@abandonware/noble').Peripheral) => {
        if (p.address !== cfg.address) return;
        noble!.stopScanning();
        clearTimeout(timeout);

        try {
          await p.connectAsync();
          this.peripheral = p;
          const serviceUUIDs = cfg.serviceUUIDs ?? [];
          const charUUIDs    = cfg.characteristicUUIDs ?? [];
          const { characteristics } = await p.discoverSomeServicesAndCharacteristicsAsync(serviceUUIDs, charUUIDs);

          for (const ch of characteristics) {
            this.characteristics.set(ch.uuid, ch);
            if (ch.properties.includes('write') || ch.properties.includes('writeWithoutResponse')) {
              this.writeCharacteristic = ch;
            }
            if (ch.properties.includes('notify') || ch.properties.includes('indicate')) {
              await ch.subscribeAsync();
              ch.on('data', (buf: Buffer) => this.emitEvent(buf, `ble-notify:${ch.uuid}`));
            }
          }

          p.on('disconnect', () => this.setConnected(false, 'ble-disconnect'));
          this.setConnected(true);
          resolve();
        } catch (err) {
          reject(Object.assign(
            new Error(`TRANSPORT_CONNECT_FAILED: ${(err as Error).message}`),
            { errorCode: 'TRANSPORT_CONNECT_FAILED', cause: err },
          ));
        }
      });

      if (noble!.state === 'poweredOn') {
        noble!.startScanning(cfg.serviceUUIDs ?? [], false);
      }
    });
  }

  async disconnect(): Promise<void> {
    await this.peripheral?.disconnectAsync?.();
    this.characteristics.clear();
    this.writeCharacteristic = undefined;
    this.peripheral = undefined;
    this.setConnected(false);
  }

  async send(buffer: Buffer): Promise<void> {
    if (!this.writeCharacteristic) {
      throw Object.assign(
        new Error('TRANSPORT_SEND_FAILED: no writable BLE characteristic'),
        { errorCode: 'TRANSPORT_SEND_FAILED' },
      );
    }
    await this.writeCharacteristic.writeAsync(buffer, false);
  }

  getInfo(): DeviceInfo {
    return {
      deviceId:       this.deviceId,
      transportType:  this.transportType,
      status:         this._connected ? 'connected' : 'disconnected',
      name:           this.peripheral?.advertisement?.localName ?? `BLE ${this.config?.address ?? ''}`,
      address:        this.config?.address ?? 'ble:unknown',
      lastSeenAt:     Date.now(),
      reconnectCount: 0,
    };
  }
}
