// packages/frontend/src/mw/ws/ws-client.ts

import { wsEventBus, batchEmit } from './ws-event-bus.js';

const RECONNECT_DELAY_MS     = 2000;
const MAX_RECONNECT_ATTEMPTS = 10;

export class WsClient {
  private ws?:       WebSocket;
  private url:       string;
  private attempt    = 0;
  private destroyed  = false;

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    if (this.destroyed) return;
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = 'arraybuffer'; // ← required for binary frames

    this.ws.onopen = () => {
      this.attempt = 0;
      wsEventBus.emit('ws:open');
    };

    this.ws.onclose = (ev) => {
      wsEventBus.emit('ws:close', ev);
      this.scheduleReconnect();
    };

    this.ws.onerror = (ev) => {
      wsEventBus.emit('ws:error', ev);
    };

    this.ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        wsEventBus.emit('ws:binary', ev.data); // → PacketTap
      } else {
        try {
          const msg = JSON.parse(ev.data as string) as { type: string; payload: unknown };
          // High-frequency device events and metrics are batch-emitted
          if (msg.type === 'device:event' || msg.type === 'metrics:update') {
            batchEmit(msg.type, msg.payload);
          } else {
            wsEventBus.emit(msg.type, msg.payload);
          }
        } catch {
          /* ignore malformed JSON */
        }
      }
    };
  }

  send(type: string, payload: unknown): void {
    if (this.ws && this.ws.readyState === 1 /* WebSocket.OPEN */) {
      this.ws.send(JSON.stringify({ type, payload }));
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.ws?.close();
  }

  /** Current WebSocket (exposed for testing). */
  get socket(): WebSocket | undefined {
    return this.ws;
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.attempt >= MAX_RECONNECT_ATTEMPTS) {
      wsEventBus.emit('ws:reconnect-exhausted');
      return;
    }
    this.attempt++;
    setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }
}

// Singleton — only instantiated in browser environments
let _wsClient: WsClient | null = null;

function getWsClient(): WsClient {
  if (!_wsClient) {
    const host =
      typeof window !== 'undefined' ? window.location.host : 'localhost';
    _wsClient = new WsClient(`ws://${host}/ws`);
  }
  return _wsClient;
}

export const wsClient: WsClient = new Proxy({} as WsClient, {
  get(_t, prop) {
    return (getWsClient() as unknown as Record<string, unknown>)[prop as string];
  },
});
