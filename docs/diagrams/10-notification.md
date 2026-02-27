# 异常通知分发流程（4 级别）

> 运行时所有异常、告警、信息经 NotificationManager 统一路由，支持去重与多渠道输出。

```mermaid
flowchart TD
    A([系统各模块产生事件]) --> B[NotificationManager\n统一入口]
    B --> C{通知级别?}

    C -- "info (级别 1)" --> D[Toast 提示\nDuration: 3s\n自动消失]
    C -- "warning (级别 2)" --> E[Toast + 通知中心\nDuration: 8s]
    C -- "error (级别 3)" --> F[Toast + 通知中心\n+ Sentry 上报]
    C -- "critical (级别 4)" --> G[全局模态对话框\n+ Sentry critical\n+ 阻断操作]

    D --> H{30s 内\n相同事件再次触发?}
    E --> H
    F --> H
    G --> I[直接展示\n不做去重判断\n关键事件必显示]

    H -- 是，去重 --> J[DeduplicationCache 抑制\n仅更新计数器]
    H -- 否 --> K[推入 notificationStore\nZustand 状态]
    K --> L{渠道路由}
    L --> M[Frontend\nWebSocket Text Frame\nnoti:push JSON]
    L --> N[pino 日志写入\n含 correlationId]
    L --> O{是 error/critical?}
    O -- 是 --> P[Sentry.captureException\n附带设备上下文]
    O -- 否 --> Q[跳过 Sentry]

    M --> R[前端通知中心\n列表展示 + 角标]
    N --> S[日志文件\nLogs/app.log]
    P --> T[Sentry Dashboard\n告警邮件]

    style A fill:#FF9800,color:#fff
    style G fill:#f44336,color:#fff
    style I fill:#f44336,color:#fff
    style J fill:#9E9E9E,color:#fff
```

## 通知级别定义

| 级别 | 名称 | 时效 | Toast 时长 | Sentry | 场景示例 |
|------|------|------|-----------|--------|---------|
| 1 | `info` | 瞬时 | 3s | ❌ | 设备已连接、配置保存成功 |
| 2 | `warning` | 短暂 | 8s | ❌ | 设备响应超时、协议解析警告 |
| 3 | `error` | 持久 | 手动关闭 | ✅ | 设备连接失败、Schema 校验出错 |
| 4 | `critical` | 阻断 | 需确认 | ✅ critical | 进程崩溃、权限不足、磁盘满 |

## 去重策略（DeduplicationCache）

```typescript
interface DedupeKey {
  source: string;      // 模块名，如 "DeviceManager"
  eventCode: string;   // 事件码，如 "DEVICE_CONNECT_FAIL"
  deviceId?: string;   // 设备维度隔离去重
}

// 30s 内同一 key 最多触发 1 次通知
const DEDUPE_WINDOW_MS = 30_000;
```

## 通知事件格式（WebSocket Text Frame）

```json
{
  "event": "noti:push",
  "data": {
    "id": "noti_01HXYZ",
    "level": "warning",
    "title": "设备响应超时",
    "message": "Device:3f2a 在 100ms 内未响应，自动重连中...",
    "source": "CommandDispatcher",
    "correlationId": "req_abc123",
    "timestamp": "2025-01-01T00:00:00.000Z"
  }
}
```
