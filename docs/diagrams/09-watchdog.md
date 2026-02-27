# Watchdog 进程守护与自愈流程

> Watchdog 与 DevBridge 主进程的守护关系、心跳检测及自动重启策略。

```mermaid
flowchart TD
    A([系统启动]) --> B{启动方式?}
    B -- 直接运行 node index.js --> C[无 Watchdog 保护\n仅开发模式]
    B -- watchdog.exe / watchdog ---> D[Watchdog 主进程启动\n监听 SIGTERM / SIGINT]
    D --> E[child_process.spawn\n启动 DevBridge 主进程]
    E --> F[建立双向 IPC Channel\nhttps://nodejs.org/api/child_process.html]
    F --> G[启动心跳定时器\n每 1s 发送 ping]
    G --> H{主进程响应 pong?}
    H -- 是，健康 --> G
    H -- 3次未响应 --> I[判断主进程无响应]
    I --> J[process.kill SIGTERM 优雅关闭]
    J --> K{进程退出码是否为 0?}
    K -- 是，正常退出 --> L[Watchdog 也退出]
    K -- 否，崩溃/超时 --> M[restartCount++]
    M --> N{超出 maxRestarts 5?}
    N -- 否 --> O[等待 restartDelay\n指数退避 1s/2s/4s/8s/16s]
    O --> E
    N -- 是 --> P[记录 permanently_failed\n不再重启]
    P --> Q[通知管理员\nSentry critical alert\nEmail + 日志]
    Q --> R[Watchdog 自身退出]

    style A fill:#607D8B,color:#fff
    style L fill:#4CAF50,color:#fff
    style P fill:#f44336,color:#fff
    style R fill:#f44336,color:#fff
```

## Watchdog 配置

```typescript
interface WatchdogConfig {
  heartbeatInterval: number;   // ms，默认 1000
  heartbeatTimeout: number;    // 连续无响应次数，默认 3
  maxRestarts: number;         // 最大重启次数，默认 5
  restartDelay: number;        // 初始重启延迟 ms，默认 1000
  backoffMultiplier: number;   // 默认 2 （指数退避）
  exitOnFail: boolean;         // permanently_failed 后 Watchdog 是否退出，默认 true
}
```

## 主进程心跳响应（DevBridge 侧）

```typescript
// 主进程监听 Watchdog 心跳
process.on('message', (msg) => {
  if (msg === 'ping') {
    process.send?.('pong');
  }
});
```

## 重启日志格式

```json
{
  "event": "process_restart",
  "restartCount": 2,
  "reason": "heartbeat_timeout",
  "pid": 12345,
  "exitCode": null,
  "signal": "SIGTERM",
  "nextRestartDelay": 4000,
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```
