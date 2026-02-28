// packages/frontend/src/mw/ws/ws-event-bus.ts

import { EventEmitter } from 'eventemitter3';

/**
 * Global WS event bus — routes WebSocket messages to stores and hooks.
 * All events emitted here are consumed by Zustand stores and React hooks.
 */
export const wsEventBus = new EventEmitter();

// ─── High-frequency batch emit (≈60 fps) ─────────────────────────────────────

const BATCH_INTERVAL_MS = 16;

let pendingEvents: Array<{ type: string; payload: unknown }> = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Batch-emit an event; all events queued within one 16ms window are flushed
 * together to avoid excessive React re-renders.
 */
export function batchEmit(type: string, payload: unknown): void {
  pendingEvents.push({ type, payload });
  if (!batchTimer) {
    batchTimer = setTimeout(() => {
      const events = pendingEvents.splice(0);
      batchTimer = null;
      for (const ev of events) wsEventBus.emit(ev.type, ev.payload);
    }, BATCH_INTERVAL_MS);
  }
}

/** Flush all pending batch events immediately (useful in tests). */
export function flushBatchEmit(): void {
  if (batchTimer !== null) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  const events = pendingEvents.splice(0);
  for (const ev of events) wsEventBus.emit(ev.type, ev.payload);
}
