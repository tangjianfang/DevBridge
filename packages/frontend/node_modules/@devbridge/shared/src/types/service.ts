// packages/shared/src/types/service.ts

export type HealthStatus = 'healthy' | 'degraded' | 'critical';

export interface ServiceHealth {
  status:    HealthStatus;
  details?:  Record<string, unknown>;
}

export interface ServiceMetrics {
  uptime:       bigint;
  messageCount: number;
  errorCount:   number;
  [key: string]: unknown;
}

export interface IService {
  readonly serviceId: string;
  start():  Promise<void>;
  stop():   Promise<void>;
  health(): Promise<ServiceHealth>;
  metrics(): ServiceMetrics;
}
