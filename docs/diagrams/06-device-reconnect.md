# 设备断开与自动重连流程

> 设备意外断开后的状态机流转与指数退避重连策略。

```mermaid
flowchart TD
    A([设备意外断开\n或拔出]) --> B{断开类型?}
    B -- 物理拔出 detach --> C[状态机: → detached]
    B -- 通信超时/错误 --> D[状态机: connected → disconnected]
    C --> E[DeviceChannel.destroy\nTransport.disconnect\nEndpoint 停止轮询]
    E --> F[从 deviceList 移除]
    F --> T1[NotificationManager\nwarning: 设备断开]
    D --> G{ReconnectConfig\nmaxRetries != 0?}
    G -- 否，不重连 --> H[状态机: → error]
    H --> T2[NotificationManager\nerror: 设备离线]
    G -- 是 --> I[状态机: → reconnecting]
    I --> J[等待 retryInterval ms\n初始 1000ms]
    J --> K[Transport.connect 重试]
    K --> L{重连成功?}
    L -- 是 --> M[状态机: → connected]
    M --> N[恢复所有配置\nBLE重订阅 / Protocol重绑定]
    N --> O[NotificationManager\ninfo: 设备已恢复]
    L -- 否 --> P[retryCount++]
    P --> Q{超出 maxRetries?}
    Q -- 否 --> R[retryInterval × backoffMultiplier\n上限 maxRetryInterval 30s]
    R --> J
    Q -- 是 --> S[状态机: → error]
    S --> T3[NotificationManager\nerror: 重连耗尽]
    T3 --> U[Sentry 上报]

    style A fill:#FF9800,color:#fff
    style M fill:#4CAF50,color:#fff
    style S fill:#f44336,color:#fff
    style H fill:#f44336,color:#fff
```

## 重连配置（ReconnectConfig）

```typescript
interface ReconnectConfig {
  maxRetries: number;        // -1 = 无限重连，0 = 不重连，默认 5
  retryInterval: number;     // 初始间隔 ms，默认 1000
  backoffMultiplier: number; // 指数退避倍数，默认 2
  maxRetryInterval: number;  // 最大间隔，默认 30000ms
  reconnectOn: ('detach' | 'disconnect' | 'error')[];
}
```

## 指数退避示例

| 第 N 次重试 | 等待时间 |
|------------|---------|
| 1 | 1s |
| 2 | 2s |
| 3 | 4s |
| 4 | 8s |
| 5 | 16s |
| 6+ | 30s（上限）|

## 重连成功后的恢复

- 保留设备所有配置（Protocol Schema、BLE 订阅列表、Report ID 路由）
- BLE 重连后重新执行 GATT 服务发现和 Characteristic 订阅
- 通信历史记录保留（连续性，不清空）
