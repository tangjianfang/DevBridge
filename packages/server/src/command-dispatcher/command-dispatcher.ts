// packages/server/src/command-dispatcher/command-dispatcher.ts

import crypto from 'node:crypto';
import type { IService, ServiceHealth, IPCMessage, DecodedMessage } from '@devbridge/shared';
import type { CommandResult, BroadcastResult } from '@devbridge/shared';

// ── Back-pressure constants ──────────────────────────────────────────────────

const QUEUE_MAX_PER_DEVICE       = 32;
const DEFAULT_COMMAND_TIMEOUT    = 5000;  // ms
const BROADCAST_PER_DEVICE_TIMEOUT = 100; // ms

// ── Module-level IPC senders ─────────────────────────────────────────────────
// Upstream   = toward GatewayService  (COMMAND_RESULT, BROADCAST_RESULT)
// Downstream = toward DeviceManager   (COMMAND_SEND, SUBSCRIBE_EVENTS)

let _upstreamSend:   ((msg: Partial<IPCMessage>) => void) | null = null;
let _downstreamSend: ((msg: Partial<IPCMessage>) => void) | null = null;

export function setUpstreamSend(fn: (msg: Partial<IPCMessage>) => void): void {
  _upstreamSend = fn;
}

export function setDownstreamSend(fn: (msg: Partial<IPCMessage>) => void): void {
  _downstreamSend = fn;
}

// ── Internal types ───────────────────────────────────────────────────────────

interface PendingCommand {
  correlationId: string;
  resolve:       (result: CommandResult) => void;
  reject:        (err: Error & { errorCode?: string }) => void;
  timer:         ReturnType<typeof setTimeout>;
  startAt:       number;
}

// ── CommandDispatcher ────────────────────────────────────────────────────────

export class CommandDispatcher implements IService {
  /** Per-device command queues (back-pressure guard) */
  private queues = new Map<string, PendingCommand[]>();

  /**
   * Configure IPC channels.
   * Also updates the module-level senders used by this instance.
   */
  configureIPC(
    upstream:   (msg: Partial<IPCMessage>) => void,
    downstream: (msg: Partial<IPCMessage>) => void,
  ): void {
    setUpstreamSend(upstream);
    setDownstreamSend(downstream);
  }

  // ── IService lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    // passive - responds to IPC messages; no active loops to start
  }

  async stop(): Promise<void> {
    for (const [, queue] of this.queues) {
      for (const pending of queue) {
        clearTimeout(pending.timer);
        pending.reject(
          Object.assign(new Error('COMMAND_DISPATCH_FAILED: service stopping'), {
            errorCode: 'COMMAND_DISPATCH_FAILED',
          }),
        );
      }
    }
    this.queues.clear();
  }

  async health(): Promise<ServiceHealth> {
    return {
      status:  'ok',
      details: { pendingQueues: this.queues.size },
    };
  }

  // ── IPC message router ─────────────────────────────────────────────────────

  handleIPCMessage(msg: Partial<IPCMessage>): void {
    const payload = msg.payload as Record<string, unknown>;
    switch (msg.type) {
      case 'COMMAND_SEND':
        this._handleDispatch(payload).catch(() => {});
        break;
      case 'COMMAND_BROADCAST':
        this._handleBroadcast(payload).catch(() => {});
        break;
      case 'DATA_RECEIVED':
        this._resolveCommand(payload);
        break;
      case 'SUBSCRIBE_EVENTS':
        this._forwardSubscribe(payload);
        break;
    }
  }

  // ── Private: dispatch a single command ────────────────────────────────────

  /**
   * Entry point for COMMAND_SEND IPC messages.
   * Enqueues the command and sends COMMAND_RESULT to upstream when settled.
   */
  private async _handleDispatch(payload: Record<string, unknown>): Promise<void> {
    const { deviceId, commandId, params, correlationId, timeoutMs } = payload as {
      deviceId:      string;
      commandId:     string;
      params:        Record<string, unknown>;
      correlationId: string;
      timeoutMs?:    number;
    };

    try {
      const result = await this._enqueue({
        deviceId, commandId, params, correlationId, timeoutMs,
      });
      _upstreamSend?.({ type: 'COMMAND_RESULT', payload: result });
    } catch (err) {
      const e = err as Error & { errorCode?: string };
      this._replyError(deviceId, correlationId, e.errorCode ?? 'COMMAND_DISPATCH_FAILED', e.message);
    }
  }

  /**
   * Core enqueue logic.  Returns a Promise<CommandResult> that resolves when
   * DATA_RECEIVED arrives, or rejects on timeout / queue-full.
   *
   * Also forwards COMMAND_SEND to the DeviceManager downstream.
   */
  private _enqueue(opts: {
    deviceId:      string;
    commandId:     string;
    params:        Record<string, unknown>;
    correlationId: string;
    timeoutMs?:    number;
  }): Promise<CommandResult> {
    const { deviceId, correlationId } = opts;

    // Back-pressure check
    const queue = this.queues.get(deviceId) ?? [];
    if (queue.length >= QUEUE_MAX_PER_DEVICE) {
      return Promise.reject(
        Object.assign(
          new Error(`Device ${deviceId} command queue is full`),
          { errorCode: 'COMMAND_QUEUE_FULL' },
        ),
      );
    }

    const timeout = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT;
    const startAt = Date.now();

    const promise = new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this._removePending(deviceId, correlationId);
        reject(
          Object.assign(new Error(`COMMAND_TIMEOUT: ${correlationId}`), {
            errorCode: 'COMMAND_TIMEOUT',
            correlationId,
          }),
        );
      }, timeout);

      queue.push({ correlationId, resolve, reject, timer, startAt });
      this.queues.set(deviceId, queue);
    });

    // Forward to DeviceManager
    _downstreamSend?.({ type: 'COMMAND_SEND', payload: opts });

    return promise;
  }

  // ── Private: broadcast ────────────────────────────────────────────────────

  private async _handleBroadcast(payload: Record<string, unknown>): Promise<void> {
    const { deviceIds, commandId, params, correlationId } = payload as {
      deviceIds:     string[];
      commandId:     string;
      params:        Record<string, unknown>;
      correlationId: string;
    };

    const startAt = Date.now();

    const settled = await Promise.allSettled(
      deviceIds.map(deviceId =>
        this._enqueue({
          deviceId,
          commandId,
          params,
          correlationId: `broadcast-${crypto.randomUUID()}`,
          timeoutMs:     BROADCAST_PER_DEVICE_TIMEOUT,
        }),
      ),
    );

    const results = settled.map((s, i) => ({
      deviceId: deviceIds[i] as string,
      success:  s.status === 'fulfilled',
      data:     s.status === 'fulfilled' ? s.value.data : undefined,
      errorCode:
        s.status === 'rejected'
          ? (s.reason as Error & { errorCode?: string }).errorCode
          : undefined,
    }));

    const broadcast: BroadcastResult = {
      correlationId: correlationId as string,
      results,
      succeededCount: results.filter(r => r.success).length,
      failedCount:    results.filter(r => !r.success).length,
      totalMs:        Date.now() - startAt,
    };

    _upstreamSend?.({ type: 'BROADCAST_RESULT', payload: broadcast });
  }

  // ── Private: resolve / remove pending ─────────────────────────────────────

  private _resolveCommand(payload: Record<string, unknown>): void {
    const { deviceId, correlationId, message, rawBuffer } = payload as {
      deviceId:      string;
      correlationId: string;
      message:       DecodedMessage;
      rawBuffer:     Buffer;
    };

    const queue = this.queues.get(deviceId);
    if (!queue) return;

    const idx = queue.findIndex(p => p.correlationId === correlationId);
    if (idx === -1) return;

    const [pending] = queue.splice(idx, 1) as [PendingCommand];
    clearTimeout(pending.timer);

    pending.resolve({
      deviceId,
      correlationId,
      success:   true,
      data:      message.fields,
      rawBuffer,
      durationMs: Date.now() - pending.startAt,
    });
  }

  private _removePending(deviceId: string, correlationId: string): void {
    const queue = this.queues.get(deviceId);
    if (!queue) return;
    const idx = queue.findIndex(p => p.correlationId === correlationId);
    if (idx !== -1) queue.splice(idx, 1);
  }

  private _replyError(deviceId: string, correlationId: string, code: string, msg: string): void {
    _upstreamSend?.({
      type: 'COMMAND_RESULT',
      payload: {
        deviceId,
        correlationId,
        success:      false,
        errorCode:    code,
        errorMessage: msg,
        durationMs:   0,
      } satisfies CommandResult,
    });
  }

  private _forwardSubscribe(payload: unknown): void {
    _downstreamSend?.({ type: 'SUBSCRIBE_EVENTS', payload });
  }
}
