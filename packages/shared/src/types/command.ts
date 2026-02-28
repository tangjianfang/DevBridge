// packages/shared/src/types/command.ts

export interface CommandResult {
  deviceId:      string;
  correlationId: string;           // UUIDv4，由 GatewayService 在请求时生成
  success:       boolean;
  data?:         Record<string, unknown>;  // protocol.decode 后的 fields
  rawBuffer?:    Buffer;
  durationMs:    number;           // 从发送到响应的耗时
  errorCode?:    string;
  errorMessage?: string;
}

export interface BroadcastResult {
  correlationId: string;
  results: Array<{
    deviceId:   string;
    success:    boolean;
    data?:      Record<string, unknown>;
    errorCode?: string;
  }>;
  succeededCount: number;
  failedCount:    number;
  totalMs:        number;
}
