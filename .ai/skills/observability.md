# Skill: Observability — 可观测性（日志 / Sentry / Metrics / 通信历史）

## Preconditions

当以下情况发生时激活本 skill：
- 用户需要日志配置（pino、文件输出、日志轮转）
- 涉及 Sentry 错误上报集成（@sentry/node / @sentry/react）
- 用户讨论性能指标采集（Metrics、CPU/内存/延迟）
- 涉及设备通信历史记录（SQLite 存储、查询、导出）
- 涉及 Worker/Child Process 日志汇聚（IPC 日志转发）

---

## Instructions

### LogManager — 日志工厂与多流管道

```typescript
// packages/server/src/observability/logger.ts

import pino from 'pino';
import pinoPretty from 'pino-pretty';
import { pino as pinoRoll } from 'pino-roll';

// 全局根 Logger，其他模块通过 createLogger() 创建子 logger
const rootLogger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: ['password', 'token', 'apiKey'],  // 敏感字段掩码
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { pid: process.pid, service: 'DevBridge-server' },
  },
  pino.multistream([
    // 1. 控制台（仅开发模式）
    ...(process.env.NODE_ENV === 'development'
      ? [{ stream: pinoPretty({ colorize: true }), level: 'debug' }]
      : []),
    // 2. 滚动文件日志（生产）
    {
      stream: await pinoRoll({
        file: path.join(logsDir, 'server.log'),
        size: '20m',
        interval: '1d',
        limit: { count: 14 },  // 最多保留 14 个文件
        mkdir: true,
      }),
      level: 'info',
    },
    // 3. 错误单独文件
    {
      stream: await pinoRoll({
        file: path.join(logsDir, 'error.log'),
        size: '10m',
        limit: { count: 7 },
        mkdir: true,
      }),
      level: 'error',
    },
  ])
);

/** 创建模块子 logger（带 module 标签） */
export function createLogger(module: string): pino.Logger {
  return rootLogger.child({ module });
}

/** 创建设备专属 logger（日志同时写入设备独立文件） */
export async function createDeviceLogger(deviceId: string): Promise<pino.Logger> {
  const deviceStream = await pinoRoll({
    file: path.join(logsDir, 'devices', `${deviceId}.log`),
    size: '5m',
    limit: { count: 5 },
    mkdir: true,
  });
  return rootLogger.child({ deviceId }, {
    // 额外写入设备专属文件
    mixin: undefined,
  }).child({}, { stream: pino.multistream([{ stream: deviceStream, level: 'debug' }]) });
}
```

### Worker Thread / Child Process 日志汇聚

Worker 内部使用轻量级 IPC 转发日志，不在子进程中直接写文件：

```typescript
// packages/server/src/workers/log-bridge.ts

/** Worker 内的日志代理：通过 parentPort IPC 发送日志到主进程 */
export function createWorkerLogger(module: string) {
  return {
    debug: (obj: object, msg?: string) => sendLog('debug', module, obj, msg),
    info:  (obj: object, msg?: string) => sendLog('info',  module, obj, msg),
    warn:  (obj: object, msg?: string) => sendLog('warn',  module, obj, msg),
    error: (obj: object, msg?: string) => sendLog('error', module, obj, msg),
  };
}

function sendLog(level: string, module: string, obj: object, msg?: string): void {
  parentPort?.postMessage({
    type: 'log',
    payload: { level, module, ...obj, msg, time: Date.now() }
  } satisfies IPCMessage<LogPayload>);
}

// 主进程接收端
workerInstance.on('message', (msg: IPCMessage<unknown>) => {
  if (msg.type === 'log') {
    const { level, module, msg: message, ...rest } = msg.payload as LogPayload;
    rootLogger.child({ module, source: 'worker' })[level](rest, message);
  }
});
```

### Sentry 集成

```typescript
// packages/server/src/observability/sentry.ts

import * as Sentry from '@sentry/node';

export function initSentry(): void {
  if (!process.env.SENTRY_DSN) {
    logger.warn('SENTRY_DSN not configured, error reporting disabled');
    return;
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    release: process.env.APP_VERSION,
    environment: process.env.NODE_ENV,
    tracesSampleRate: 0.1,  // 10% 性能采样
    beforeSend(event) {
      // 附加当前已连接设备列表（脱敏）
      const devices = deviceManager.listDevices().map(d => ({
        id: d.id, transport: d.transport, status: d.status
      }));
      event.contexts = {
        ...event.contexts,
        devices: { connected: devices },
        system: environmentDiagnostics.getSummary(),
      };
      return event;
    },
    beforeSendTransaction(event) {
      if (process.env.NODE_ENV !== 'production') return null;
      return event;
    },
  });
}

/** 带设备上下文的错误上报 */
export function captureDeviceError(
  err: Error,
  deviceInfo: DeviceInfo,
  context?: Record<string, unknown>
): void {
  Sentry.withScope(scope => {
    scope.setTag('device.transport', deviceInfo.transport);
    scope.setTag('device.vendor', deviceInfo.vendorId);
    scope.setContext('device', { ...deviceInfo });
    if (context) scope.setContext('extra', context);
    Sentry.captureException(err);
  });
}
```

### MetricsCollector — 环形缓冲采样 + Prometheus 端点

```typescript
// packages/server/src/observability/metrics.ts

class MetricsCollector {
  // 各指标环形缓冲（固定 1000 采样点）
  private commandLatency = new RingBuffer<LatencySample>(1000);
  private broadcastLatency = new RingBuffer<LatencySample>(1000);
  private deviceConnects = new Counter('device_connect_total');
  private deviceDisconnects = new Counter('device_disconnect_total');
  private protocolErrors = new Counter('protocol_error_total');

  /** 记录命令往返延迟（纳秒级） */
  recordCommandLatency(deviceId: string, commandId: string, durationNs: bigint): void {
    this.commandLatency.push({ deviceId, commandId, durationNs, ts: Date.now() });
  }

  /** 记录广播延迟（必须 < 5ms = 5_000_000n ns） */
  recordBroadcastLatency(targetCount: number, durationNs: bigint): void {
    this.broadcastLatency.push({ targetCount, durationNs, ts: Date.now() });
    if (durationNs > 5_000_000n) {
      logger.warn({ durationMs: Number(durationNs) / 1e6, targetCount }, 'broadcast_sla_violated');
    }
  }

  /** 获取最近 N 分钟的 P50/P95/P99 延迟（ms） */
  getLatencyPercentiles(windowMs = 60_000): LatencyPercentiles {
    const cutoff = Date.now() - windowMs;
    const samples = this.commandLatency.toArray()
      .filter(s => s.ts >= cutoff)
      .map(s => Number(s.durationNs) / 1e6)
      .sort((a, b) => a - b);

    if (samples.length === 0) return { p50: 0, p95: 0, p99: 0, count: 0 };
    return {
      p50: percentile(samples, 0.50),
      p95: percentile(samples, 0.95),
      p99: percentile(samples, 0.99),
      count: samples.length,
    };
  }

  /** Prometheus exposition format */
  getPrometheusMetrics(): string {
    return [
      `# HELP DevBridge_device_connect_total Total device connects`,
      `# TYPE DevBridge_device_connect_total counter`,
      `DevBridge_device_connect_total ${this.deviceConnects.value}`,
      `# HELP DevBridge_broadcast_latency_ms Broadcast latency histogram`,
      ...this.buildHistogram('DevBridge_broadcast_latency_ms', this.broadcastLatency.toArray()),
    ].join('\n');
  }
}

export const metricsCollector = new MetricsCollector();
```

### CommunicationRecorder — 通信历史（可选 SQLite）

```typescript
// packages/server/src/observability/recorder.ts

class CommunicationRecorder {
  private db?: Database;
  private enabled = false;

  async init(dbPath: string): Promise<void> {
    this.db = new Database(dbPath, { verbose: undefined }); // 关闭 SQL 日志
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS comm_records (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         INTEGER NOT NULL,
        device_id  TEXT NOT NULL,
        direction  TEXT NOT NULL,  -- 'in' | 'out'
        raw_hex    TEXT,
        decoded    TEXT,           -- JSON
        command_id TEXT,
        error      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_device_ts ON comm_records(device_id, ts);
    `);
    this.enabled = true;
  }

  record(entry: CommRecord): void {
    if (!this.enabled || !this.db) return;
    setImmediate(() => {   // 异步写入，不阻塞通信热路径
      this.db!.prepare(`
        INSERT INTO comm_records (ts, device_id, direction, raw_hex, decoded, command_id, error)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.ts, entry.deviceId, entry.direction,
        entry.rawHex ?? null, entry.decoded ? JSON.stringify(entry.decoded) : null,
        entry.commandId ?? null, entry.error ?? null
      );
    });
  }

  query(filter: RecordFilter): CommRecord[] {
    const conditions: string[] = ['1=1'];
    const params: unknown[] = [];
    if (filter.deviceId)   { conditions.push('device_id = ?'); params.push(filter.deviceId); }
    if (filter.fromTs)     { conditions.push('ts >= ?'); params.push(filter.fromTs); }
    if (filter.toTs)       { conditions.push('ts <= ?'); params.push(filter.toTs); }
    if (filter.direction)  { conditions.push('direction = ?'); params.push(filter.direction); }
    return this.db!.prepare(
      `SELECT * FROM comm_records WHERE ${conditions.join(' AND ')} ORDER BY ts DESC LIMIT ?`
    ).all(...params, filter.limit ?? 100) as CommRecord[];
  }
}

export const communicationRecorder = new CommunicationRecorder();
```

---

## Constraints

- 所有模块**必须**通过 `createLogger(moduleName)` 创建子 logger，**禁止**直接使用 `console.log/warn/error`
- Worker Thread 和 Child Process **禁止**直接写文件日志，**必须**通过 IPC 消息转发给主进程汇聚
- Sentry **禁止**上传 raw hex 数据（可能含敏感协议内容），`beforeSend` 中严格过滤
- `CommunicationRecorder.record()` **必须**通过 `setImmediate()` 异步写入，**禁止**在通信热路径中同步写 SQLite
- Metrics 环形缓冲固定大小，**禁止**无限增长（内存泄漏风险）
- pino-roll 的 `interval` 参数使用 `'1d'` 而非 `'24h'`（API 差异），`limit.count` 保留 14 天文件
- `LOG_LEVEL` 环境变量**必须**支持 `trace | debug | info | warn | error | fatal`，生产默认 `info`

---

## Examples

### REST API 端点

```
GET  /api/v1/logs/recent?lines=200&level=warn
GET  /api/v1/logs/download?date=2025-01-15&type=server
GET  /api/v1/metrics/latency?window=300000
GET  /api/v1/metrics/prometheus       ← Prometheus scrape 端点
GET  /api/v1/records?deviceId=xxx&limit=50&direction=in
GET  /api/v1/records/export?deviceId=xxx&format=jsonl
DELETE /api/v1/records?deviceId=xxx&beforeTs=1700000000000
```
