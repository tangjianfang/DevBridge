// packages/server/src/command-dispatcher/__tests__/command-dispatcher.test.ts

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CommandDispatcher, setUpstreamSend, setDownstreamSend } from '../command-dispatcher.js';
import type { IPCMessage } from '@devbridge/shared';
import type { CommandResult, BroadcastResult } from '@devbridge/shared';

// ── helpers ──────────────────────────────────────────────────────────────────

function injectData(
  dispatcher: CommandDispatcher,
  deviceId:   string,
  correlationId: string,
  fields:     Record<string, unknown> = {},
): void {
  dispatcher.handleIPCMessage({
    type: 'DATA_RECEIVED',
    payload: {
      deviceId,
      correlationId,
      message: { messageType: 'response:cmd', fields, rawHex: '' },
      rawBuffer: Buffer.from([]),
    },
  });
}

function sendCommand(
  dispatcher:    CommandDispatcher,
  deviceId:      string,
  correlationId: string,
  timeoutMs?:    number,
): void {
  dispatcher.handleIPCMessage({
    type: 'COMMAND_SEND',
    payload: { deviceId, commandId: 'testCmd', params: {}, correlationId, timeoutMs },
  });
}

// ── suite ─────────────────────────────────────────────────────────────────────

describe('CommandDispatcher', () => {
  let dispatcher: CommandDispatcher;
  let upstream:   ReturnType<typeof vi.fn>;
  let downstream: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    dispatcher = new CommandDispatcher();
    upstream   = vi.fn();
    downstream = vi.fn();
    dispatcher.configureIPC(upstream, downstream);
  });

  afterEach(async () => {
    // drain pending commands to avoid unhandled rejections leaking
    await dispatcher.stop();
    vi.useRealTimers();
    // reset module-level senders so tests are independent
    setUpstreamSend(() => {});
    setDownstreamSend(() => {});
  });

  // ── 1. Normal dispatch ─────────────────────────────────────────────────────

  it('resolves with correct CommandResult on DATA_RECEIVED', async () => {
    const resultPromise = new Promise<Partial<IPCMessage>>(r =>
      upstream.mockImplementationOnce(r),
    );

    sendCommand(dispatcher, 'dev-1', 'corr-1');
    injectData(dispatcher, 'dev-1', 'corr-1', { value: 42 });

    const msg = await resultPromise;
    const result = msg.payload as CommandResult;

    expect(msg.type).toBe('COMMAND_RESULT');
    expect(result.success).toBe(true);
    expect(result.correlationId).toBe('corr-1');
    expect(result.deviceId).toBe('dev-1');
    expect(result.data).toEqual({ value: 42 });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  // ── 2. Downstream forwarding ───────────────────────────────────────────────

  it('forwards COMMAND_SEND to downstream', () => {
    sendCommand(dispatcher, 'dev-1', 'corr-fwd');
    expect(downstream).toHaveBeenCalledOnce();
    expect(downstream).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'COMMAND_SEND' }),
    );
  });

  // ── 3. Timeout ────────────────────────────────────────────────────────────

  it('rejects with COMMAND_TIMEOUT after 5000 ms', async () => {
    const resultPromise = new Promise<Partial<IPCMessage>>(r =>
      upstream.mockImplementationOnce(r),
    );

    sendCommand(dispatcher, 'dev-t', 'corr-timeout', 5000);
    vi.advanceTimersByTime(5100);

    const msg = await resultPromise;
    const result = msg.payload as CommandResult;

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('COMMAND_TIMEOUT');
    expect(result.correlationId).toBe('corr-timeout');
  });

  // ── 4. Queue-full back-pressure ───────────────────────────────────────────

  it('rejects 33rd command with COMMAND_QUEUE_FULL immediately', async () => {
    // Fill the queue with 32 pending commands (large timeout so they don't fire)
    for (let i = 0; i < 32; i++) {
      sendCommand(dispatcher, 'dev-full', `fill-${i}`, 60_000);
    }

    // Next result from upstream is the queue-full reply
    const resultPromise = new Promise<Partial<IPCMessage>>(r =>
      upstream.mockImplementationOnce(r),
    );

    sendCommand(dispatcher, 'dev-full', 'corr-overflow');

    const msg = await resultPromise;
    const result = msg.payload as CommandResult;

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('COMMAND_QUEUE_FULL');
    expect(result.correlationId).toBe('corr-overflow');
  });

  // ── 5. stop() drains pending ───────────────────────────────────────────────

  it('stop() rejects all pending commands; second stop() is a no-op', async () => {
    const rejectedIds: string[] = [];

    // Collect upstream results
    upstream.mockImplementation((msg: Partial<IPCMessage>) => {
      const r = msg.payload as CommandResult;
      if (msg.type === 'COMMAND_RESULT' && !r.success) {
        rejectedIds.push(r.correlationId);
      }
    });

    for (let i = 0; i < 10; i++) {
      sendCommand(dispatcher, 'dev-stop', `corr-stop-${i}`, 60_000);
    }

    await dispatcher.stop();
    // Flush microtasks so _handleDispatch catch blocks run
    await Promise.resolve();
    await Promise.resolve();

    expect(rejectedIds).toHaveLength(10);
    expect(rejectedIds).toContain('corr-stop-0');
    expect(rejectedIds).toContain('corr-stop-9');

    // Second call must not throw
    await expect(dispatcher.stop()).resolves.toBeUndefined();
  });

  // ── 6. Broadcast — all succeed ────────────────────────────────────────────

  it('broadcast: all 3 devices succeed → succeededCount=3, failedCount=0', async () => {
    const broadcastPromise = new Promise<Partial<IPCMessage>>(r => {
      upstream.mockImplementation((msg: Partial<IPCMessage>) => {
        if (msg.type === 'BROADCAST_RESULT') r(msg);
      });
    });

    dispatcher.handleIPCMessage({
      type: 'COMMAND_BROADCAST',
      payload: {
        deviceIds:     ['da', 'db', 'dc'],
        commandId:     'ping',
        params:        {},
        correlationId: 'bc-ok',
      },
    });

    // Capture the 3 COMMAND_SEND calls made to downstream and respond
    const sent = downstream.mock.calls
      .map(c => c[0] as Partial<IPCMessage>)
      .filter(m => m.type === 'COMMAND_SEND');

    expect(sent).toHaveLength(3);

    for (const s of sent) {
      const p = s.payload as { deviceId: string; correlationId: string };
      injectData(dispatcher, p.deviceId, p.correlationId, { ok: true });
    }

    const msg = await broadcastPromise;
    const r   = msg.payload as BroadcastResult;

    expect(r.correlationId).toBe('bc-ok');
    expect(r.succeededCount).toBe(3);
    expect(r.failedCount).toBe(0);
    expect(r.results).toHaveLength(3);
    expect(r.results.every(x => x.success)).toBe(true);
  });

  // ── 7. Broadcast — partial timeout ────────────────────────────────────────

  it('broadcast: device "db" times out → succeededCount=2, failedCount=1', async () => {
    const broadcastPromise = new Promise<Partial<IPCMessage>>(r => {
      upstream.mockImplementation((msg: Partial<IPCMessage>) => {
        if (msg.type === 'BROADCAST_RESULT') r(msg);
      });
    });

    dispatcher.handleIPCMessage({
      type: 'COMMAND_BROADCAST',
      payload: {
        deviceIds:     ['da', 'db', 'dc'],
        commandId:     'scan',
        params:        {},
        correlationId: 'bc-partial',
      },
    });

    const sent = downstream.mock.calls
      .map(c => c[0] as Partial<IPCMessage>)
      .filter(m => m.type === 'COMMAND_SEND');

    expect(sent).toHaveLength(3);

    // Respond for da and dc; skip db so it will timeout
    for (const s of sent) {
      const p = s.payload as { deviceId: string; correlationId: string };
      if (p.deviceId !== 'db') {
        injectData(dispatcher, p.deviceId, p.correlationId, { ok: true });
      }
    }

    // Advance past the 100ms broadcast timeout for db
    vi.advanceTimersByTime(200);

    const msg = await broadcastPromise;
    const r   = msg.payload as BroadcastResult;

    expect(r.succeededCount).toBe(2);
    expect(r.failedCount).toBe(1);

    const dbResult = r.results.find(x => x.deviceId === 'db');
    expect(dbResult?.success).toBe(false);
    expect(dbResult?.errorCode).toBe('COMMAND_TIMEOUT');
  });

  // ── 8. Concurrent out-of-order resolution ────────────────────────────────

  it('concurrent commands on the same device resolve to correct correlationIds', async () => {
    const settled: CommandResult[] = [];
    const donePromise = new Promise<void>(res => {
      upstream.mockImplementation((msg: Partial<IPCMessage>) => {
        if (msg.type === 'COMMAND_RESULT') {
          settled.push(msg.payload as CommandResult);
          if (settled.length === 2) res();
        }
      });
    });

    sendCommand(dispatcher, 'dev-oo', 'oo-1');
    sendCommand(dispatcher, 'dev-oo', 'oo-2');

    // Respond in reverse order: oo-2 first, then oo-1
    injectData(dispatcher, 'dev-oo', 'oo-2', { seq: 2 });
    injectData(dispatcher, 'dev-oo', 'oo-1', { seq: 1 });

    await donePromise;

    const r1 = settled.find(r => r.correlationId === 'oo-1');
    const r2 = settled.find(r => r.correlationId === 'oo-2');

    expect(r1?.success).toBe(true);
    expect(r1?.data).toEqual({ seq: 1 });
    expect(r2?.success).toBe(true);
    expect(r2?.data).toEqual({ seq: 2 });
  });

  // ── 9. SUBSCRIBE_EVENTS forwarding ────────────────────────────────────────

  it('SUBSCRIBE_EVENTS is forwarded to downstream unchanged', () => {
    dispatcher.handleIPCMessage({
      type:    'SUBSCRIBE_EVENTS',
      payload: { deviceId: 'dev-sub', endpointIds: [1, 2] },
    });

    expect(downstream).toHaveBeenCalledWith({
      type:    'SUBSCRIBE_EVENTS',
      payload: { deviceId: 'dev-sub', endpointIds: [1, 2] },
    });
  });

  // ── 10. health() ──────────────────────────────────────────────────────────

  it('health() returns ok with pendingQueues count', async () => {
    const h = await dispatcher.health();
    expect(h.status).toBe('ok');
    expect((h.details as Record<string, unknown>)['pendingQueues']).toBe(0);

    sendCommand(dispatcher, 'dev-h', 'corr-h', 60_000);
    const h2 = await dispatcher.health();
    expect((h2.details as Record<string, unknown>)['pendingQueues']).toBe(1);
  });

  // ── 11. DATA_RECEIVED for unknown correlationId is silently ignored ────────

  it('DATA_RECEIVED for unknown correlationId does not throw', () => {
    expect(() =>
      injectData(dispatcher, 'dev-x', 'no-such-id', {}),
    ).not.toThrow();
  });

  // ── 12. start() is a no-op ────────────────────────────────────────────────

  it('start() resolves without side-effects', async () => {
    await expect(dispatcher.start()).resolves.toBeUndefined();
  });
});
