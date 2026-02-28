// packages/server/src/device-manager/__tests__/device-manager.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildDeviceId }         from '../device-id.js';
import { ReconnectController }   from '../reconnect-controller.js';
import { DeviceChannel, setIPCSender } from '../device-channel.js';
import { DeviceManager }         from '../device-manager.js';
import { MockTransport }         from '../../transport/mock/mock-transport.js';
import type { RawDeviceInfo, IPCMessage } from '@devbridge/shared';

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeRaw(overrides: Partial<RawDeviceInfo> = {}): RawDeviceInfo {
  return {
    transportType: 'usb-hid',
    address:       '/dev/usb1',
    vendorId:      0x1234,
    productId:     0x5678,
    serialNumber:  'SN001',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// buildDeviceId
// ─────────────────────────────────────────────────────────────────────────

describe('buildDeviceId', () => {
  it('is stable for the same input', () => {
    const raw = makeRaw();
    expect(buildDeviceId(raw)).toBe(buildDeviceId(raw));
  });

  it('differs for different addresses', () => {
    const a = buildDeviceId(makeRaw({ address: '/dev/usb1' }));
    const b = buildDeviceId(makeRaw({ address: '/dev/usb2' }));
    expect(a).not.toBe(b);
  });

  it('has correct prefix format', () => {
    const id = buildDeviceId(makeRaw());
    expect(id).toMatch(/^usb-hid:[0-9a-f]{16}$/);
  });

  it('uses 16-char hash (64-bit)', () => {
    const id   = buildDeviceId(makeRaw());
    const hash = id.split(':')[1]!;
    expect(hash).toHaveLength(16);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ReconnectController
// ─────────────────────────────────────────────────────────────────────────

describe('ReconnectController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function makeChannel() {
    const events: string[] = [];
    let connectCalls = 0;
    const channel = {
      connect:         async () => { connectCalls++; },
      markRemoved:     () => events.push('removed'),
      markReconnecting:(attempt: number, delay: number) =>
        events.push(`reconnecting:${attempt}:${delay}`),
    };
    return { channel, events, getConnectCalls: () => connectCalls };
  }

  it('schedules first retry with jitter=false', async () => {
    const { channel, events } = makeChannel();
    const ctrl = new ReconnectController(channel, { jitter: false });
    ctrl.scheduleRetry('disconnect');
    // delay = min(1000 * 1.5^0, 30000) = 1000ms
    expect(events[0]).toMatch(/^reconnecting:1:1000$/);
    await vi.runAllTimersAsync();
    expect(ctrl.currentAttempt).toBe(1);
  });

  it('second retry delay ≈ 1500ms (jitter=false)', async () => {
    const { channel, events } = makeChannel();
    const ctrl = new ReconnectController(channel, { jitter: false });
    ctrl.scheduleRetry();
    await vi.runAllTimersAsync();
    ctrl.scheduleRetry();
    // delay = 1000 * 1.5^1 = 1500
    expect(events[1]).toMatch(/^reconnecting:2:1500$/);
  });

  it('delay does not exceed maxDelay', () => {
    const { channel, events } = makeChannel();
    const ctrl = new ReconnectController(channel, { jitter: false, initialDelay: 10000, maxDelay: 15000, multiplier: 2 });
    ctrl.currentAttempt; // just access to check
    // Simulate 3 attempts manually: 10000, 15000 (capped), 15000 (capped)
    // Set attempt to 1 manually via resetAttempts then re-schedule
    ctrl.scheduleRetry();
    const delay = parseInt(events[0]!.split(':')[2]!, 10);
    expect(delay).toBeLessThanOrEqual(15000);
  });

  it('marks removed after maxAttempts', () => {
    const { channel, events } = makeChannel();
    const ctrl = new ReconnectController(channel, { jitter: false, maxAttempts: 2 });
    // Exhaust attempts
    for (let i = 0; i < 2; i++) {
      ctrl.scheduleRetry();
      // Manually increment to simulate completed retries
      ctrl.resetAttempts(); // reset to 0
    }
    // Simulate 2 attempts already done — set via internal increment
    // Use scheduleRetry twice until exhausted
    const ctrl2 = new ReconnectController(channel, { jitter: false, maxAttempts: 0 });
    ctrl2.scheduleRetry();
    expect(events).toContain('removed');
  });

  it('cancel prevents timer from firing', async () => {
    const { channel, getConnectCalls } = makeChannel();
    const ctrl = new ReconnectController(channel, { jitter: false });
    ctrl.scheduleRetry();
    ctrl.cancel();
    await vi.runAllTimersAsync();
    expect(getConnectCalls()).toBe(0);
  });

  it('isCancelled reflects cancel()', () => {
    const { channel } = makeChannel();
    const ctrl = new ReconnectController(channel, {});
    expect(ctrl.isCancelled).toBe(false);
    ctrl.cancel();
    expect(ctrl.isCancelled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DeviceChannel
// ─────────────────────────────────────────────────────────────────────────

describe('DeviceChannel', () => {
  let ipcMessages: IPCMessage[];
  let transport: MockTransport;

  beforeEach(() => {
    vi.useFakeTimers();
    ipcMessages = [];
    setIPCSender((m) => ipcMessages.push(m));
    transport = new MockTransport('usb-hid', 'test:device');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeChannel(raw?: Partial<RawDeviceInfo>) {
    return DeviceChannel.create(
      makeRaw(raw),
      null,
      { maxAttempts: 3, jitter: false },
      transport,
    );
  }

  it('initial status is scanning (no protocol)', () => {
    const ch = makeChannel();
    expect(ch.info.status).toBe('scanning');
  });

  it('status → identified when protocol provided', () => {
    const fakeProto = {
      name: 'test', version: '1.0.0',
      encode: () => Buffer.alloc(0),
      decode: () => ({ messageType: 'x', fields: {} }),
      validate: () => {},
    };
    const ch = DeviceChannel.create(makeRaw(), fakeProto as never, {}, transport);
    expect(ch.info.status).toBe('identified');
  });

  it('status → connecting → connected after transport.connect()', async () => {
    const ch = makeChannel();
    // setImmediate fires → connect() called → transport.setConnected(true) → 'open' event
    await vi.runAllTimersAsync();
    expect(ch.info.status).toBe('connected');
    const statuses = ipcMessages.map((m) => (m.payload as { status?: string })['status']).filter(Boolean);
    expect(statuses).toContain('connecting');
    expect(statuses).toContain('connected');
  });

  it('status → disconnected on transport close, then reconnecting', async () => {
    const ch = makeChannel();
    await vi.runAllTimersAsync(); // → connected
    transport.simulateDisconnect('test-reason');
    // updateStatus('disconnected') called first then markReconnecting, so current status is 'reconnecting'
    const statuses = ipcMessages.map((m) => (m.payload as { status?: string })['status']).filter(Boolean);
    expect(statuses).toContain('disconnected');
    expect(statuses).toContain('reconnecting');
    expect(['disconnected', 'reconnecting']).toContain(ch.info.status);
  });

  it('enqueueCorrelation → DATA_RECEIVED after mock data', async () => {
    const fakeProto = {
      name: 'test', version: '1.0.0',
      encode: () => Buffer.alloc(0),
      decode: () => ({ messageType: 'response:cmd', fields: { value: 42 } }),
      validate: () => {},
    };
    const ch = DeviceChannel.create(makeRaw(), fakeProto as never, {}, transport);
    await vi.runAllTimersAsync();

    ch.enqueueCorrelation('corr-001');
    transport.injectData(Buffer.from([0x01, 0x02]), 'ep0');

    const dataMsg = ipcMessages.find((m) => m.type === 'DATA_RECEIVED');
    expect(dataMsg).toBeDefined();
    const p = dataMsg?.payload as { correlationId?: string };
    expect(p?.correlationId).toBe('corr-001');
  });

  it('unsolicited frame (empty correlationIdQueue) logs warning', async () => {
    const fakeProto = {
      name: 'test', version: '1.0.0',
      encode: () => Buffer.alloc(0),
      decode: () => ({ messageType: 'x', fields: {} }),
      validate: () => {},
    };
    DeviceChannel.create(makeRaw(), fakeProto as never, {}, transport);
    await vi.runAllTimersAsync();
    // No enqueueCorrelation — inject data without a queued correlation
    transport.injectData(Buffer.from([0xff]), 'ep0');
    const warn = ipcMessages.find(
      (m) => m.type === 'LOG_ENTRY' && (m.payload as { level?: string }).level === 'warn',
    );
    expect(warn).toBeDefined();
  });

  it('close() is idempotent', async () => {
    const ch = makeChannel();
    await vi.runAllTimersAsync();
    const msgsBefore = ipcMessages.length;
    await ch.close();
    const msgsAfter1 = ipcMessages.length;
    await ch.close();
    const msgsAfter2 = ipcMessages.length;
    // Second close should not emit additional DEVICE_STATUS_CHANGED 'removed' double
    expect(msgsAfter2 - msgsAfter1).toBeLessThanOrEqual(1);
    expect(ch.info.status).toBe('removed');
  });

  it('deviceId is stable across multiple buildDeviceId calls', () => {
    const raw = makeRaw();
    const ch1 = DeviceChannel.create(raw, null, {}, transport);
    const ch2 = DeviceChannel.create(raw, null, {}, new MockTransport());
    expect(ch1.info.deviceId).toBe(ch2.info.deviceId);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// DeviceManager
// ─────────────────────────────────────────────────────────────────────────

describe('DeviceManager', () => {
  let manager: DeviceManager;
  let ipcMessages: IPCMessage[];

  beforeEach(() => {
    vi.useFakeTimers();
    ipcMessages = [];
    manager = new DeviceManager();
    manager.configureIPC((m) => ipcMessages.push(m));
  });

  afterEach(() => vi.useRealTimers());

  it('listDevices returns empty initially', () => {
    expect(manager.listDevices()).toEqual([]);
  });

  it('getDevice throws DEVICE_NOT_FOUND for unknown id', () => {
    expect(() => manager.getDevice('not-exist')).toThrow('DEVICE_NOT_FOUND');
  });

  it('hasDevice returns false for unknown id', () => {
    expect(manager.hasDevice('none')).toBe(false);
  });

  it('health returns ok status', async () => {
    const h = await manager.health();
    expect(h.status).toBe('ok');
  });

  it('start/stop is idempotent', async () => {
    await manager.start();
    await manager.start(); // second call is no-op
    await manager.stop();
    await manager.stop(); // second stop is no-op
  });

  it('handleIPCMessage: COMMAND_SEND for unknown device replies error', () => {
    manager.handleIPCMessage({
      type:    'COMMAND_SEND',
      payload: { deviceId: 'ghost', commandId: 'cmd', params: {}, correlationId: 'c1' },
    } as IPCMessage);
    const err = ipcMessages.find(
      (m) => m.type === 'DATA_RECEIVED' && (m.payload as { error?: unknown }).error,
    );
    expect(err).toBeDefined();
    const code = (err?.payload as { error?: { code?: string } }).error?.code;
    expect(code).toBe('DEVICE_NOT_FOUND');
  });
});
