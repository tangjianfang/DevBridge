// packages/server/src/__tests__/integration.test.ts
//
// End-to-end integration tests wiring GatewayService ↔ CommandDispatcher ↔ DeviceManager.
// All IPC is in-process; hardware transports are replaced with MockTransport.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type {
  RawDeviceInfo,
  IDeviceScanner,
  TransportType,
  IProtocol,
  DecodedMessage,
  IPCMessage,
  ProtocolSchema,
} from '@devbridge/shared';

import { GatewayService, setGatewayIpcSend } from '../gateway/gateway-service.js';
import { CommandDispatcher } from '../command-dispatcher/command-dispatcher.js';
import { DeviceManager }     from '../device-manager/device-manager.js';
import { DeviceChannel }     from '../device-manager/device-channel.js';
import { MockTransport }     from '../transport/mock/mock-transport.js';
import { DynamicProtocol }   from '../protocol/dynamic-protocol.js';

// ─── MockScanner ─────────────────────────────────────────────────────────────

class MockScanner extends EventEmitter implements IDeviceScanner {
  readonly transportType: TransportType = 'usb-hid';
  private watching = false;

  scan(): Promise<RawDeviceInfo[]>  { return Promise.resolve([]); }
  startWatching(): void             { this.watching = true; }
  stopWatching():  void             { this.watching = false; }

  /** Simulate a device being physically attached. */
  attach(raw: RawDeviceInfo): void {
    this.emit('attached', raw);
  }

  /** Simulate a device being physically detached. */
  detach(address: string): void {
    this.emit('detached', address);
  }
}

// ─── Mock protocol ────────────────────────────────────────────────────────────

/** Tiny in-memory protocol that JSON-encodes/decodes without framing. */
const echoProtocol: IProtocol = {
  name:    'echo',
  version: '1.0',
  encode(commandId: string, params: Record<string, unknown>): Buffer {
    return Buffer.from(JSON.stringify({ commandId, params }));
  },
  decode(buf: Buffer): DecodedMessage {
    const obj = JSON.parse(buf.toString()) as { commandId: string; params: Record<string, unknown> };
    return {
      messageType: `response:${obj.commandId}`,
      fields:      { echo: obj.commandId, params: obj.params },
      rawHex:      buf.toString('hex'),
    };
  },
  validate(): void {},
};

// ─── Integration fixture setup ────────────────────────────────────────────────

/** Default local-mode GatewaySettings. */
function makeSettings() {
  return {
    port:    0, // random port (unused — tests use inject())
    mode:    'local' as const,
    cors:    { enabled: false, origins: [] },
    rateLimit: { max: 1000, timeWindow: '1 minute' },
  };
}

interface Suite {
  gw:      GatewayService;
  cmd:     CommandDispatcher;
  dm:      DeviceManager;
  scanner: MockScanner;
}

async function buildFixture(): Promise<Suite> {
  const gw      = new GatewayService();
  const cmd     = new CommandDispatcher();
  const dm      = new DeviceManager();
  const scanner = new MockScanner();

  // ── Wire IPC ──────────────────────────────────────────────────────────────
  // GatewayService outbound → CommandDispatcher (handles COMMAND_SEND,
  // COMMAND_BROADCAST, SUBSCRIBE_EVENTS) and DeviceManager (other).
  setGatewayIpcSend((msg: Partial<IPCMessage>) => {
    cmd.handleIPCMessage(msg);
    dm.handleIPCMessage(msg);
  });

  // CommandDispatcher upstream → GatewayService (COMMAND_RESULT, BROADCAST_RESULT)
  // CommandDispatcher downstream → DeviceManager (COMMAND_SEND, SUBSCRIBE_EVENTS)
  cmd.configureIPC(
    (msg) => gw.handleIPCMessage(msg),
    (msg) => dm.handleIPCMessage(msg),
  );

  // DeviceManager outbound → route by type
  dm.configureIPC((msg: IPCMessage) => {
    if (msg.type === 'DATA_RECEIVED') {
      cmd.handleIPCMessage(msg);
    } else {
      // DEVICE_STATUS_CHANGED, LOG_ENTRY, etc. → GatewayService
      gw.handleIPCMessage(msg);
    }
  });

  // Register scanner
  dm.registerScanner('usb-hid', scanner);

  gw.configure(makeSettings());
  await gw._initFastify();

  return { gw, cmd, dm, scanner };
}

async function teardownFixture({ gw, cmd, dm }: Suite): Promise<void> {
  await Promise.allSettled([gw.stop(), cmd.stop(), dm.stop()]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suites
// ─────────────────────────────────────────────────────────────────────────────

describe('Integration: service wiring', () => {
  let suite: Suite;

  beforeEach(async () => {
    suite = await buildFixture();
    await suite.dm.start();
  });

  afterEach(async () => {
    await teardownFixture(suite);
  });

  // ── 1. Health endpoint ──────────────────────────────────────────────────────

  it('GET /api/v1/system/health returns 200', async () => {
    const res = await suite.gw.inject({
      method: 'GET',
      url:    '/api/v1/system/health',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { gateway: { status: string } } };
    // Health route returns { data: { gateway: ServiceHealth } }
    expect(body.data.gateway.status).toBe('healthy');
  });

  // ── 2. Devices list (fires-and-forgets, no IPC wait) ─────────────────────

  it('GET /api/v1/devices returns 200 with data array', async () => {
    const res = await suite.gw.inject({
      method: 'GET',
      url:    '/api/v1/devices',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });

  // ── 3. Command on non-existent device (full IPC chain) ───────────────────

  it('POST /api/v1/devices/:id/command with missing device returns error', async () => {
    const res = await suite.gw.inject({
      method:  'POST',
      url:     '/api/v1/devices/usb-hid:deadbeefdeadbeef/command',
      payload: { commandId: 'GET_FW', params: {} },
    });
    // DEVICE_NOT_FOUND → dispatcher rejects → COMMAND_RESULT success:false
    // GatewayService maps it to 404 or 500
    expect([404, 500, 504]).toContain(res.statusCode);
    const body = JSON.parse(res.body) as { error: { code: string } };
    expect(body.error.code).toBeTruthy();
  });

  // ── 4. System metrics endpoint ────────────────────────────────────────────

  it('GET /api/v1/system/metrics returns 200', async () => {
    const res = await suite.gw.inject({
      method: 'GET',
      url:    '/api/v1/system/metrics',
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { wsClients: number } };
    expect(typeof body.data.wsClients).toBe('number');
  });

  // ── 5. Services health aggregation ────────────────────────────────────────

  it('all services report healthy', async () => {
    const [gwH, cmdH, dmH] = await Promise.all([
      suite.gw.health(),
      suite.cmd.health(),
      suite.dm.health(),
    ]);
    expect(gwH.status).toBe('healthy');
    expect(cmdH.status).toBe('ok');
    expect(dmH.status).toBe('ok');
  });
});

// ─── Integration: device attach + command success ─────────────────────────────

describe('Integration: device lifecycle + command', () => {
  let suite: Suite;
  let mockTransport: MockTransport;

  beforeEach(async () => {
    suite = await buildFixture();

    // Capture the real factory BEFORE installing the spy to avoid infinite recursion
    const realCreate = DeviceChannel.create.bind(DeviceChannel);

    // Spy on DeviceChannel.create to inject MockTransport + echo protocol
    mockTransport = new MockTransport('usb-hid', 'usb-hid:aabbccddaabbccdd');
    vi.spyOn(DeviceChannel, 'create').mockImplementation(
      (raw, _proto, reconnOpts) =>
        realCreate(raw, echoProtocol, reconnOpts ?? {}, mockTransport),
    );

    await suite.dm.start();

    // Attach a mock device
    const raw: RawDeviceInfo = {
      transportType: 'usb-hid',
      address:       'mock:0',
      vendorId:      0xdead,
      productId:     0xbeef,
      name:          'Integration Test Device',
    };
    suite.scanner.attach(raw);

    // Wait for DeviceChannel.connect() → MockTransport.connect() → 'open' → 'connected'
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await teardownFixture(suite);
  });

  it('device appears in DeviceManager after scanner attach', async () => {
    const devices = suite.dm.listDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]!.transportType).toBe('usb-hid');
  });

  it('device reaches connected status', async () => {
    const devices = suite.dm.listDevices();
    expect(devices[0]!.status).toBe('connected');
  });

  it('full command round-trip via HTTP → IPC → transport → IPC → HTTP', async () => {
    const deviceId = suite.dm.listDevices()[0]!.deviceId;

    // Intercept MockTransport.send → immediately inject echo response
    const originalSend = mockTransport.send.bind(mockTransport);
    vi.spyOn(mockTransport, 'send').mockImplementation(async (buf: Buffer) => {
      await originalSend(buf);
      // Echo the exact buffer back as a command response
      setImmediate(() => mockTransport.injectData(buf));
    });

    const res = await suite.gw.inject({
      method:  'POST',
      url:     `/api/v1/devices/${deviceId}/command`,
      payload: { commandId: 'PING', params: { seq: 1 } },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: { success: boolean; data: { echo: string } } };
    expect(body.data.success).toBe(true);
    expect(body.data.data!['echo']).toBe('PING');
  });

  it('device detach updates status', async () => {
    suite.scanner.detach('mock:0');
    // onDeviceDetached sets status to 'detached'
    const devices = suite.dm.listDevices();
    expect(devices[0]!.status).toBe('detached');
  });
});

// ─── Integration: protocol DSL round-trip ─────────────────────────────────────

describe('Integration: Protocol DSL round-trip', () => {
  // Minimal schema for a sensor device with uint16 + uint8 fields
  const schema: ProtocolSchema = {
    name:      'sensor-protocol',
    version:   '1.0.0',
    transport: 'serial',
    framing: {
      mode:        'none',
    },
    channels: {
      command: {
        request: {
          fields: [{ name: 'cmdCode', type: 'uint8' }],
        },
        response: {
          fields: [
            { name: 'cmdCode', type: 'uint8' },
          ],
          commandIdField: 'cmdCode',
          statusField:    'cmdCode',
        },
      },
      event: {
        fields:      [{ name: 'evCode', type: 'uint8' }],
        eventIdField: 'evCode',
      },
    },
    commands: [
      {
        id:          'READ_SENSOR',
        requestCode: 0x01,
        params:      [{ name: 'cmdCode', type: 'uint8', value: 0x01, default: 0x01 }],
        response:    [
          { name: 'temperature', type: 'uint16le' },
          { name: 'humidity',    type: 'uint8' },
        ],
      },
    ],
    events: [],
  };

  it('encode produces a buffer', () => {
    const protocol = new DynamicProtocol(schema);
    const buf      = protocol.encode('READ_SENSOR', {});
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('decode parses temperature and humidity fields from response buffer', () => {
    const protocol = new DynamicProtocol(schema);

    // Build mock response: cmdCode=0x01, temperature=253 LE, humidity=60
    const buf = Buffer.alloc(4);
    buf.writeUInt8(0x01, 0);    // cmdCode
    buf.writeUInt16LE(253, 1);  // temperature (25.3 decoded with scale if defined)
    buf.writeUInt8(60, 3);      // humidity

    const decoded = protocol.decode(buf);
    expect(decoded.messageType).toBeTruthy();
    expect(decoded.fields['humidity']).toBe(60);
  });

  it('name and version match schema', () => {
    const protocol = new DynamicProtocol(schema);
    expect(protocol.name).toBe('sensor-protocol');
    expect(protocol.version).toBe('1.0.0');
  });
});

// ─── Integration: broadcast all requested devices error ───────────────────────

describe('Integration: broadcast', () => {
  let suite: Suite;

  beforeEach(async () => {
    suite = await buildFixture();
    await suite.dm.start();
  });

  afterEach(async () => {
    await teardownFixture(suite);
  });

  it('POST /api/v1/devices/broadcast with missing devices returns BroadcastResult', async () => {
    const res = await suite.gw.inject({
      method:  'POST',
      url:     '/api/v1/devices/broadcast',
      payload: {
        commandId: 'RESET',
        params:    {},
        deviceIds: ['usb-hid:nonexistent'],
      },
    });
    // BroadcastResult: 0 succeeded, 1 failed (DEVICE_NOT_FOUND or COMMAND_TIMEOUT)
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      data: { succeededCount: number; failedCount: number };
    };
    expect(body.data.succeededCount).toBe(0);
    expect(body.data.failedCount).toBe(1);
  });
});
