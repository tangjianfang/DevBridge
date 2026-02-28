// packages/server/src/transport/serial/serial-transport.ts

import type {
  TransportConfig,
  SerialConfig,
  TransportCapabilities,
  EndpointInfo,
} from '@devbridge/shared';
import type { DeviceInfo } from '@devbridge/shared';
import { BaseTransport } from '../base-transport.js';

type SerialPortClass = import('serialport').SerialPort;

let SerialPort: (typeof import('serialport'))['SerialPort'] | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  SerialPort = (require('serialport') as typeof import('serialport')).SerialPort;
} catch {
  // optional dep
}

export class SerialTransport extends BaseTransport {
  readonly transportType = 'serial' as const;
  readonly deviceId:     string;

  private port?: SerialPortClass;
  private config?: SerialConfig;
  private readBuf = Buffer.alloc(0);

  constructor(deviceId: string = '') {
    super();
    this.deviceId = deviceId || 'serial:pending';
  }

  static readonly capabilities: TransportCapabilities = {
    canSubscribe:      true,
    canRequest:        true,
    canBroadcast:      false,
    maxPacketSize:     65535,
    isWireless:        false,
    requiresIsolation: false,
  };

  getCapabilities(): TransportCapabilities { return SerialTransport.capabilities; }

  getEndpoints(): EndpointInfo[] {
    return [{ id: 'serial-rxtx', direction: 'bidir', type: 'stream' }];
  }

  async connect(config: TransportConfig): Promise<void> {
    if (!SerialPort) {
      throw Object.assign(
        new Error('TRANSPORT_CONNECT_FAILED: serialport is not installed'),
        { errorCode: 'TRANSPORT_CONNECT_FAILED' },
      );
    }
    const cfg = config as SerialConfig;
    this.config = cfg;

    return new Promise<void>((resolve, reject) => {
      const sp = new SerialPort!({
        path:     cfg.path,
        baudRate: cfg.baudRate,
        dataBits: cfg.dataBits ?? 8,
        stopBits: cfg.stopBits ?? 1,
        parity:   cfg.parity   ?? 'none',
        autoOpen: false,
      });

      sp.open((err) => {
        if (err) {
          return reject(
            Object.assign(
              new Error(`TRANSPORT_CONNECT_FAILED: ${err.message}`),
              { errorCode: 'TRANSPORT_CONNECT_FAILED', cause: err },
            ),
          );
        }
        this.port = sp;
        sp.on('data', (chunk: Buffer) => {
          this.readBuf = Buffer.concat([this.readBuf, chunk]);
          this.emitData(this.readBuf, 'serial-rxtx');
          this.readBuf = Buffer.alloc(0);
        });
        sp.on('close', () => this.setConnected(false, 'serial-close'));
        sp.on('error', (e: Error) => {
          this.emit('error', e);
          this.setConnected(false, e.message);
        });
        this.setConnected(true);
        resolve();
      });
    });
  }

  async disconnect(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.port?.isOpen) { this.setConnected(false); return resolve(); }
      this.port.close(() => { this.setConnected(false); resolve(); });
    });
  }

  async send(buffer: Buffer): Promise<void> {
    if (!this.port?.isOpen) {
      throw Object.assign(
        new Error('TRANSPORT_SEND_FAILED: port not open'),
        { errorCode: 'TRANSPORT_SEND_FAILED' },
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.port!.write(buffer, (err) => {
        if (err) reject(
          Object.assign(
            new Error(`TRANSPORT_SEND_FAILED: ${err.message}`),
            { errorCode: 'TRANSPORT_SEND_FAILED', cause: err },
          ),
        );
        else this.port!.drain(() => resolve());
      });
    });
  }

  getInfo(): DeviceInfo {
    return {
      deviceId:       this.deviceId,
      transportType:  this.transportType,
      status:         this._connected ? 'connected' : 'disconnected',
      name:           `Serial ${this.config?.path ?? ''}`,
      address:        this.config?.path ?? 'serial:unknown',
      lastSeenAt:     Date.now(),
      reconnectCount: 0,
    };
  }
}
