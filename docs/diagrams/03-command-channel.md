# 命令发送流程（Command Channel — 请求响应）

> 前端发送命令到设备，等待响应的完整链路。  
> **SLA 目标：单设备 < 1ms 发送延迟，本地 RTT < 10ms**

```mermaid
sequenceDiagram
    participant FE as Frontend
    participant GW as GatewayService
    participant CD as CommandDispatcher Worker
    participant DM as DeviceManager Worker
    participant DC as DeviceChannel
    participant PT as PacketTap (可选)
    participant PR as Protocol
    participant TR as Transport
    participant DEV as 物理设备

    FE->>GW: Text Frame {type: COMMAND_SEND, deviceId, command: GET_STATUS, correlationId}
    GW->>CD: IPC COMMAND_SEND (correlationId, deviceId, command)
    CD->>CD: 优先级队列入队
    CD->>DM: IPC COMMAND_SEND (correlationId, deviceId, command)
    DM->>DC: sendCommand(GET_STATUS, {})
    DC->>PR: encode({command: GET_STATUS})
    PR-->>DC: Buffer [AA 55 02 01 00 03]
    DC->>PT: tap(buffer, direction: send)
    PT-->>GW: Binary Frame (rawBuffer) — 仅 DevTools 订阅时
    DC->>TR: send(buffer)
    TR->>DEV: 物理字节发送
    Note over DC: 等待响应，超时 100ms
    DEV->>TR: 响应字节返回
    TR->>DC: onData(responseBuffer)
    DC->>PT: tap(responseBuffer, direction: recv)
    PT-->>GW: Binary Frame (rawBuffer) — 仅 DevTools 订阅时
    DC->>PR: decode(responseBuffer)
    PR-->>DC: {status: OK, battery: 85}
    DC-->>DM: commandResult (correlationId, data)
    DM-->>CD: IPC COMMAND_RESPONSE
    CD-->>GW: IPC COMMAND_RESPONSE (correlationId, result)
    GW-->>FE: Text Frame {type: COMMAND_RESPONSE, correlationId, result}
    Note over FE,DEV: 全链路 RTT < 10ms (本地模式)
```

## 超时降级策略

- 默认超时 **100ms**
- 超时后该设备命令返回 `{ status: 'timeout', deviceId }`，不阻塞其他设备
- `NotificationManager` 记录超时事件，超时率连续超阈值触发 `warning` 通知

## correlationId 追踪链路

```
Frontend correlationId (UUID v4)
  → GW IPC → CD IPC → DM IPC → DeviceChannel
  ← DM IPC ← CD IPC ← GW IPC ← DeviceChannel
```

全链路使用同一 `correlationId`，任意环节的日志均可通过它关联。
