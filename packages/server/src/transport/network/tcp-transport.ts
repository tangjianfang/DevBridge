// packages/server/src/transport/network/tcp-transport.ts

import net from 'net';
import type {
  TransportConfig,
  TcpConfig,
  TransportCapabilities,
  EndpointInfo,
} from '@devbridge/shared';
import type { DeviceInfo } from '@devbridge/shared';
import { BaseTransport } from '../base-transport.js';

export class TcpTransport extends BaseTransport {
  readonly transportType = 'tcp' as const;
  readonly deviceId:     string;

  private socket?: net.Socket;
  private config?: TcpConfig;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(deviceId: string = '') {
    super();
    this.deviceId = deviceId || 'tcp:pending';
  }

  static readonly capabilities: TransportCapabilities = {
    canSubscribe:      true,
    canRequest:        true,
    canBroadcast:      true,
    maxPacketSize:     65535,
    isWireless:        false,
    requiresIsolation: false,
  };

  getCapabilities(): TransportCapabilities { return TcpTransport.capabilities; }

  getEndpoints(): EndpointInfo[] {
    return [{ id: 'tcp-stream', direction: 'bidir', type: 'stream' }];
  }

  async connect(config: TransportConfig): Promise<void> {
    const cfg = config as TcpConfig;
    this.config = cfg;

    return new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: cfg.host, port: cfg.port });

      if (cfg.keepAlive) {
        sock.setKeepAlive(true, cfg.heartbeatMs ?? 5000);
      }

      sock.once('connect', () => {
        this.socket = sock;
        this.setConnected(true);
        this.startHeartbeat();
        resolve();
      });

      sock.on('data', (chunk: Buffer) => this.emitData(chunk, 'tcp-stream'));

      sock.on('close', () => {
        this.stopHeartbeat();
        this.setConnected(false, 'tcp-close');
      });

      sock.on('error', (err) => {
        this.stopHeartbeat();
        this.emit('error', err);
        if (!this._connected) reject(
          Object.assign(
            new Error(`TRANSPORT_CONNECT_FAILED: ${err.message}`),
            { errorCode: 'TRANSPORT_CONNECT_FAILED', cause: err },
          ),
        );
        else this.setConnected(false, err.message);
      });
    });
  }

  async disconnect(): Promise<void> {
    this.stopHeartbeat();
    this.socket?.destroy();
    this.socket = undefined;
    this.setConnected(false);
  }

  async send(buffer: Buffer): Promise<void> {
    if (!this.socket || !this._connected) {
      throw Object.assign(
        new Error('TRANSPORT_SEND_FAILED: not connected'),
        { errorCode: 'TRANSPORT_SEND_FAILED' },
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.socket!.write(buffer, (err) => {
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

  private startHeartbeat(): void {
    const cfg = this.config;
    if (!cfg?.heartbeatMs) return;
    this.heartbeatTimer = setInterval(async () => {
      if (!this._connected) { this.stopHeartbeat(); return; }
      try {
        await this.send(Buffer.from([0xff])); // simple keepalive byte
      } catch {
        this.setConnected(false, 'HEARTBEAT_FAILED');
      }
    }, cfg.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  getInfo(): DeviceInfo {
    return {
      deviceId:       this.deviceId,
      transportType:  this.transportType,
      status:         this._connected ? 'connected' : 'disconnected',
      name:           `TCP ${this.config?.host ?? ''}:${this.config?.port ?? ''}`,
      address:        `${this.config?.host ?? 'unknown'}:${this.config?.port ?? 0}`,
      lastSeenAt:     Date.now(),
      reconnectCount: 0,
    };
  }
}
