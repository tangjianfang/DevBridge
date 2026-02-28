// packages/server/src/transport/base-transport.ts

import { EventEmitter } from 'events';
import type {
  TransportType,
  TransportConfig,
  TransportCapabilities,
  EndpointInfo,
  ITransport,
} from '@devbridge/shared';
import type { DeviceInfo } from '@devbridge/shared';

const EVENT_BUFFER_MAX = 256;

export abstract class BaseTransport extends EventEmitter implements ITransport {
  protected _connected    = false;
  protected subscriptions = new Set<string>();

  private _pendingEvents: Array<{ buffer: Buffer; endpointId: string }> = [];

  abstract readonly transportType: TransportType;
  abstract readonly deviceId:      string;

  abstract connect(config: TransportConfig): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract send(buffer: Buffer): Promise<void>;
  abstract getInfo(): DeviceInfo;
  abstract getCapabilities(): TransportCapabilities;
  abstract getEndpoints(): EndpointInfo[];

  isConnected(): boolean { return this._connected; }

  async request(buffer: Buffer, timeoutMs = 5000): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('data', handler);
        reject(
          Object.assign(
            new Error(`TRANSPORT_REQUEST_TIMEOUT: ${this.deviceId}`),
            { errorCode: 'TRANSPORT_REQUEST_TIMEOUT', deviceId: this.deviceId },
          ),
        );
      }, timeoutMs);

      const handler = (data: Buffer) => {
        clearTimeout(timer);
        resolve(data);
      };

      this.once('data', handler);
      this.send(buffer).catch((err: Error) => {
        clearTimeout(timer);
        this.off('data', handler);
        reject(err);
      });
    });
  }

  async subscribe(endpointId: string): Promise<void> {
    this.subscriptions.add(endpointId);
  }

  async unsubscribe(endpointId: string): Promise<void> {
    this.subscriptions.delete(endpointId);
  }

  async subscribeAll(): Promise<void> {
    for (const ep of this.getEndpoints()) {
      if (ep.direction !== 'out') await this.subscribe(ep.id);
    }
  }

  protected emitData(buffer: Buffer, endpointId: string): void {
    this.emit('data', buffer, endpointId);
  }

  protected emitEvent(buffer: Buffer, endpointId: string): void {
    // Back-pressure protection: drop oldest when buffer full
    if (this._pendingEvents.length >= EVENT_BUFFER_MAX) {
      this._pendingEvents.shift();
    }
    this._pendingEvents.push({ buffer, endpointId });
    this.emit('event', buffer, endpointId);
  }

  protected setConnected(val: boolean, reason?: string): void {
    this._connected = val;
    this.emit(val ? 'open' : 'close', reason);
  }

  /** @internal — for testing only */
  get _pendingEventCount(): number {
    return this._pendingEvents.length;
  }
}
