// packages/server/src/device-manager/reconnect-controller.ts
// Exponential back-off reconnection controller.

export interface ReconnectOptions {
  maxAttempts:  number;   // default: 10
  initialDelay: number;   // ms, default: 1000
  multiplier:   number;   // default: 1.5
  maxDelay:     number;   // ms, default: 30000
  jitter:       boolean;  // ±20%, default: true
}

const DEFAULT_OPTIONS: Readonly<ReconnectOptions> = {
  maxAttempts:  10,
  initialDelay: 1000,
  multiplier:   1.5,
  maxDelay:     30000,
  jitter:       true,
};

/** Minimal interface needed by ReconnectController — avoids circular deps. */
export interface Reconnectable {
  connect(): Promise<void>;
  markRemoved(): void;
  markReconnecting(attempt: number, nextRetryMs: number, reason?: string): void;
}

export class ReconnectController {
  private attempt   = 0;
  private timer?:   ReturnType<typeof setTimeout>;
  private cancelled = false;
  private readonly opts: ReconnectOptions;

  constructor(
    private readonly channel: Reconnectable,
    opts: Partial<ReconnectOptions> = {},
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  scheduleRetry(reason?: string): void {
    if (this.cancelled) return;
    const { maxAttempts, initialDelay, multiplier, maxDelay, jitter } = this.opts;

    if (this.attempt >= maxAttempts) {
      this.channel.markRemoved();
      return;
    }

    // delay = min(initialDelay * multiplier^attempt, maxDelay) ± 20% jitter
    let delay = Math.min(initialDelay * Math.pow(multiplier, this.attempt), maxDelay);
    if (jitter) delay *= 0.8 + Math.random() * 0.4;
    delay = Math.round(delay);

    this.channel.markReconnecting(this.attempt + 1, delay, reason);

    this.timer = setTimeout(async () => {
      if (this.cancelled) return;
      this.attempt++;
      await this.channel.connect();
    }, delay);
  }

  cancel(): void {
    this.cancelled = true;
    if (this.timer) clearTimeout(this.timer);
  }

  resetAttempts(): void {
    this.attempt = 0;
  }

  get currentAttempt(): number {
    return this.attempt;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }
}
