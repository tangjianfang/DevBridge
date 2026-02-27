# 命令广播流程（多设备并行 — Promise.allSettled）

> 向所有已连接设备并行广播同一命令，超时设备独立降级，不阻塞其他设备。  
> **SLA 目标：≤ 10 台设备广播延迟 ≤ 5ms**

```mermaid
flowchart TD
    A([前端: 广播命令\n给所有设备]) --> B[GatewayService\n接收 COMMAND_SEND_BROADCAST]
    B --> C[CommandDispatcher\n获取所有 connected 设备列表]
    C --> D[Promise.allSettled\n并行向所有设备发送\n不等最慢设备]
    D --> E1[DeviceChannel-1\n发送命令]
    D --> E2[DeviceChannel-2\n发送命令]
    D --> E3[DeviceChannel-N\n发送命令]
    E1 --> F1{< 100ms?}
    E2 --> F2{< 100ms?}
    E3 --> F3{< 100ms?}
    F1 -- 成功 --> G1[result: success]
    F2 -- 超时 --> G2[result: timeout\n设备单独降级]
    F3 -- 成功 --> G3[result: success]
    G1 --> H[allSettled 汇总结果]
    G2 --> H
    G3 --> H
    H --> I{全部成功?}
    I -- 是 --> J[GatewayService\n返回 broadcastResult: all-ok]
    I -- 部分失败 --> K[GatewayService\n返回 broadcastResult: partial\n含失败设备列表]
    K --> L[NotificationManager\nwarning: 部分设备超时]
    J --> M[Frontend 更新设备状态]
    L --> M

    style A fill:#2196F3,color:#fff
    style J fill:#4CAF50,color:#fff
    style G2 fill:#FF9800,color:#fff
    style K fill:#FF9800,color:#fff
```

## 为什么用 Promise.allSettled 不用 Promise.all

| | `Promise.all` | `Promise.allSettled` ✅ |
|--|--------------|----------------------|
| 单设备失败 | 整体 reject，其他设备结果丢失 | 继续等待其他设备，收集所有结果 |
| 适用场景 | 全部必须成功 | 尽力而为，允许部分失败 |
| 广播场景 | ❌ 不适合 | ✅ 适合 |

## 热路径优化

```
广播路径全程禁止:
  × JSON.stringify/parse        → 用 Buffer 二进制
  × Date.now()                  → 用 process.hrtime.bigint()
  × Buffer.alloc() 动态分配     → Buffer Pool 预分配
  × console.log                 → pino ring buffer 异步写
```

## 广播结果格式

```typescript
interface BroadcastResult {
  total: number;
  succeeded: string[];   // deviceId 列表
  failed: Array<{
    deviceId: string;
    reason: 'timeout' | 'error';
    errorCode?: string;
  }>;
  elapsedNs: bigint;     // process.hrtime.bigint() 精度
}
```
