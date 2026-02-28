// packages/shared/src/types/gateway.ts
// Note: CommandResult and BroadcastResult are defined in command.ts

export interface GatewaySettings {
  mode:       'local' | 'lan';
  port:       number;
  apiKey?:    string;
  /** Absolute path to serve static frontend assets from (e.g. dist/public) */
  staticDir?: string;
  cors: {
    enabled:   boolean;
    origins:   string[];
  };
  rateLimit: {
    max:        number;
    timeWindow: string;
  };
}

export type NotificationSeverity = 'info' | 'warning' | 'error';

export interface Notification {
  id:        string;
  severity:  NotificationSeverity;
  message:   string;
  timestamp: number;
  details?:  unknown;
}

export interface MetricsSnapshot {
  timestamp:       number;
  connectedDevices: number;
  totalCommands:   number;
  errorRate:       number;
  avgLatencyMs:    number;
  memoryMB:        number;
  services:        Record<string, { status: string; messageCount: number }>;
}

export interface DiagnosticResult {
  id:         string;
  runAt:      number;
  durationMs: number;
  passed:     number;
  failed:     number;
  checks:     Array<{
    name:    string;
    status:  'pass' | 'fail' | 'warn';
    message?: string;
  }>;
}
