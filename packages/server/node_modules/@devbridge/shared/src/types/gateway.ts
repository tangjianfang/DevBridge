// packages/shared/src/types/gateway.ts

export interface CommandResult {
  deviceId:      string;
  correlationId: string;
  success:       boolean;
  data?:         Record<string, unknown>;
  rawBuffer?:    Buffer;
  durationMs:    number;
  errorCode?:    string;
  errorMessage?: string;
}

export interface BroadcastResult {
  correlationId:  string;
  results:        Array<{
    deviceId:    string;
    success:     boolean;
    data?:       Record<string, unknown>;
    errorCode?:  string;
  }>;
  succeededCount: number;
  failedCount:    number;
  totalMs:        number;
}

export interface GatewaySettings {
  mode:       'local' | 'lan';
  port:       number;
  apiKey?:    string;
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
