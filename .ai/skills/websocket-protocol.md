# Skill: WebSocket Protocol — WebSocket 分帧通信协议

## Preconditions

当以下情况发生时激活本 skill：
- 用户实现或修改 GatewayService 的 WebSocket 消息收发逻辑
- 用户实现前端 WebSocket 客户端（hooks/use-ws.ts 或类似文件）
- 用户涉及 `rawBuffer`、Binary Frame、ArrayBuffer、Hex Dump 相关功能
- 用户讨论 DevTools PacketTap 的实时数据推送
- 代码涉及 `ws.binaryType`、`MessageEvent`、二进制消息路由

---

## Instructions

### 双 Frame 类型分帧策略

同一 WebSocket 连接承载两类消息，通过 frame type 区分，**不能混合**：

| Frame 类型 | 编码 | 承载内容 | 触发条件 |
|-----------|------|---------|---------|
| **Text Frame** | UTF-8 JSON | 控制消息、设备状态、命令响应（不含 rawBuffer）| 所有 JSON 结构化消息 |
| **Binary Frame** | ArrayBuffer | `rawBuffer` 原始字节数据 | DevTools 已开启 PacketTap 时触发 |

> 两类 frame 复用同一 WebSocket 连接，无需建立独立连接。当 PacketTap 未开启时，服务端**不发送**任何 Binary Frame，零性能开销。

---

### Text Frame 消息结构（JSON）

所有控制类消息使用 Text Frame，统一信封格式：

```typescript
// 服务端 → 前端（推送）
interface WsServerMessage {
  type: string;              // 事件类型，'device:event' | 'device:status' | 'notification' | ...
  payload: unknown;          // 业务数据，类型由 type 决定
  timestamp: string;         // ISO 8601，仅用于显示（高精度用 DeviceEvent.timestamp）
}

// 前端 → 服务端（命令）
interface WsClientMessage {
  type: string;              // 'device:command' | 'packettap:subscribe' | 'packettap:unsubscribe' | ...
  correlationId: string;     // UUID v4，用于追踪响应
  payload: unknown;
}
```

**标准 `type` 值列表：**

| type | 方向 | payload 类型 | 说明 |
|------|------|------------|------|
| `device:event` | S→C | `Omit<DeviceEvent, 'rawBuffer'>` | 设备数据事件（rawBuffer 通过 Binary Frame 独立发送）|
| `device:status` | S→C | `DeviceInfo` | 设备状态变更（连接/断开/重连中）|
| `notification` | S→C | `NotificationPayload` | 异常通知（info/warning/error/critical）|
| `device:command` | C→S | `{ deviceId, commandId, params, correlationId }` | 发送命令 |
| `device:response` | S→C | `{ correlationId, result, error? }` | 命令响应 |
| `packettap:subscribe` | C→S | `{ channel: 'packet-tap', deviceId }` | 订阅 PacketTap Binary Frame |
| `packettap:unsubscribe` | C→S | `{ channel: 'packet-tap', deviceId }` | 取消 PacketTap 订阅 |
| `metrics:update` | S→C | `MetricsSnapshot` | 性能指标推送（5s 间隔）|
| `diagnostics:result` | S→C | `DiagnosticReport` | 诊断结果 |

---

### Binary Frame 结构（ArrayBuffer）

Binary Frame 仅用于传输 `rawBuffer`，格式为固定头部 + 原始字节：

```
┌─────────────────────────────────────────────────────┐
│  Header（32 bytes 固定长度）                          │
│  ┌─────────────┬──────────┬──────────┬────────────┐  │
│  │ magic[4]    │ ver[1]   │ type[1]  │ pad[2]     │  │
│  │ 0x44 0x42   │ 0x01     │ 0x01=raw │ 0x00 0x00  │  │
│  │ 0x52 0x47   │          │          │            │  │
│  ├─────────────┴──────────┴──────────┴────────────┤  │
│  │ deviceId[16]  (UTF-8, 右侧 0x00 填充)           │  │
│  ├────────────────────────────────────────────────┤  │
│  │ timestamp[8]  (BigInt64BE, process.hrtime NS)  │  │
│  └────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────┤
│  Payload（变长）                                      │
│  rawBuffer 原始字节，无任何编码                        │
└─────────────────────────────────────────────────────┘
```

**服务端编码（TypeScript）：**

```typescript
function encodeBinaryFrame(deviceId: string, timestamp: bigint, rawBuffer: Buffer): Buffer {
  const header = Buffer.alloc(32);
  // magic
  header.write('DBRG', 0, 'ascii');
  // version
  header[4] = 0x01;
  // type: raw buffer
  header[5] = 0x01;
  // deviceId (max 16 bytes, zero-padded)
  const idBytes = Buffer.from(deviceId.slice(0, 16).padEnd(16, '\0'), 'utf8');
  idBytes.copy(header, 8);
  // timestamp (BigInt64BE)
  header.writeBigInt64BE(timestamp, 24);

  return Buffer.concat([header, rawBuffer]);
}
```

**前端解码（TypeScript）：**

```typescript
// 前端 WebSocket 初始化
const ws = new WebSocket('ws://localhost:3000/ws');
ws.binaryType = 'arraybuffer';  // 必须设置，否则收到 Blob

ws.onmessage = (event: MessageEvent) => {
  if (typeof event.data === 'string') {
    // Text Frame → JSON 控制消息
    const msg = JSON.parse(event.data) as WsServerMessage;
    handleTextMessage(msg);
  } else {
    // Binary Frame → rawBuffer
    const frame = event.data as ArrayBuffer;
    const view = new DataView(frame);

    // 校验 magic bytes: 'DBRG'
    const magic = String.fromCharCode(
      view.getUint8(0), view.getUint8(1),
      view.getUint8(2), view.getUint8(3)
    );
    if (magic !== 'DBRG') return;

    // 解析 deviceId（16 bytes UTF-8 at offset 8）
    const idBytes = new Uint8Array(frame, 8, 16);
    const deviceId = new TextDecoder().decode(idBytes).replace(/\0+$/, '');

    // 解析 timestamp（BigInt64BE at offset 24）
    const timestamp = view.getBigInt64(24, false);

    // payload = 剩余字节
    const payload = new Uint8Array(frame, 32);

    handleBinaryFrame({ deviceId, timestamp, payload });
  }
};
```

---

### 前端 DevTools 与 Binary Frame 的关联

PacketTap 订阅/取消订阅通过 Text Frame 控制：

```typescript
// 前端：开启某设备的 PacketTap
ws.send(JSON.stringify({
  type: 'packettap:subscribe',
  correlationId: crypto.randomUUID(),
  payload: { channel: 'packet-tap', deviceId: 'usb-hid:001' }
}));

// 服务端收到后：PacketTap 开始向该 WS 连接推送 Binary Frame
// 前端收到 Binary Frame → DevTools Hex Dump 组件渲染

// 前端：关闭 PacketTap
ws.send(JSON.stringify({
  type: 'packettap:unsubscribe',
  correlationId: crypto.randomUUID(),
  payload: { channel: 'packet-tap', deviceId: 'usb-hid:001' }
}));
```

---

### 高频事件节流（防止 React 重渲染风暴）

BLE 传感器可能以 100Hz 推送数据，前端需节流：

```typescript
// 前端 Zustand Store 中的批量更新策略
import { create } from 'zustand';

const BATCH_INTERVAL_MS = 16; // ~60fps

let pendingEvents: DeviceEventPayload[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleFlush(set: (fn: (s: Store) => Store) => void) {
  if (batchTimer) return;
  batchTimer = setTimeout(() => {
    const events = pendingEvents.splice(0);
    batchTimer = null;
    if (events.length === 0) return;
    set(state => ({ ...state, eventBuffer: [...state.eventBuffer, ...events].slice(-200) }));
  }, BATCH_INTERVAL_MS);
}

// 使用示例：ws message handler 调用
function onDeviceEvent(event: DeviceEventPayload) {
  pendingEvents.push(event);
  scheduleFlush(useDeviceStore.setState);
}
```

---

## Constraints

- **禁止** 将 `rawBuffer` Base64 编码后作为 JSON 字段发送（+33% 传输开销，破坏分帧规范）
- **禁止** 在 DevTools 未订阅时发送任何 Binary Frame（PacketTap 关闭 = 零开销）
- **必须** 在前端 WebSocket 初始化时设置 `ws.binaryType = 'arraybuffer'`，否则收到 `Blob` 无法直接操作
- **禁止** 在 Text Frame JSON 的 `device:event` 消息中包含 `rawBuffer` 字段（即使置为 `null`）
- Binary Frame **必须** 使用固定 32 字节 header，前端路由逻辑依赖 header 中的 `deviceId`
- 高频设备事件（> 30fps）**必须** 在前端 Store 层做批量合并，不得每条消息触发一次 React 渲染

---

## Examples

### 完整 DevTools 抓包会话

```
1. 用户在 DevTools 面板点击"开始抓包"（deviceId: 'serial:COM3'）
2. 前端 → Text Frame: { type: 'packettap:subscribe', payload: { channel: 'packet-tap', deviceId: 'serial:COM3' } }
3. 服务端 GatewayService 注册该 WS 连接为 COM3 的 PacketTap 订阅者
4. 设备发来串口数据 [AA 55 04 01 00 00 03]
5. Transport.onData() → PacketTap.tap(buffer) → 服务端编码 Binary Frame
6. 服务端 → Binary Frame: [DBRG header(32)] + [AA 55 04 01 00 00 03]
7. 前端 onmessage → 识别 Binary Frame → 解析 header 获取 deviceId='serial:COM3'
8. DevTools Hex Dump 组件收到 Uint8Array → 渲染彩色字段标注
9. 用户点击"停止抓包"
10. 前端 → Text Frame: { type: 'packettap:unsubscribe', payload: { channel: 'packet-tap', deviceId: 'serial:COM3' } }
11. 服务端移除订阅 → 停止发送 Binary Frame
```

### 正常设备事件推送（无 rawBuffer）

```typescript
// 服务端推送 device:event（Text Frame）
const msg: WsServerMessage = {
  type: 'device:event',
  payload: {
    deviceId: 'usb-hid:VID001_PID002',
    channel: 'event',
    messageType: 'SCAN_DATA',
    data: { barcode: '6901234567890', symbology: 'EAN-13' },
    // rawBuffer 不在 JSON 中！通过 Binary Frame 独立发送（仅 DevTools 订阅时）
    timestamp: '1740700800000000000'  // BigInt 转 string 供 JSON 序列化
  },
  timestamp: new Date().toISOString()
};
ws.send(JSON.stringify(msg)); // Text Frame
```
