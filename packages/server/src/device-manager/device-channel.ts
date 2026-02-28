// packages/server/src/device-manager/device-channel.ts
// DeviceChannel wraps a transport + protocol + plugin for a single device.

import type {
  DeviceInfo,
  DeviceStatus,
  RawDeviceInfo,
  IProtocol,
  IDevicePlugin,
  IPCMessage,
  TransportConfig,
} from '@devbridge/shared';

import { TransportFactory }    from '../transport/index.js';
import type { ITransport }     from '@devbridge/shared';
import { buildDeviceId }       from './device-id.js';
import {
  ReconnectController,
  type Reconnectable,
  type ReconnectOptions,
} from './reconnect-controller.js';

// Module-level IPC port reference — replaced in tests via setIPCSender().
let _ipcSender: (msg: IPCMessage) => void = () => {};
export function setIPCSender(fn: (msg: IPCMessage) => void): void { _ipcSender = fn; }

// Build a minimal TransportConfig from RawDeviceInfo.
function inferTransportConfig(raw: RawDeviceInfo): TransportConfig {
  switch (raw.transportType) {
    case 'usb-hid':
      return { transportType: 'usb-hid', vendorId: raw.vendorId ?? 0, productId: raw.productId ?? 0, serialNumber: raw.serialNumber };
    case 'serial':
      return { transportType: 'serial', path: raw.address, baudRate: 115200 };
    case 'ble':
      return { transportType: 'ble', address: raw.address };
    case 'tcp': {
      const [host = 'localhost', portStr = '9090'] = raw.address.split(':');
      return { transportType: 'tcp', host, port: parseInt(portStr, 10) };
    }
    case 'usb-native':
      return { transportType: 'usb-native', vendorId: raw.vendorId ?? 0, productId: raw.productId ?? 0 };
    case 'ffi':
      return { transportType: 'ffi', dllPath: raw.address, functions: [], callbacks: [] };
    default:
      return { transportType: raw.transportType, vendorId: 0, productId: 0 } as unknown as TransportConfig;
  }
}

export class DeviceChannel implements Reconnectable {
  info:       DeviceInfo;
  transport:  ITransport;
  protocol:   IProtocol | null;
  plugin:     IDevicePlugin | null = null;

  private readonly correlationIdQueue: string[] = [];
  private reconnector?: ReconnectController;
  private readonly transportConfig: TransportConfig;
  private _closing = false;

  private constructor(
    info:      DeviceInfo,
    transport: ITransport,
    proto:     IProtocol | null,
    cfg:       TransportConfig,
  ) {
    this.info            = info;
    this.transport       = transport;
    this.protocol        = proto;
    this.transportConfig = cfg;
  }

  // ──────────────────────────────────────────────────────────
  // Factory
  // ──────────────────────────────────────────────────────────

  static create(
    raw:             RawDeviceInfo,
    proto:           IProtocol | null,
    reconnectOpts:   Partial<ReconnectOptions> = {},
    /** Optional transport override — used in unit tests. */
    transportOverride?: ITransport,
  ): DeviceChannel {
    const info: DeviceInfo = {
      deviceId:       buildDeviceId(raw),
      transportType:  raw.transportType,
      status:         'scanning',
      name:           raw.name ?? 'Unknown Device',
      vendorId:       raw.vendorId,
      productId:      raw.productId,
      serialNumber:   raw.serialNumber,
      address:        raw.address,
      protocolName:   proto?.name,
      lastSeenAt:     Date.now(),
      reconnectCount: 0,
    };

    const cfg       = inferTransportConfig(raw);
    const transport = transportOverride ?? TransportFactory.create(raw.transportType);
    const ch        = new DeviceChannel(info, transport, proto, cfg);

    // Bind transport events
    transport.on('data',  (buf: Buffer, ep: string) => ch.onData(buf, ep));
    transport.on('event', (buf: Buffer, ep: string) => ch.onEvent(buf, ep));
    transport.on('open',  ()                         => ch.onOpen());
    transport.on('close', (reason?: string)          => ch.onClose(reason));
    transport.on('error', (err: Error)               => ch.onError(err));

    if (proto) ch.updateStatus('identified');

    ch.reconnector = new ReconnectController(ch, reconnectOpts);

    setImmediate(() => { void ch.connect(); });

    return ch;
  }

  // ──────────────────────────────────────────────────────────
  // Reconnectable interface
  // ──────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.info.status === 'connected') return;
    this.updateStatus('connecting');
    try {
      await this.transport.connect(this.transportConfig);
    } catch (err) {
      this.updateStatus('error');
      this.sendIPC('LOG_ENTRY', { level: 'error', message: String(err) });
    }
  }

  markRemoved(): void {
    this.updateStatus('removed');
  }

  markReconnecting(attempt: number, nextRetryMs: number, reason?: string): void {
    this.sendIPC('DEVICE_STATUS_CHANGED', {
      ...this.info,
      status:         'reconnecting',
      reconnectCount: attempt,
      metadata:       { ...this.info.metadata, attempt, nextRetryMs, reason },
    });
    this.info = {
      ...this.info,
      status:         'reconnecting',
      reconnectCount: attempt,
    };
  }

  // ──────────────────────────────────────────────────────────
  // Status management
  // ──────────────────────────────────────────────────────────

  updateStatus(s: DeviceStatus, extra?: Partial<DeviceInfo>): void {
    this.info = { ...this.info, ...extra, status: s, lastSeenAt: Date.now() };
    this.sendIPC('DEVICE_STATUS_CHANGED', this.info);
  }

  // ──────────────────────────────────────────────────────────
  // Correlation queue
  // ──────────────────────────────────────────────────────────

  /** Must be called BEFORE transport.send() to maintain FIFO order. */
  enqueueCorrelation(correlationId: string): void {
    this.correlationIdQueue.push(correlationId);
  }

  // ──────────────────────────────────────────────────────────
  // Transport event handlers
  // ──────────────────────────────────────────────────────────

  private onData(buf: Buffer, _ep: string): void {
    if (!this.protocol) return;
    let msg;
    try {
      msg = this.protocol.decode(buf);
    } catch {
      return;
    }
    const correlationId = this.correlationIdQueue.shift();
    if (!correlationId) {
      this.sendIPC('LOG_ENTRY', {
        level:    'warn',
        message:  'DATA_RECEIVED without pending correlationId — unsolicited frame dropped',
        deviceId: this.info.deviceId,
      });
      return;
    }
    this.sendIPC('DATA_RECEIVED', { deviceId: this.info.deviceId, correlationId, message: msg });
  }

  private onEvent(buf: Buffer, ep: string): void {
    let decoded;
    try {
      decoded = this.protocol?.decode(buf);
    } catch {
      decoded = undefined;
    }
    this.sendIPC('BINARY_FRAME', {
      deviceId: this.info.deviceId,
      endpoint: ep,
      buffer:   buf,
      decoded,
    });
  }

  private onOpen(): void {
    this.reconnector?.resetAttempts();
    this.updateStatus('connected', { connectedAt: Date.now() });
  }

  private onClose(reason?: string): void {
    if (this._closing) return;   // ignore close events during explicit shutdown
    this.updateStatus('disconnected');
    this.reconnector?.scheduleRetry(reason);
  }

  private onError(err: Error): void {
    this.sendIPC('LOG_ENTRY', { level: 'error', message: err.message });
  }

  // ──────────────────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────────────────

  async close(_reason = 'manual'): Promise<void> {
    if (this._closing) return;
    this._closing = true;
    this.reconnector?.cancel();
    try {
      await this.transport.disconnect();
    } catch { /* ignore */ }
    this.updateStatus('removed');
  }

  // ──────────────────────────────────────────────────────────
  // IPC helpers
  // ──────────────────────────────────────────────────────────

  private sendIPC<T>(type: string, payload: T): void {
    _ipcSender({ type, payload } as IPCMessage);
  }
}
