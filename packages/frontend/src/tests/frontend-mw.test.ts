// @vitest-environment happy-dom
// packages/frontend/src/tests/frontend-mw.test.ts
// Environment: happy-dom (set in vitest.config.ts)

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ─── Modules under test ──────────────────────────────────────────────────────

import { WsClient } from '../mw/ws/ws-client.js';
import {
  wsEventBus,
  batchEmit,
  flushBatchEmit,
} from '../mw/ws/ws-event-bus.js';
import {
  initStoreWiring,
  resetStoreWiring,
} from '../mw/ws/ws-store-wiring.js';
import { useDeviceStore } from '../mw/stores/device-store.js';
import { useNotificationStore } from '../mw/stores/notification-store.js';
import { useMetricsStore } from '../mw/stores/metrics-store.js';
import { usePluginStore } from '../mw/stores/plugin-store.js';
import { parseBinaryFrame } from '../mw/protocol/binary-frame.js';
import { commandService } from '../mw/commands/command-service.js';
import { usePacketTap } from '../ui/hooks/use-packet-tap.js';
import { useDeviceChannel } from '../ui/hooks/use-device-channel.js';
import type { DeviceInfo } from '@devbridge/shared';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a minimal DeviceInfo object. */
function makeDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    deviceId:       'usb:aabbccdd',
    transportType:  'usb',
    status:         'connected',
    name:           'Test Device',
    address:        'usb:1-2',
    lastSeenAt:     Date.now(),
    reconnectCount: 0,
    ...overrides,
  };
}

/**
 * Build a valid DBRG binary frame ArrayBuffer.
 *   magic     = 0x44425247  (big-endian)
 *   frameType = uint32LE
 *   deviceId  = 16 bytes UTF-8 null-padded
 *   timestamp = uint64LE (split as two uint32s)
 *   payload   = arbitrary bytes
 */
function buildFrame(
  deviceId   = 'dev1',
  frameType  = 1,
  timestamp  = 1234567890,
  payload    = new Uint8Array([0xde, 0xad]),
  magic      = 0x44425247,
): ArrayBuffer {
  const buf  = new ArrayBuffer(32 + payload.length);
  const view = new DataView(buf);
  view.setUint32(0, magic, false);        // magic, big-endian
  view.setUint32(4, frameType, true);     // frameType, little-endian
  // deviceId UTF-8, 16 bytes, null-padded
  const enc = new TextEncoder().encode(deviceId.slice(0, 16));
  new Uint8Array(buf, 8, 16).set(enc);
  // timestamp low/high
  view.setUint32(24, timestamp >>> 0, true);
  view.setUint32(28, 0, true);
  // payload
  new Uint8Array(buf, 32).set(payload);
  return buf;
}

// ─── Store reset helpers ──────────────────────────────────────────────────────

function resetStores() {
  useDeviceStore.setState({
    devices:     new Map(),
    eventBuffer: new Map(),
    wsStatus:    'connecting',
  });
  useNotificationStore.setState({ notifications: [], unreadCount: 0 });
  useMetricsStore.setState({ snapshots: [] });
  usePluginStore.setState({ plugins: new Map() });
}

// ─── MockWebSocket ────────────────────────────────────────────────────────────

class MockWebSocket {
  static OPEN   = 1;
  static CLOSED = 3;

  binaryType:  string = 'blob';
  readyState   = MockWebSocket.OPEN;
  url:         string;
  onopen:      ((ev: Event) => void) | null                   = null;
  onclose:     ((ev: CloseEvent) => void) | null              = null;
  onerror:     ((ev: Event) => void) | null                   = null;
  onmessage:   ((ev: MessageEvent) => void) | null            = null;
  sent:        string[] = [];

  constructor(url: string) {
    this.url = url;
  }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = MockWebSocket.CLOSED; }
}

// ─── 1. WsClient ─────────────────────────────────────────────────────────────

describe('WsClient', () => {
  let MockWS: typeof MockWebSocket;

  beforeEach(() => {
    MockWS = MockWebSocket;
    vi.stubGlobal('WebSocket', MockWS);
    wsEventBus.removeAllListeners();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    flushBatchEmit();
  });

  it('sets binaryType to arraybuffer after connect', () => {
    const client = new WsClient('ws://localhost/ws');
    client.connect();
    expect(client.socket?.binaryType).toBe('arraybuffer');
  });

  it('emits ws:open on connection open, resets attempt', () => {
    const client = new WsClient('ws://localhost/ws');
    const received: string[] = [];
    wsEventBus.on('ws:open', () => received.push('open'));
    client.connect();
    // Simulate open event
    client.socket!.onopen!(new Event('open'));
    expect(received).toEqual(['open']);
  });

  it('routes text frame to wsEventBus by type', () => {
    const client = new WsClient('ws://localhost/ws');
    const payloads: unknown[] = [];
    wsEventBus.on('device:connected', (p) => payloads.push(p));
    client.connect();

    const msg: MessageEvent = Object.assign(new Event('message'), {
      data: JSON.stringify({ type: 'device:connected', payload: { deviceId: 'x1' } }),
    }) as unknown as MessageEvent;
    client.socket!.onmessage!(msg);

    expect(payloads).toHaveLength(1);
    expect((payloads[0] as { deviceId: string }).deviceId).toBe('x1');
  });

  it('emits ws:binary for ArrayBuffer messages', () => {
    const client = new WsClient('ws://localhost/ws');
    const binaries: ArrayBuffer[] = [];
    wsEventBus.on('ws:binary', (ab) => binaries.push(ab as ArrayBuffer));
    client.connect();

    const ab  = new ArrayBuffer(8);
    const msg = Object.assign(new Event('message'), { data: ab }) as unknown as MessageEvent;
    client.socket!.onmessage!(msg);

    expect(binaries).toHaveLength(1);
    expect(binaries[0]).toBe(ab);
  });

  it('ignores malformed JSON text frames', () => {
    const client = new WsClient('ws://localhost/ws');
    client.connect();
    const msg = Object.assign(new Event('message'), {
      data: 'NOT JSON {{{{',
    }) as unknown as MessageEvent;
    expect(() => client.socket!.onmessage!(msg)).not.toThrow();
  });

  it('destroy prevents reconnect after close', () => {
    vi.useFakeTimers();
    const client = new WsClient('ws://localhost/ws');
    client.connect();
    client.destroy();
    // close fires after destroy
    client.socket!.onclose!(new CloseEvent('close'));
    // No reconnect should be scheduled
    const connectSpy = vi.spyOn(client, 'connect');
    vi.advanceTimersByTime(3000);
    expect(connectSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// ─── 2. WS Store Wiring ───────────────────────────────────────────────────────

describe('wsStoreWiring', () => {
  beforeEach(() => {
    resetStores();
    resetStoreWiring();
    initStoreWiring();
  });

  afterEach(() => {
    resetStoreWiring();
  });

  it('device:connected → DeviceStore upsertDevice', () => {
    const dev = makeDevice();
    wsEventBus.emit('device:connected', dev);
    expect(useDeviceStore.getState().devices.get(dev.deviceId)).toEqual(dev);
  });

  it('device:removed → DeviceStore removeDevice', () => {
    const dev = makeDevice();
    useDeviceStore.getState().upsertDevice(dev);
    wsEventBus.emit('device:removed', { deviceId: dev.deviceId });
    expect(useDeviceStore.getState().devices.has(dev.deviceId)).toBe(false);
  });

  it('notification → NotificationStore push', () => {
    wsEventBus.emit('notification', {
      severity:  'info',
      message:   'hello',
      timestamp: Date.now(),
    });
    const { notifications, unreadCount } = useNotificationStore.getState();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toBe('hello');
    expect(unreadCount).toBe(1);
  });

  it('ws:open → DeviceStore setWsStatus("open")', () => {
    wsEventBus.emit('ws:open');
    expect(useDeviceStore.getState().wsStatus).toBe('open');
  });

  it('ws:close → DeviceStore setWsStatus("closed")', () => {
    wsEventBus.emit('ws:close');
    expect(useDeviceStore.getState().wsStatus).toBe('closed');
  });

  it('ws:reconnect-exhausted → NotificationStore push error', () => {
    wsEventBus.emit('ws:reconnect-exhausted');
    const { notifications } = useNotificationStore.getState();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].severity).toBe('error');
  });
});

// ─── 3. parseBinaryFrame ─────────────────────────────────────────────────────

describe('parseBinaryFrame', () => {
  it('parses a valid DBRG frame correctly', () => {
    const payload = new Uint8Array([0x01, 0x02, 0x03]);
    const ab      = buildFrame('myDevice', 7, 99999, payload);
    const result  = parseBinaryFrame(ab);
    expect(result).not.toBeNull();
    expect(result!.deviceId).toBe('myDevice');
    expect(result!.frameType).toBe(7);
    expect(result!.timestamp).toBe(99999);
    expect(Array.from(result!.payload)).toEqual([0x01, 0x02, 0x03]);
  });

  it('returns null for wrong magic', () => {
    const ab = buildFrame('dev1', 1, 0, new Uint8Array(4), 0x00000000);
    expect(parseBinaryFrame(ab)).toBeNull();
  });

  it('returns null for buffer shorter than 32 bytes', () => {
    const ab = new ArrayBuffer(16);
    expect(parseBinaryFrame(ab)).toBeNull();
  });

  it('handles deviceId shorter than 16 bytes (null-padded)', () => {
    const ab     = buildFrame('abc', 1);
    const result = parseBinaryFrame(ab);
    expect(result!.deviceId).toBe('abc');
  });
});

// ─── 4. usePacketTap ─────────────────────────────────────────────────────────

describe('usePacketTap', () => {
  afterEach(() => {
    wsEventBus.removeAllListeners();
  });

  it('calls onFrame for matching deviceId', () => {
    const frames: unknown[] = [];
    renderHook(() => usePacketTap('dev1', (f) => frames.push(f)));
    wsEventBus.emit('ws:binary', buildFrame('dev1', 2));
    expect(frames).toHaveLength(1);
  });

  it('does not call onFrame for different deviceId', () => {
    const frames: unknown[] = [];
    renderHook(() => usePacketTap('dev1', (f) => frames.push(f)));
    wsEventBus.emit('ws:binary', buildFrame('dev2', 2));
    expect(frames).toHaveLength(0);
  });

  it('does not call onFrame for invalid magic (magic filter)', () => {
    const frames: unknown[] = [];
    renderHook(() => usePacketTap('dev1', (f) => frames.push(f)));
    // Build frame with magic = 0x00000000
    wsEventBus.emit('ws:binary', buildFrame('dev1', 1, 0, new Uint8Array(4), 0x00000000));
    expect(frames).toHaveLength(0);
  });
});

// ─── 5. useDeviceChannel timeout ─────────────────────────────────────────────

describe('useDeviceChannel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    wsEventBus.removeAllListeners();
  });

  it('rejects with COMMAND_TIMEOUT when no response arrives', async () => {
    const { result } = renderHook(() => useDeviceChannel('dev1'));

    let rejection: Error & { errorCode?: string } | undefined;

    act(() => {
      result.current
        .sendCommand('PING', {})
        .catch((e: Error & { errorCode?: string }) => {
          rejection = e;
        });
    });

    // Advance past the 5000ms command timeout
    await act(async () => {
      vi.advanceTimersByTime(5100);
    });

    expect(rejection).toBeDefined();
    expect(rejection!.message).toContain('PING');
    expect(rejection!.errorCode).toBe('COMMAND_TIMEOUT');
  });
});

// ─── 6. batchEmit ────────────────────────────────────────────────────────────

describe('batchEmit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    wsEventBus.removeAllListeners();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('merges multiple emits within 16ms into a single flush', () => {
    const received: unknown[] = [];
    wsEventBus.on('device:event', (p) => received.push(p));

    batchEmit('device:event', { n: 1 });
    batchEmit('device:event', { n: 2 });
    batchEmit('device:event', { n: 3 });

    // Not yet flushed
    expect(received).toHaveLength(0);

    vi.advanceTimersByTime(16);

    expect(received).toHaveLength(3);
    expect((received[0] as { n: number }).n).toBe(1);
    expect((received[2] as { n: number }).n).toBe(3);
  });
});

// ─── 7. NotificationStore ────────────────────────────────────────────────────

describe('NotificationStore', () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [], unreadCount: 0 });
  });

  it('push increments unreadCount', () => {
    const s = useNotificationStore.getState();
    s.push({ severity: 'info', message: 'msg1', timestamp: 1 });
    s.push({ severity: 'warning', message: 'msg2', timestamp: 2 });
    const { notifications, unreadCount } = useNotificationStore.getState();
    expect(notifications).toHaveLength(2);
    expect(unreadCount).toBe(2);
  });

  it('dismiss removes item and recalculates unreadCount', () => {
    const s = useNotificationStore.getState();
    s.push({ severity: 'info',    message: 'a', timestamp: 1 });
    s.push({ severity: 'warning', message: 'b', timestamp: 2 });
    s.push({ severity: 'error',   message: 'c', timestamp: 3 });

    const id1 = useNotificationStore.getState().notifications[1].id; // middle item
    useNotificationStore.getState().dismiss(id1);

    const { notifications, unreadCount } = useNotificationStore.getState();
    expect(notifications).toHaveLength(2);
    expect(unreadCount).toBe(2); // two remaining are still unread
  });

  it('markAllRead resets unreadCount to 0', () => {
    const s = useNotificationStore.getState();
    s.push({ severity: 'info', message: 'x', timestamp: 1 });
    s.push({ severity: 'info', message: 'y', timestamp: 2 });
    useNotificationStore.getState().markAllRead();
    const { notifications, unreadCount } = useNotificationStore.getState();
    expect(unreadCount).toBe(0);
    expect(notifications.every(n => n.read)).toBe(true);
  });

  it('caps notifications at 100', () => {
    const s = useNotificationStore.getState();
    for (let i = 0; i < 105; i++) {
      s.push({ severity: 'info', message: `msg${i}`, timestamp: i });
    }
    expect(useNotificationStore.getState().notifications).toHaveLength(100);
  });
});

// ─── 8. MetricsStore ─────────────────────────────────────────────────────────

describe('MetricsStore', () => {
  beforeEach(() => {
    useMetricsStore.setState({ snapshots: [] });
  });

  it('caps snapshots at 60', () => {
    const s = useMetricsStore.getState();
    for (let i = 0; i < 61; i++) {
      s.push({
        timestamp: i,
        cpuPercent: 0, memoryMb: 0, activeDevices: 0,
        bytesInPerSec: 0, bytesOutPerSec: 0,
        pendingCommands: 0, wsClientCount: 0,
      });
    }
    expect(useMetricsStore.getState().snapshots).toHaveLength(60);
  });

  it('latest() returns the most recent snapshot', () => {
    const s = useMetricsStore.getState();
    s.push({ timestamp: 1, cpuPercent: 10, memoryMb: 100, activeDevices: 1, bytesInPerSec: 0, bytesOutPerSec: 0, pendingCommands: 0, wsClientCount: 0 });
    s.push({ timestamp: 2, cpuPercent: 20, memoryMb: 200, activeDevices: 2, bytesInPerSec: 0, bytesOutPerSec: 0, pendingCommands: 0, wsClientCount: 0 });
    expect(useMetricsStore.getState().latest()?.timestamp).toBe(2);
  });
});

// ─── 9. DeviceStore ──────────────────────────────────────────────────────────

describe('DeviceStore', () => {
  beforeEach(() => resetStores());

  it('getConnectedDevices filters by status=connected', () => {
    const s = useDeviceStore.getState();
    s.upsertDevice(makeDevice({ deviceId: 'd1', status: 'connected' }));
    s.upsertDevice(makeDevice({ deviceId: 'd2', status: 'disconnected' }));
    const connected = useDeviceStore.getState().getConnectedDevices();
    expect(connected).toHaveLength(1);
    expect(connected[0].deviceId).toBe('d1');
  });

  it('appendEvent respects MAX_EVENTS_PER_DEVICE=200', () => {
    const s = useDeviceStore.getState();
    for (let i = 0; i < 205; i++) {
      s.appendEvent({
        deviceId:    'dev1',
        channel:     'event',
        messageType: 'tick',
        data:        { i },
        timestamp:   BigInt(i),
      });
    }
    const buf = useDeviceStore.getState().eventBuffer.get('dev1')!;
    expect(buf).toHaveLength(200);
    // Should be the last 200 events
    expect(buf[0].data['i']).toBe(5);
    expect(buf[199].data['i']).toBe(204);
  });

  it('removeDevice clears both devices and eventBuffer', () => {
    const s = useDeviceStore.getState();
    s.upsertDevice(makeDevice({ deviceId: 'rem1' }));
    s.appendEvent({ deviceId: 'rem1', channel: 'event', messageType: 'x', data: {}, timestamp: 0n });
    s.removeDevice('rem1');
    const st = useDeviceStore.getState();
    expect(st.devices.has('rem1')).toBe(false);
    expect(st.eventBuffer.has('rem1')).toBe(false);
  });
});

// ─── 10. commandService ───────────────────────────────────────────────────────

describe('commandService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sendCommand returns CommandResult on 200', async () => {
    const mockResult = {
      deviceId: 'd1', correlationId: 'c1', success: true,
      durationMs: 10,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok:   true,
        json: async () => ({ data: mockResult }),
      }),
    );

    const result = await commandService.sendCommand('d1', 'GET_VER', {});
    expect(result.correlationId).toBe('c1');
    expect(result.success).toBe(true);
    vi.unstubAllGlobals();
  });

  it('sendCommand throws on error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok:   false,
        json: async () => ({ error: 'Device not found' }),
      }),
    );

    await expect(commandService.sendCommand('d1', 'PING', {})).rejects.toBeTruthy();
    vi.unstubAllGlobals();
  });

  it('broadcast returns BroadcastResult on 200', async () => {
    const mockResult = {
      correlationId: 'bc1',
      results:       [],
      succeededCount: 2,
      failedCount:    0,
      totalMs:        50,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok:   true,
        json: async () => ({ data: mockResult }),
      }),
    );

    const result = await commandService.broadcast('RESET', {}, ['d1', 'd2']);
    expect(result.succeededCount).toBe(2);
    vi.unstubAllGlobals();
  });
});
