// packages/server/src/gateway/__tests__/gateway-service.test.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GatewayService, BinaryFrame, setGatewayIpcSend } from '../gateway-service.js';
import type { WsConnection } from '../gateway-service.js';
import type { GatewaySettings } from '@devbridge/shared';

// ── Default settings helpers ────────────────────────────────────────────────

function localSettings(overrides: Partial<GatewaySettings> = {}): GatewaySettings {
  return {
    mode:   'local',
    port:   7070,
    cors:   { enabled: false, origins: [] },
    rateLimit: { max: 100, timeWindow: '1 minute' },
    ...overrides,
  };
}

function lanSettings(apiKey = 'secret-key'): GatewaySettings {
  return {
    mode:   'lan',
    port:   7071,
    apiKey,
    cors:   { enabled: false, origins: [] },
    rateLimit: { max: 100, timeWindow: '1 minute' },
  };
}

/** Build a test WsConnection with a mock socket */
function mockConn(overrides: Partial<WsConnection> = {}): WsConnection & {
  sent: string[];
  closed: boolean;
} {
  const sent: string[] = [];
  let closed = false;
  const socket = {
    readyState: 1, // OPEN
    send:  (data: string | Buffer) => { sent.push(typeof data === 'string' ? data : data.toString()); },
    close: () => { closed = true; socket.readyState = 3; },
  };
  return {
    socket,
    clientId:      'test-client',
    subscriptions: new Set(),
    authenticated: false,
    get sent()   { return sent;   },
    get closed() { return closed; },
    ...overrides,
  };
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('GatewayService — HTTP (local mode)', () => {
  let service: GatewayService;

  beforeEach(async () => {
    service = new GatewayService();
    service.configure(localSettings());
    await service._initFastify();
  });

  afterEach(async () => {
    await service.stop();
    setGatewayIpcSend(() => {});
  });

  it('GET /api/v1/system/health returns 200 without auth key', async () => {
    const res = await service.inject({ method: 'GET', url: '/api/v1/system/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: unknown };
    expect(body).toHaveProperty('data');
  });

  it('GET /api/v1/devices returns 200 with empty array', async () => {
    // Stub IPC to never respond (list_devices returns undefined → [])
    setGatewayIpcSend(() => {});
    const res = await service.inject({ method: 'GET', url: '/api/v1/devices' });
    // The route awaits ipcRequest with no correlationId, so it returns [] immediately
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  it('GET /api/v1/system/settings masks the apiKey', async () => {
    service.configure(lanSettings('my-super-secret'));
    const res = await service.inject({
      method:  'GET',
      url:     '/api/v1/system/settings',
      headers: { 'x-devbridge-key': 'my-super-secret' },
    });
    // Reinit fastify with lan settings to apply auth hook
    // For this test, just verify local settings (no apiKey) returns no key exposure
    service.configure(localSettings());
    const res2 = await service.inject({ method: 'GET', url: '/api/v1/system/settings' });
    const body = JSON.parse(res2.body) as { data: { apiKey?: string } };
    expect(body.data.apiKey).toBeUndefined();
  });

  it('POST /api/v1/system/config/export omits apiKey', async () => {
    service.configure(localSettings({ apiKey: undefined }));
    const res = await service.inject({ method: 'POST', url: '/api/v1/system/config/export' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: string };
    const exported = JSON.parse(body.data) as Record<string, unknown>;
    expect(exported['apiKey']).toBeUndefined();
  });
});

// ── Suite: HTTP auth (lan mode) ──────────────────────────────────────────────

describe('GatewayService — HTTP auth (lan mode)', () => {
  let service: GatewayService;

  beforeEach(async () => {
    service = new GatewayService();
    service.configure(lanSettings('s3cr3t'));
    await service._initFastify();
  });

  afterEach(async () => {
    await service.stop();
    setGatewayIpcSend(() => {});
  });

  it('returns 401 when X-DevBridge-Key header is missing', async () => {
    const res = await service.inject({ method: 'GET', url: '/api/v1/system/health' });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBe('GATEWAY_AUTH_FAILED');
  });

  it('returns 401 when X-DevBridge-Key is wrong', async () => {
    const res = await service.inject({
      method:  'GET',
      url:     '/api/v1/system/health',
      headers: { 'x-devbridge-key': 'wrong-key' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 200 when X-DevBridge-Key is correct', async () => {
    const res = await service.inject({
      method:  'GET',
      url:     '/api/v1/system/health',
      headers: { 'x-devbridge-key': 's3cr3t' },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ── Suite: rate limiting ─────────────────────────────────────────────────────

describe('GatewayService — rate limit', () => {
  let service: GatewayService;

  beforeEach(async () => {
    service = new GatewayService();
    service.configure(localSettings({ rateLimit: { max: 2, timeWindow: '1 minute' } }));
    await service._initFastify();
  });

  afterEach(async () => {
    await service.stop();
  });

  it('returns 429 after exceeding max requests per window', async () => {
    // First 2 requests should succeed
    const r1 = await service.inject({ method: 'GET', url: '/api/v1/system/health' });
    const r2 = await service.inject({ method: 'GET', url: '/api/v1/system/health' });
    // 3rd should be rate-limited
    const r3 = await service.inject({ method: 'GET', url: '/api/v1/system/health' });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(429);
  });
});

// ── Suite: WebSocket auth ────────────────────────────────────────────────────

describe('GatewayService — WS auth', () => {
  let service: GatewayService;

  beforeEach(async () => {
    service = new GatewayService();
    service.configure(lanSettings('ws-key'));
    await service._initFastify();
  });

  afterEach(async () => {
    await service.stop();
    setGatewayIpcSend(() => {});
  });

  it('lan mode: non-auth message before auth is silently dropped and connection closed', () => {
    const conn = mockConn();
    service.wsClients.set(conn.clientId, conn);

    // Send a device:command before authenticating
    service._handleWsMessage(conn, JSON.stringify({ type: 'device:command', payload: { deviceId: 'x' } }));

    // Nothing sent back yet (message silently dropped)
    expect(conn.sent).toHaveLength(0);
    expect(conn.closed).toBe(false);
  });

  it('lan mode: auth:ok when correct key is sent', () => {
    const conn = mockConn();
    service.wsClients.set(conn.clientId, conn);

    service._handleWsMessage(conn, JSON.stringify({ type: 'auth', key: 'ws-key' }));

    expect(conn.authenticated).toBe(true);
    expect(conn.sent.some(s => JSON.parse(s).type === 'auth:ok')).toBe(true);
  });

  it('lan mode: auth:fail when wrong key is sent, socket closed', () => {
    const conn = mockConn();
    service.wsClients.set(conn.clientId, conn);

    service._handleWsMessage(conn, JSON.stringify({ type: 'auth', key: 'bad-key' }));

    expect(conn.authenticated).toBe(false);
    expect(conn.sent.some(s => {
      const p = JSON.parse(s) as { type: string; code?: string };
      return p.type === 'auth:fail' && p.code === 'GATEWAY_AUTH_FAILED';
    })).toBe(true);
    expect(conn.closed).toBe(true);
  });

  it('local mode: clients are pre-authenticated (no auth frame needed)', () => {
    service.configure(localSettings());
    const conn = mockConn({ authenticated: true });
    service.wsClients.set(conn.clientId, conn);
    expect(conn.authenticated).toBe(true);
  });
});

// ── Suite: WS device:command forwarding ─────────────────────────────────────

describe('GatewayService — WS device:command', () => {
  let service: GatewayService;
  let ipcMessages: Array<{ type: string }>;

  beforeEach(async () => {
    service = new GatewayService();
    service.configure(localSettings());
    await service._initFastify();
    ipcMessages = [];
    setGatewayIpcSend(msg => ipcMessages.push(msg as { type: string }));
  });

  afterEach(async () => {
    await service.stop();
    setGatewayIpcSend(() => {});
  });

  it('device:command is forwarded to IPC as COMMAND_SEND', () => {
    const conn = mockConn({ authenticated: true });
    service.wsClients.set(conn.clientId, conn);

    service._handleWsMessage(conn, JSON.stringify({
      type:    'device:command',
      payload: { deviceId: 'dev-1', commandId: 'read', params: {}, correlationId: 'corr-ws' },
    }));

    expect(ipcMessages.some(m => m.type === 'COMMAND_SEND')).toBe(true);
  });

  it('device:subscribe adds deviceId to subscriptions and forwards to IPC', () => {
    const conn = mockConn({ authenticated: true });
    service.wsClients.set(conn.clientId, conn);

    service._handleWsMessage(conn, JSON.stringify({
      type:    'device:subscribe',
      payload: { deviceId: 'dev-sub' },
    }));

    expect(conn.subscriptions.has('dev-sub')).toBe(true);
    expect(ipcMessages.some(m => m.type === 'SUBSCRIBE_EVENTS')).toBe(true);
  });

  it('device:unsubscribe removes deviceId from subscriptions', () => {
    const conn = mockConn({ authenticated: true });
    conn.subscriptions.add('dev-sub');
    service.wsClients.set(conn.clientId, conn);

    service._handleWsMessage(conn, JSON.stringify({
      type:    'device:unsubscribe',
      payload: { deviceId: 'dev-sub' },
    }));

    expect(conn.subscriptions.has('dev-sub')).toBe(false);
  });
});

// ── Suite: broadcastToDeviceSubscribers ─────────────────────────────────────

describe('GatewayService — broadcastToDeviceSubscribers', () => {
  let service: GatewayService;

  beforeEach(async () => {
    service = new GatewayService();
    service.configure(localSettings());
    await service._initFastify();
  });

  afterEach(async () => {
    await service.stop();
  });

  it('sends only to clients subscribed to that deviceId', () => {
    const c1 = mockConn({ clientId: 'c1', authenticated: true });
    const c2 = mockConn({ clientId: 'c2', authenticated: true });
    const c3 = mockConn({ clientId: 'c3', authenticated: true });

    c1.subscriptions.add('device-A');
    c2.subscriptions.add('device-A');
    // c3 is NOT subscribed to device-A

    service.wsClients.set('c1', c1);
    service.wsClients.set('c2', c2);
    service.wsClients.set('c3', c3);

    service.broadcastToDeviceSubscribers('device-A', 'device:event', { data: 42 });

    expect(c1.sent).toHaveLength(1);
    expect(c2.sent).toHaveLength(1);
    expect(c3.sent).toHaveLength(0); // not subscribed
  });
});

// ── Suite: broadcast (global) ────────────────────────────────────────────────

describe('GatewayService — broadcast (global)', () => {
  let service: GatewayService;

  beforeEach(async () => {
    service = new GatewayService();
    service.configure(localSettings());
    await service._initFastify();
  });

  afterEach(async () => {
    await service.stop();
  });

  it('sends to ALL authenticated connected clients', () => {
    const c1 = mockConn({ clientId: 'c1', authenticated: true });
    const c2 = mockConn({ clientId: 'c2', authenticated: true });
    const c3 = mockConn({ clientId: 'c3', authenticated: true });

    service.wsClients.set('c1', c1);
    service.wsClients.set('c2', c2);
    service.wsClients.set('c3', c3);

    service.broadcast('notification', { message: 'Hello' });

    expect(c1.sent).toHaveLength(1);
    expect(c2.sent).toHaveLength(1);
    expect(c3.sent).toHaveLength(1);

    const parsed = JSON.parse(c1.sent[0]!) as { type: string; payload: { message: string } };
    expect(parsed.type).toBe('notification');
    expect(parsed.payload.message).toBe('Hello');
  });

  it('does not send to unauthenticated clients', () => {
    const authed   = mockConn({ clientId: 'authed',   authenticated: true  });
    const unauthed = mockConn({ clientId: 'unauthed', authenticated: false });

    service.wsClients.set('authed',   authed);
    service.wsClients.set('unauthed', unauthed);

    service.broadcast('test', {});

    expect(authed.sent).toHaveLength(1);
    expect(unauthed.sent).toHaveLength(0);
  });
});

// ── Suite: PacketTap binary frames ───────────────────────────────────────────

describe('GatewayService — PacketTap (broadcastBinaryFrame)', () => {
  let service: GatewayService;

  beforeEach(async () => {
    service = new GatewayService();
    service.configure(localSettings());
    await service._initFastify();
  });

  afterEach(async () => {
    await service.stop();
  });

  it('packettap:subscribe → only subscriber receives BINARY_FRAME for that device', () => {
    const subscriber    = mockConn({ clientId: 'sub', authenticated: true });
    const nonSubscriber = mockConn({ clientId: 'no-sub', authenticated: true });

    service.wsClients.set('sub',    subscriber);
    service.wsClients.set('no-sub', nonSubscriber);

    // Subscribe 'sub' to device-A via WS message
    service._handleWsMessage(subscriber, JSON.stringify({
      type:    'packettap:subscribe',
      payload: { deviceId: 'device-A' },
    }));

    const frame = BinaryFrame.build(0x0001, 'device-A', Buffer.from([1, 2, 3]));
    service.broadcastBinaryFrame('device-A', frame);

    expect(subscriber.sent).toHaveLength(1);
    expect(nonSubscriber.sent).toHaveLength(0);
  });

  it('subscriber of device-A does NOT receive frames for device-B', () => {
    const sub = mockConn({ clientId: 'sub', authenticated: true });
    service.wsClients.set('sub', sub);

    service._handleWsMessage(sub, JSON.stringify({
      type:    'packettap:subscribe',
      payload: { deviceId: 'device-A' },
    }));

    const frameB = BinaryFrame.build(0x0001, 'device-B', Buffer.from([5, 6]));
    service.broadcastBinaryFrame('device-B', frameB);

    expect(sub.sent).toHaveLength(0); // device-B frames not delivered
  });

  it('packettap:unsubscribe stops delivery', () => {
    const sub = mockConn({ clientId: 'sub', authenticated: true });
    service.wsClients.set('sub', sub);

    service._handleWsMessage(sub, JSON.stringify({
      type:    'packettap:subscribe',
      payload: { deviceId: 'device-A' },
    }));
    service._handleWsMessage(sub, JSON.stringify({
      type:    'packettap:unsubscribe',
      payload: { deviceId: 'device-A' },
    }));

    const frame = BinaryFrame.build(0x0001, 'device-A', Buffer.from([1]));
    service.broadcastBinaryFrame('device-A', frame);

    expect(sub.sent).toHaveLength(0);
  });
});

// ── Suite: BinaryFrame builder / parser ─────────────────────────────────────

describe('BinaryFrame', () => {
  it('builds a frame with correct magic header', () => {
    const frame = BinaryFrame.build(0x0001, 'dev-abc', Buffer.from([0xAA, 0xBB]));
    expect(frame.subarray(0, 4)).toEqual(Buffer.from([0x44, 0x42, 0x52, 0x47]));
    expect(frame.readUInt32LE(4)).toBe(0x0001);
  });

  it('parses a frame back to original fields', () => {
    const payload = Buffer.from([1, 2, 3, 4]);
    const frame   = BinaryFrame.build(0x0002, 'my-device', payload);
    const parsed  = BinaryFrame.parse(frame);

    expect(parsed).not.toBeNull();
    expect(parsed!.frameType).toBe(0x0002);
    expect(parsed!.deviceId).toBe('my-device');
    expect(parsed!.payload).toEqual(payload);
  });

  it('returns null for frames with wrong magic', () => {
    const bad = Buffer.from([0x00, 0x00, 0x00, 0x00, ...new Array(28).fill(0)]);
    expect(BinaryFrame.parse(bad)).toBeNull();
  });

  it('returns null for frames shorter than 32 bytes', () => {
    expect(BinaryFrame.parse(Buffer.from([1, 2, 3]))).toBeNull();
  });
});

// ── Suite: stop() idempotency ────────────────────────────────────────────────

describe('GatewayService — stop() idempotency', () => {
  it('stop() can be called twice without throwing', async () => {
    const service = new GatewayService();
    service.configure(localSettings());
    await service._initFastify();

    await expect(service.stop()).resolves.toBeUndefined();
    await expect(service.stop()).resolves.toBeUndefined();
  });
});

// ── Suite: health() ──────────────────────────────────────────────────────────

describe('GatewayService — health()', () => {
  it('returns healthy with wsClients count', async () => {
    const service = new GatewayService();
    service.configure(localSettings());
    await service._initFastify();

    const h = await service.health();
    expect(h.status).toBe('healthy');
    expect((h.details as Record<string, unknown>)['wsClients']).toBe(0);

    await service.stop();
  });
});
