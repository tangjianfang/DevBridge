// packages/server/src/gateway/gateway-service.ts

import crypto from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import type {
  IService,
  ServiceHealth,
  ServiceMetrics,
  IPCMessage,
  GatewaySettings,
  CommandResult,
  BroadcastResult,
  MetricsSnapshot,
  DiagnosticResult,
} from '@devbridge/shared';

// ── Module-level IPC sender ───────────────────────────────────────────────────
// Sends messages to the CommandDispatcher (and through it, to DeviceManager).

let _ipcSend: ((msg: Partial<IPCMessage>) => void) | null = null;

export function setGatewayIpcSend(fn: (msg: Partial<IPCMessage>) => void): void {
  _ipcSend = fn;
}

// ── Internal types ─────────────────────────────────────────────────────────────

/** Lightweight WS connection record (socket typed as any for testability) */
export interface WsConnection {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  socket:        any;         // ws.WebSocket at runtime; any for testing
  clientId:      string;
  subscriptions: Set<string>; // subscribed deviceIds
  authenticated: boolean;     // local=always true; lan=true after successful auth frame
}

// ── Binary frame builder ───────────────────────────────────────────────────────

const BINARY_MAGIC = Buffer.from([0x44, 0x42, 0x52, 0x47]); // "DBRG"

export const BinaryFrame = {
  /** Build a 32-byte header + payload binary frame */
  build(frameType: number, deviceId: string, payload: Buffer): Buffer {
    const header = Buffer.alloc(32);
    BINARY_MAGIC.copy(header, 0);
    header.writeUInt32LE(frameType, 4);
    const idBuf = Buffer.from(deviceId.slice(0, 16), 'utf8');
    idBuf.copy(header, 8, 0, Math.min(idBuf.length, 16));
    header.writeBigUInt64LE(BigInt(Date.now()), 24);
    return Buffer.concat([header, payload]);
  },

  /** Parse a binary frame (returns null if magic mismatch) */
  parse(buf: Buffer): { frameType: number; deviceId: string; timestampMs: bigint; payload: Buffer } | null {
    if (buf.length < 32) return null;
    if (!buf.subarray(0, 4).equals(BINARY_MAGIC)) return null;
    return {
      frameType:   buf.readUInt32LE(4),
      deviceId:    buf.subarray(8, 24).toString('utf8').replace(/\0+$/, ''),
      timestampMs: buf.readBigUInt64LE(24),
      payload:     buf.subarray(32),
    };
  },
};

// ── GatewayService ─────────────────────────────────────────────────────────────

export class GatewayService implements IService {
  readonly serviceId = 'gateway';

  private fastify!: FastifyInstance;
  private settings!: GatewaySettings;

  /** Connected WS clients (clientId → WsConnection) */
  readonly wsClients = new Map<string, WsConnection>();

  /** PacketTap subscriptions: deviceId → Set<clientId> */
  private readonly packetTapSubscriptions = new Map<string, Set<string>>();

  /** Pending correlationId → resolver (for IPC COMMAND_RESULT routing) */
  private readonly pending = new Map<string, (msg: Partial<IPCMessage>) => void>();

  /** Metrics counters */
  private _totalCommands  = 0;
  private _errorCount     = 0;
  private readonly _startedAt = Date.now();
  private _messageCount   = 0;

  // ── IService lifecycle ──────────────────────────────────────────────────────

  /**
   * Configure settings before start(). Must be called before start().
   */
  configure(settings: GatewaySettings): void {
    this.settings = settings;
  }

  async start(): Promise<void> {
    await this._initFastify();
    const addr = this.settings.mode === 'lan' ? '0.0.0.0' : '127.0.0.1';
    await this.fastify.listen({ port: this.settings.port, host: addr });
  }

  /**
   * Initialise Fastify (register plugins + routes) but do NOT bind to a TCP port.
   * Used by unit tests via inject() without occupying a port.
   */
  async _initFastify(): Promise<void> {
    this.fastify = Fastify({ logger: false });

    // Plugins
    await this.fastify.register(fastifyWebsocket);
    await this.fastify.register(fastifyCors, {
      origin: this.settings.cors.origins.length > 0
        ? this.settings.cors.origins
        : false,
    });
    await this.fastify.register(fastifyRateLimit, {
      max:        this.settings.rateLimit.max,
      timeWindow: this.settings.rateLimit.timeWindow,
    });

    this._registerAuthHook();
    this._registerRoutes();
    this._registerWsRoute();

    await this.fastify.ready();
  }

  async stop(): Promise<void> {
    // Reject pending IPC calls
    for (const [, resolve] of this.pending) {
      resolve({
        type: 'COMMAND_RESULT',
        payload: {
          success: false,
          errorCode: 'GATEWAY_WORKER_TIMEOUT',
          errorMessage: 'Service stopped',
          durationMs: 0,
        } as CommandResult,
      });
    }
    this.pending.clear();

    // Close WS clients
    for (const [, c] of this.wsClients) {
      try { c.socket.close(); } catch { /* ignore */ }
    }
    this.wsClients.clear();

    try { await this.fastify?.close(); } catch { /* ignore if not started */ }
  }

  async health(): Promise<ServiceHealth> {
    return {
      status:  'healthy',
      details: { wsClients: this.wsClients.size, pendingCalls: this.pending.size },
    };
  }

  metrics(): ServiceMetrics {
    return {
      uptime:       BigInt(Date.now() - this._startedAt),
      messageCount: this._messageCount,
      errorCount:   this._errorCount,
      totalCommands: this._totalCommands,
      wsClients:    this.wsClients.size,
    };
  }

  // ── IPC handler (receives from workers) ────────────────────────────────────

  handleIPCMessage(msg: Partial<IPCMessage>): void {
    this._messageCount++;
    const payload = msg.payload as Record<string, unknown> | undefined;

    switch (msg.type) {
      case 'COMMAND_RESULT': {
        const r = payload as CommandResult;
        // Resolve any pending HTTP waiter
        const waiter = this.pending.get(r.correlationId);
        if (waiter) { this.pending.delete(r.correlationId); waiter(msg); }
        // Push WS device:response to subscribers of that device
        if (r.deviceId) {
          this.broadcastToDeviceSubscribers(r.deviceId, 'device:response', r);
        }
        break;
      }
      case 'BROADCAST_RESULT': {
        const br = payload as BroadcastResult;
        const waiter = this.pending.get(br.correlationId);
        if (waiter) { this.pending.delete(br.correlationId); waiter(msg); }
        break;
      }
      case 'DEVICE_STATUS_CHANGED': {
        const p = payload as Record<string, unknown>;
        const deviceId = p['deviceId'] as string;
        const status   = p['status'] as string;
        const evtType  = status === 'connected'    ? 'device:connected'
                       : status === 'disconnected' ? 'device:disconnected'
                       : status === 'reconnecting' ? 'device:reconnecting'
                       : status === 'removed'      ? 'device:removed'
                       : 'device:status';
        this.broadcastToDeviceSubscribers(deviceId, evtType, p);
        break;
      }
      case 'BINARY_FRAME': {
        const p = payload as { deviceId: string; buffer: Buffer };
        const frame = BinaryFrame.build(0x0001, p.deviceId, p.buffer);
        this.broadcastBinaryFrame(p.deviceId, frame);
        break;
      }
      case 'NOTIFICATION':
        this.broadcast('notification', payload);
        break;
      case 'METRICS_UPDATE':
        this.broadcast('metrics:update', payload as MetricsSnapshot);
        break;
      case 'DIAGNOSTICS_RESULT':
        this.broadcast('diagnostics:result', payload as DiagnosticResult);
        break;
      case 'PLUGIN_STATUS':
        this.broadcast('plugin:status', payload);
        break;
      case 'PROTOCOL_HOT_UPDATED':
        this.broadcast('protocol:updated', payload);
        break;
    }
  }

  // ── Broadcast helpers ───────────────────────────────────────────────────────

  /** Send a text frame to ALL connected and authenticated WS clients. */
  broadcast(type: string, payload: unknown): void {
    const msg = JSON.stringify({ type, payload });
    for (const [, c] of this.wsClients) {
      if (c.socket.readyState === /* OPEN */ 1 && c.authenticated) {
        try { c.socket.send(msg); } catch { /* ignore */ }
      }
    }
  }

  /** Send a text frame only to clients subscribed to `deviceId`. */
  broadcastToDeviceSubscribers(deviceId: string, type: string, payload: unknown): void {
    const msg = JSON.stringify({ type, payload });
    for (const [, c] of this.wsClients) {
      if (c.socket.readyState === 1 && c.authenticated && c.subscriptions.has(deviceId)) {
        try { c.socket.send(msg); } catch { /* ignore */ }
      }
    }
  }

  /** Send a binary frame only to PacketTap subscribers of `deviceId`. */
  broadcastBinaryFrame(deviceId: string, frame: Buffer | ArrayBuffer): void {
    const subs = this.packetTapSubscriptions.get(deviceId);
    if (!subs || subs.size === 0) return;
    for (const clientId of subs) {
      const c = this.wsClients.get(clientId);
      if (c?.socket.readyState === 1) {
        try { c.socket.send(frame); } catch { /* ignore */ }
      }
    }
  }

  // ── Fastify inject proxy (for testing without TCP) ──────────────────────────

  inject(opts: Parameters<FastifyInstance['inject']>[0]) {
    return this.fastify.inject(opts);
  }

  // ── WS message handler (exposed for testing) ──────────────────────────────

  _handleWsMessage(conn: WsConnection, raw: Buffer | string): void {
    let msg: { type: string; key?: string; payload?: unknown };
    try {
      msg = JSON.parse(raw.toString()) as typeof msg;
    } catch {
      return; // ignore malformed JSON
    }

    // ── Auth guard ──────────────────────────────────────────────────────────
    if (!conn.authenticated) {
      if (msg.type === 'auth') {
        if (msg.key && this.settings.apiKey && msg.key === this.settings.apiKey) {
          conn.authenticated = true;
          try { conn.socket.send(JSON.stringify({ type: 'auth:ok' })); } catch { /* ignore */ }
        } else {
          try {
            conn.socket.send(JSON.stringify({ type: 'auth:fail', code: 'GATEWAY_AUTH_FAILED' }));
            conn.socket.close();
          } catch { /* ignore */ }
        }
      }
      // Non-auth messages from unauthenticated clients are silently dropped
      return;
    }

    // ── Authenticated business messages ─────────────────────────────────────
    this._messageCount++;
    const p = msg.payload as Record<string, unknown> | undefined;

    switch (msg.type) {
      case 'device:command':
        this._totalCommands++;
        _ipcSend?.({ type: 'COMMAND_SEND', payload: p });
        break;
      case 'device:subscribe':
        if (p?.['deviceId']) {
          conn.subscriptions.add(p['deviceId'] as string);
          _ipcSend?.({ type: 'SUBSCRIBE_EVENTS', payload: p });
        }
        break;
      case 'device:unsubscribe':
        if (p?.['deviceId']) {
          conn.subscriptions.delete(p['deviceId'] as string);
        }
        break;
      case 'packettap:subscribe':
        if (p?.['deviceId']) {
          this._addPacketTapSub(conn.clientId, p['deviceId'] as string);
        }
        break;
      case 'packettap:unsubscribe':
        if (p?.['deviceId']) {
          this._removePacketTapSub(conn.clientId, p['deviceId'] as string);
        }
        break;
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _registerAuthHook(): void {
    if (this.settings.mode === 'local') return; // no auth in local mode

    const expectedKey = this.settings.apiKey ?? '';
    this.fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
      // Skip WS upgrade (handled by WS handler) and static paths
      if ((req as unknown as { isWebsocket?: boolean }).isWebsocket) return;
      const key = req.headers['x-devbridge-key'];
      if (key !== expectedKey) {
        await reply.code(401).send({
          error: { code: 'GATEWAY_AUTH_FAILED', message: 'Invalid or missing API key' },
        });
      }
    });
  }

  private _registerRoutes(): void {
    const f = this.fastify;
    const PREFIX = '/api/v1';

    // ── Devices ──────────────────────────────────────────────────────────────
    f.get(`${PREFIX}/devices`, async (_req, reply) => {
      const result = await this._ipcRequest('LIST_DEVICES', {});
      await reply.send({ data: result ?? [] });
    });

    f.get(`${PREFIX}/devices/:id`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const result = await this._ipcRequest('GET_DEVICE', { deviceId: id });
      if (!result) return reply.code(404).send({ error: { code: 'DEVICE_NOT_FOUND', message: `Device ${id} not found` } });
      await reply.send({ data: result });
    });

    f.post(`${PREFIX}/devices/:id/connect`, async (req, reply) => {
      const { id } = req.params as { id: string };
      await this._ipcRequest('DEVICE_CONNECT', { deviceId: id });
      await reply.send({ data: { deviceId: id, status: 'connecting' } });
    });

    f.post(`${PREFIX}/devices/:id/disconnect`, async (req, reply) => {
      const { id } = req.params as { id: string };
      await this._ipcRequest('DEVICE_DISCONNECT', { deviceId: id });
      await reply.send({ data: { deviceId: id, status: 'disconnected' } });
    });

    f.post(`${PREFIX}/devices/:id/command`, async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = req.body as { commandId: string; params?: Record<string, unknown>; timeoutMs?: number };
      const correlationId = crypto.randomUUID();
      this._totalCommands++;
      const result = await this._ipcRequest(
        'COMMAND_SEND',
        { deviceId: id, commandId: body.commandId, params: body.params ?? {}, correlationId, timeoutMs: body.timeoutMs },
        correlationId,
      );
      if (!result) return reply.code(504).send({ error: { code: 'GATEWAY_WORKER_TIMEOUT', message: 'Worker did not respond' } });
      const r = (result.payload as CommandResult);
      if (!r.success) {
        const code = r.errorCode ?? 'COMMAND_DISPATCH_FAILED';
        const httpCode = code === 'COMMAND_TIMEOUT' ? 504
                       : code === 'COMMAND_QUEUE_FULL' ? 429
                       : code === 'COMMAND_DEVICE_NOT_FOUND' ? 404
                       : 500;
        return reply.code(httpCode).send({ error: { code, message: r.errorMessage } });
      }
      await reply.send({ data: r });
    });

    f.post(`${PREFIX}/devices/broadcast`, async (req, reply) => {
      const body = req.body as { commandId: string; params?: Record<string, unknown>; deviceIds: string[] };
      const correlationId = crypto.randomUUID();
      const result = await this._ipcRequest(
        'COMMAND_BROADCAST',
        { commandId: body.commandId, params: body.params ?? {}, deviceIds: body.deviceIds, correlationId },
        correlationId,
      );
      const r = (result?.payload as BroadcastResult | undefined) ?? { correlationId, results: [], succeededCount: 0, failedCount: 0, totalMs: 0 };
      await reply.send({ data: r });
    });

    f.get(`${PREFIX}/devices/:id/history`, async (_req, reply) => {
      await reply.send({ data: [] }); // stub
    });

    // ── Plugins ───────────────────────────────────────────────────────────────
    f.get(`${PREFIX}/plugins`, async (_req, reply) => reply.send({ data: [] }));
    f.post(`${PREFIX}/plugins`, async (_req, reply) => reply.code(501).send({ error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented' } }));
    f.delete(`${PREFIX}/plugins/:id`, async (_req, reply) => reply.code(204).send());
    f.post(`${PREFIX}/plugins/upload`, async (_req, reply) => reply.code(501).send({ error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented' } }));
    f.post(`${PREFIX}/plugins/:id/source`, async (_req, reply) => reply.code(501).send({ error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented' } }));
    f.post(`${PREFIX}/plugins/:id/restart`, async (_req, reply) => reply.code(501).send({ error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented' } }));
    f.post(`${PREFIX}/devices/:id/plugin`, async (_req, reply) => reply.code(501).send({ error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented' } }));

    // ── Protocols ────────────────────────────────────────────────────────────
    f.get(`${PREFIX}/protocols`, async (_req, reply) => reply.send({ data: [] }));
    f.post(`${PREFIX}/protocols`, async (_req, reply) => reply.code(501).send({ error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented' } }));
    f.put(`${PREFIX}/protocols/:name`, async (_req, reply) => reply.code(501).send({ error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented' } }));
    f.delete(`${PREFIX}/protocols/:name`, async (_req, reply) => reply.code(204).send());

    // ── System ───────────────────────────────────────────────────────────────
    f.get(`${PREFIX}/system/health`, async (_req, reply) => {
      await reply.send({ data: { gateway: await this.health() } });
    });

    f.get(`${PREFIX}/system/metrics`, async (_req, reply) => {
      const m = this.metrics();
      // BigInt is not JSON-serializable; convert uptime to number for HTTP
      await reply.send({
        data: { ...m, uptime: Number(m.uptime) },
      });
    });

    f.get(`${PREFIX}/system/diagnostics`, async (_req, reply) => reply.send({ data: [] }));
    f.post(`${PREFIX}/system/diagnostics/run`, async (_req, reply) => reply.code(501).send({ error: { code: 'NOT_IMPLEMENTED', message: 'Not implemented' } }));

    f.get(`${PREFIX}/system/settings`, async (_req, reply) => {
      const masked = { ...this.settings, apiKey: this.settings.apiKey ? '***' : undefined };
      await reply.send({ data: masked });
    });

    f.put(`${PREFIX}/system/settings`, async (req, reply) => {
      const patch = req.body as Partial<GatewaySettings>;
      this.settings = { ...this.settings, ...patch };
      const masked = { ...this.settings, apiKey: this.settings.apiKey ? '***' : undefined };
      await reply.send({ data: masked });
    });

    f.post(`${PREFIX}/system/config/export`, async (_req, reply) => {
      const safe = { ...this.settings, apiKey: undefined };
      await reply.send({ data: JSON.stringify(safe) });
    });

    f.post(`${PREFIX}/system/config/import`, async (_req, reply) => {
      await reply.send({ data: { previewId: crypto.randomUUID() } });
    });

    f.post(`${PREFIX}/system/config/confirm`, async (_req, reply) => {
      await reply.send({ data: { applied: true } });
    });

    f.get(`${PREFIX}/system/update`, async (_req, reply) => {
      await reply.send({ data: { current: '0.0.1', latest: '0.0.1', hasUpdate: false } });
    });

    f.post(`${PREFIX}/system/update`, async (_req, reply) => {
      await reply.send({ data: { jobId: crypto.randomUUID() } });
    });
  }

  private _registerWsRoute(): void {
    const service = this;
    this.fastify.get('/ws', { websocket: true }, function wsHandler(socket, _req) {
      const clientId  = crypto.randomUUID();
      const isLocal   = service.settings.mode === 'local';
      const conn: WsConnection = {
        socket,
        clientId,
        subscriptions: new Set(),
        authenticated: isLocal,
      };
      service.wsClients.set(clientId, conn);

      socket.on('message', (raw: Buffer | string) => service._handleWsMessage(conn, raw));
      socket.on('close', () => {
        service.wsClients.delete(clientId);
        // Clean up packet-tap subscriptions
        for (const [deviceId, subs] of service.packetTapSubscriptions) {
          subs.delete(clientId);
          if (subs.size === 0) service.packetTapSubscriptions.delete(deviceId);
        }
      });
      socket.on('error', () => { /* ignore */ });
    });
  }

  /**
   * Send an IPC request to a worker and wait for a correlated reply.
   * If `correlationId` is provided, waits for a matching COMMAND_RESULT reply.
   * Otherwise returns immediately with `undefined`.
   */
  private async _ipcRequest(
    type:          string,
    payload:       Record<string, unknown>,
    correlationId?: string,
  ): Promise<Partial<IPCMessage> | undefined> {
    if (!correlationId) {
      _ipcSend?.({ type, payload });
      return undefined;
    }

    return new Promise<Partial<IPCMessage>>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        resolve({
          type: 'COMMAND_RESULT',
          payload: {
            correlationId,
            success:      false,
            errorCode:    'GATEWAY_WORKER_TIMEOUT',
            errorMessage: 'IPC response timeout (10s)',
            durationMs:   0,
          } as CommandResult,
        });
      }, 10_000);

      this.pending.set(correlationId, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });

      _ipcSend?.({ type, payload });
    });
  }

  private _addPacketTapSub(clientId: string, deviceId: string): void {
    const set = this.packetTapSubscriptions.get(deviceId) ?? new Set<string>();
    set.add(clientId);
    this.packetTapSubscriptions.set(deviceId, set);
  }

  private _removePacketTapSub(clientId: string, deviceId: string): void {
    this.packetTapSubscriptions.get(deviceId)?.delete(clientId);
  }
}
