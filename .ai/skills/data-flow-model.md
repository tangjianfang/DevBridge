# Skill: Data Flow Model — 双通道数据流模型

## Preconditions

当以下情况发生时激活本 skill：
- 用户设计或实现设备数据收发方向性逻辑
- 涉及 Command Channel 与 Event Channel 的区分
- 用户实现 correlationId 请求-响应匹配
- 用户设计 WebSocket 前后端消息格式
- 用户实现 EventBus / 事件总线
- 涉及 HID Report ID 路由或 BLE Characteristic UUID 路由

---

## Instructions

### 双通道模型定义

每个 `DeviceChannel` 维护两个完全独立的数据通道：

```
┌─────────────────────────────────────────────────────────┐
│                     DeviceChannel                       │
│                                                         │
│  Command Channel (请求-响应模式)                         │
│  App → encode() → transport.send() ─────────────────►  │
│                ◄─ transport.onData() → decode() → App   │
│                        ↑ correlationId 匹配              │
│                                                         │
│  Event Channel (被动监听模式)                            │
│  transport.onEvent() → decode() → EventBus.emit() ────► │
│                                           WebSocket     │
└─────────────────────────────────────────────────────────┘
```

**关键区别：**

| 维度 | Command Channel | Event Channel |
|------|----------------|---------------|
| 触发方 | 应用层主动发起 | 设备主动上报 |
| 模式 | 请求-响应（有 correlationId）| 持续流（无需请求）|
| 超时 | 有（默认 5000ms）| 无 |
| 阻塞 | 可 await | 必须异步，不能阻塞 |
| HID 来源 | Output/Feature Report | Input Report（IN Endpoint）|
| BLE 来源 | Write Characteristic | Notification/Indication |
| Serial 来源 | send() 后等待响应帧 | 设备主动发送的帧 |

### DeviceEvent — 统一输出格式

```typescript
interface DeviceEvent {
  deviceId: string;
  channel: 'command' | 'event';
  messageType: string;              // Protocol Schema 中定义的消息名
  data: Record<string, unknown>;    // 解码后的结构化数据
  rawBuffer: Buffer;                // 原始二进制（用于调试）
  timestamp: bigint;                // process.hrtime.bigint()
  // 可选扩展字段
  correlationId?: string;           // Command Channel 响应匹配
  characteristicUUID?: string;      // BLE：来源 Characteristic
  reportId?: number;                // HID：Report ID
  sequenceNumber?: number;          // 序列号（如协议支持）
}
```

### Command Channel 完整流程

```typescript
class DeviceChannel {
  // 待响应的命令 Map: correlationId → { resolve, reject, timer }
  private pendingCommands = new Map<string, PendingCommand>();
  private readonly COMMAND_TIMEOUT = 5000;

  async sendCommand(
    command: string,
    params: Record<string, unknown> = {}
  ): Promise<DeviceEvent> {
    const correlationId = crypto.randomUUID();
    const buffer = this.protocol.encode({ command, params, correlationId });

    return new Promise((resolve, reject) => {
      // 注册等待
      const timer = setTimeout(() => {
        this.pendingCommands.delete(correlationId);
        reject(new Error(`COMMAND_TIMEOUT: ${command}@${this.deviceId}`));
      }, this.COMMAND_TIMEOUT);

      this.pendingCommands.set(correlationId, { resolve, reject, timer });

      // 发送
      this.transport.send(buffer).catch((err) => {
        clearTimeout(timer);
        this.pendingCommands.delete(correlationId);
        reject(err);
      });
    });
  }

  // transport.onData() 最终调用此方法
  private handleIncoming(buffer: Buffer): void {
    const message = this.protocol.decode(buffer);

    // 尝试匹配 Command Channel 响应
    if (message.correlationId && this.pendingCommands.has(message.correlationId)) {
      const pending = this.pendingCommands.get(message.correlationId)!;
      clearTimeout(pending.timer);
      this.pendingCommands.delete(message.correlationId);
      pending.resolve(this.toDeviceEvent(message, 'command'));
      return;
    }

    // 否则视为 Event Channel 数据
    const event = this.toDeviceEvent(message, 'event');
    eventBus.emit('device:event', event);
  }
}
```

### 区分数据来源（当设备无 correlationId）

对于不支持 correlationId 的简单协议，由 Protocol Layer 根据帧内容判断通道归属：

```json
// protocol.schema.json 中声明
{
  "channelRouting": {
    "byReportId": {
      "0x01": "command",
      "0x02": "event",
      "0x03": "event"
    },
    "byFieldValue": {
      "field": "frameType",
      "mapping": {
        "0x01": "command",
        "0x02": "event"
      }
    }
  }
}
```

### EventBus — 事件总线

```typescript
// 全局事件总线（进程内）
const eventBus = new EventEmitter();
eventBus.setMaxListeners(100); // 多设备场景

// 事件命名规范
// device:event    ← 所有设备的 Event Channel 数据
// device:status-changed  ← 设备状态变化
// device:attached / device:detached
// system:notification  ← 系统通知

// GatewayService 订阅所有事件并推送 WebSocket
eventBus.on('device:event', (event: DeviceEvent) => {
  gatewayService.broadcastToClients({
    type: 'device:event',
    payload: event,
    timestamp: Date.now()
  });
});
```

### 前端 WebSocket 消息格式

**服务器 → 前端：**
```typescript
interface ServerMessage<T = unknown> {
  type: string;        // 'device:event' | 'device:status-changed' | 'device:list' | ...
  payload: T;
  timestamp: number;   // Date.now()（毫秒，前端展示用）
}
```

**前端 → 服务器：**
```typescript
interface ClientMessage<T = unknown> {
  type: string;       // 'COMMAND_SEND' | 'SUBSCRIBE_DEVICE' | ...
  correlationId: string;
  payload: T;
}
```

### 前端 Zustand Store 设计

```typescript
interface DeviceStore {
  // 状态
  devices: Map<string, DeviceInfo>;
  events: Map<string, DeviceEvent[]>; // deviceId → 最近 100 条事件

  // 操作
  updateDevice: (info: DeviceInfo) => void;
  appendEvent: (event: DeviceEvent) => void;
  sendCommand: (deviceId: string, command: string, params?: unknown) => Promise<DeviceEvent>;
}
```

---

## Constraints

- Command Channel 的响应匹配必须使用 correlationId / messageType 匹配，**禁止**依赖时序（避免竞态）
- Event Channel 数据接收**必须**是异步非阻塞模式，EventEmitter 的监听器不能有 `await` 阻塞
- 对于同一设备高频 Event 上报（如传感器 1kHz），必须有限流（`throttle`）保护 WebSocket 推送
- 前端 WebSocket 断线重连时，必须重新请求完整设备列表快照（`GET /api/v1/devices`），不能假设状态连续
- `rawBuffer` 字段在生产环境日志中默认 mask 掉（只保留 hex 摘要），保护敏感数据
- **禁止**在 EventBus 监听器中抛出未捕获异常（会导致 EventEmitter 崩溃）

---

## Examples

### 完整数据流时序（命令 + 事件并行）

```
t=0ms:    前端 → WS: { type: 'COMMAND_SEND', correlationId: 'abc', payload: { command: 'GET_STATUS' } }
t=0ms:    GatewayService → CommandDispatcher.dispatch('device-1', 'GET_STATUS', 'abc')
t=0.5ms:  Protocol.encode() → Buffer [AA 55 02 01 00 03]
t=0.5ms:  Transport.send(buffer)

[同时，设备主动在 t=1ms 上报状态消息（Event Channel）]
t=1ms:    Transport.onEvent(incomingBuffer)
t=1ms:    Protocol.decode() → { messageType: 'BUTTON_PRESSED', data: { key: 3 } }
t=1ms:    → eventBus.emit('device:event', DeviceEvent{channel: 'event', messageType: 'BUTTON_PRESSED'})
t=1ms:    → WS: { type: 'device:event', payload: {...} }  [前端收到按键事件]

t=2ms:    设备回复命令响应
t=2ms:    Transport.onData(responseBuffer)
t=2ms:    Protocol.decode() → { correlationId: 'abc', messageType: 'GET_STATUS_RESPONSE', data: {...} }
t=2ms:    → pendingCommands.get('abc').resolve(event)   [命令 Promise resolve]
t=2ms:    → WS: { type: 'COMMAND_RESPONSE', correlationId: 'abc', payload: {...} }
```
