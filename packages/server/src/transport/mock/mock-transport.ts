// packages/server/src/transport/mock/mock-transport.ts

import type {
  TransportType,
  TransportConfig,
  TransportCapabilities,
  EndpointInfo,
} from '@devbridge/shared';
import type { DeviceInfo } from '@devbridge/shared';
import { BaseTransport } from '../base-transport.js';

export class MockTransport extends BaseTransport {
  readonly transportType: TransportType;
  readonly deviceId:      string;

  private _endpoints: EndpointInfo[];

  constructor(
    type:      TransportType = 'usb-hid',
    deviceId:  string        = 'mock:00000000',
    endpoints: EndpointInfo[] = [],
  ) {
    super();
    this.transportType = type;
    this.deviceId      = deviceId;
    this._endpoints    = endpoints;
  }

  async connect(_config: TransportConfig): Promise<void> {
    this.setConnected(true);
  }

  async disconnect(): Promise<void> {
    this.setConnected(false, 'mock-disconnect');
  }

  async send(_buffer: Buffer): Promise<void> {
    // no-op — tests inject responses manually
  }

  getInfo(): DeviceInfo {
    return {
      deviceId:       this.deviceId,
      transportType:  this.transportType,
      status:         this._connected ? 'connected' : 'disconnected',
      name:           'Mock Device',
      address:        'mock:0',
      lastSeenAt:     Date.now(),
      reconnectCount: 0,
    };
  }

  getCapabilities(): TransportCapabilities {
    return {
      canSubscribe:      true,
      canRequest:        true,
      canBroadcast:      false,
      maxPacketSize:     65535,
      isWireless:        false,
      requiresIsolation: false,
    };
  }

  getEndpoints(): EndpointInfo[] {
    return this._endpoints;
  }

  // ── Test helpers ─────────────────────────────────────────────

  /** Inject a command-response data frame */
  injectData(buffer: Buffer, endpointId = 'mock-data'): void {
    this.emitData(buffer, endpointId);
  }

  /** Inject an unsolicited event frame */
  injectEvent(buffer: Buffer, endpointId = 'mock-event'): void {
    this.emitEvent(buffer, endpointId);
  }

  /** Simulate physical disconnect */
  simulateDisconnect(reason = 'mock-disconnect'): void {
    this.setConnected(false, reason);
  }

  /** Simulate re-connection (used after simulateDisconnect in tests) */
  simulateConnect(): void {
    this.setConnected(true);
  }
}
