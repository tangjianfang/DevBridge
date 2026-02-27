# Skill: Architecture Overview — 整体架构总览

## Preconditions

当以下情况发生时激活本 skill：
- 用户讨论整体系统架构、模块划分、分层设计
- 用户提问某功能属于哪个模块、两个模块如何交互
- 用户新增模块时需要确认其在架构中的位置
- 用户讨论前后端通信协议和数据格式
- 代码涉及 `packages/server/src/` 顶层目录组织

---

## Instructions

### 核心三层架构

DevBridge 采用严格的三层架构，各层职责完全独立：

**Layer 1 — Presentation Layer（展示层）**

浏览器端内部分为两个子层：

| 子层 | 目录 | 职责 | 禁止 |
|------|------|------|------|
| **MW（中间层）** | `client/src/mw/` | WsClient 连接管理、Zustand Store 状态机、CommandService 命令构建、PacketTap Binary Frame 解析 | ❌ 任何 JSX / DOM 操作 |
| **UI 层** | `client/src/ui/` | React 组件、页面路由、Hooks、Tailwind 主题 | ❌ 直接调用 `ws.send()` 或访问 WsClient |

- MW 层通过 Zustand Store 向上暴露状态和 actions，UI 层只读状态 + 调 action
- MW 层可独立单元测试（无需 DOM）
- 通过 WebSocket（实时数据）+ REST（CRUD 操作）与 Application Layer 通信
- 不直接访问任何设备 API

**Layer 2 — Application Layer（应用层）**
- Node.js 后台服务，核心服务模块列表：

  | 服务模块 | 线程模型 | 文件路径 | 职责 |
  |---------|---------|---------|------|
  | `GatewayService` | **主线程** | `server/src/gateway/` | HTTP/WebSocket 网关，独占主线程保证 I/O 响应 |
  | `Watchdog` | **主线程** | `server/src/watchdog/` | 进程守护，与 GatewayService 同线程 |
  | `DeviceManager` | **Worker Thread** | `server/src/device-manager/` | 设备生命周期；**持有所有 `DeviceChannel` 实例** |
  | `CommandDispatcher` | **Worker Thread** | `server/src/command/` | 命令路由与广播；通过 IPC 驱动 DeviceManager |
  | `ProtocolEngine` | **Worker Thread** | `server/src/protocol/` | Protocol DSL 运行时 |
  | `ObservabilityService` | **Worker Thread** | `server/src/observability/` | 日志/Sentry/Metrics |
  | `PluginLoader` | **Worker Thread** | `server/src/plugins/` | 插件动态加载 |
  | `DiagnosticEngine` | **Worker Thread** | `server/src/diagnostics/` | 环境诊断 |
  | `NotificationManager` | **Worker Thread** | `server/src/notification/` | 通知分发 |
  | `PacketCapture` | **Worker Thread** | `server/src/devtools/` | 通信抓包 |
  | `UpdateManager` | **Worker Thread** | `server/src/update/` | 自动更新 |

**Layer 3 — Transport Layer（传输层）**
- 六种 Transport 实现，全部继承 `ITransport` 接口（USB HID / Serial / BLE / TCP/UDP / USB Native / FFI）
- 文件路径：`server/src/transport/{transport-type}/`

### 双层核心解耦：Transport vs Protocol

```
Transport Layer    ←→    Protocol Layer
（物理字节收发）         （帧结构解析）

严格解耦！Transport 不知道协议含义，Protocol 不管理连接状态
```

**组合方式：**
```typescript
// DeviceChannel 是运行时绑定的组合单元
class DeviceChannel {
  constructor(
    public readonly transport: ITransport,
    public readonly protocol: IProtocol,
    public readonly config: DeviceConfig
  ) {}
}
```

### 双通道数据流

每个 `DeviceChannel` 维护两个并行通道：

```
Command Channel:  App → Encode → Transport.send() → [wait] → Transport.onData() → Decode → resolve
Event Channel:    Transport.onEvent() → Decode → EventBus.emit('device:event') → WS → Frontend
```

### 数据流的统一出口

所有设备数据最终以 `DeviceEvent` 格式通过 WebSocket 推送到前端：

```typescript
interface DeviceEvent {
  deviceId: string;
  channel: 'command' | 'event';
  messageType: string;
  data: Record<string, unknown>;
  rawBuffer: Buffer;           // 服务端内部类型；推送到前端时 rawBuffer 以 Binary Frame 独立传输
  timestamp: bigint;           // process.hrtime.bigint()
  characteristicUUID?: string; // BLE 专用
  reportId?: number;           // HID 专用
}
```

> **WebSocket 分帧规则**：控制消息（JSON Text Frame）与原始字节数据（Binary Frame / ArrayBuffer）走同一 WebSocket 连接的不同 frame type。前端设置 `ws.binaryType = 'arraybuffer'`，Binary Frame 头部携带 `deviceId` 前缀用于路由。

### 模块依赖关系（依赖方向）

```
主线程
  GatewayService ─── IPC ──→ CommandDispatcher [Worker]
  Watchdog ────────── IPC ──→ 所有 Service Workers（health ping）

Worker Thread 间（单向 IPC，禁止循环依赖）
  CommandDispatcher [Worker]
    └─ IPC: COMMAND_SEND ──→ DeviceManager [Worker]
                                  ├→ DeviceChannel[]
                                  │    ├→ ITransport（具体实现）
                                  │    └→ IProtocol（由 ProtocolEngine 生成）
                                  └─ IPC ──→ ProtocolEngine [Worker]
  PluginLoader [Worker]
    └─ IPC ──→ DeviceManager [Worker]（插件加载完成通知）

所有 Workers → ObservabilityService [Worker]（单向：日志/指标上报）
所有 Workers → NotificationManager  [Worker]（单向：异常通知）
```

> **DeviceChannel 所有权唯一归属 `DeviceManager Worker`**。`CommandDispatcher` 不持有 `DeviceChannel` 引用，通过 `COMMAND_SEND` IPC 消息委托 `DeviceManager` 执行，消除跨 Worker 的循环依赖。

---

## Constraints

- **禁止** Presentation Layer 直接访问 Transport Layer（必须经过 Application Layer）
- **禁止** 跳过 Protocol Layer 将原始 Buffer 直接推送到前端（DevTools 抓包专用接口除外）
- **禁止** 在任何 Service 中 `require` / `import` 另一个 Service 的内部实现（通过接口和事件通信）
- Transport Layer 不得向上层发布事件，只能被 `DeviceChannel` 消费
- Application Layer 的 Service 间依赖方向必须是单向的，不允许循环依赖
- 新增功能模块必须在本文档的"服务模块列表"中登记

---

## Examples

### 完整数据流示例：前端发送命令 → 设备 → 前端收到响应

```
1. 前端 Click "查询状态"
2. React → WebSocket.send({ type: 'COMMAND_SEND', deviceId: 'xxx', command: 'GET_STATUS' })
3. GatewayService → CommandDispatcher.dispatch(deviceId, 'GET_STATUS', {})
4. CommandDispatcher → DeviceChannel.sendCommand('GET_STATUS', {})
5. DeviceChannel → Protocol.encode({ command: 'GET_STATUS' }) → Buffer [AA 55 02 01 00 03]
6. DeviceChannel → Transport.send(buffer)
7. [物理设备处理并回复]
8. Transport.onData(responseBuffer) → Protocol.decode(responseBuffer) → { status: 'OK', battery: 85 }
9. DeviceChannel → EventBus.emit('device:event', DeviceEvent{ messageType: 'GET_STATUS_RESPONSE', data: {...} })
10. GatewayService → WebSocket.send(DeviceEvent)
11. React Store 更新 → UI 刷新
```

### 热插拔事件流

```
1. 用户插入 USB HID 设备
2. usb.on('attach') → DeviceManager 收到原始设备信息
3. DeviceManager → PluginLoader.matchPlugin(deviceInfo) → 找到 plugin 'barcode-scanner-v1'
4. DeviceManager 创建 UsbHidTransport + 加载 Protocol Schema + 创建 DeviceChannel
5. DeviceManager.connect(deviceChannel) → 状态机: attached → connecting → connected
6. DeviceChannel 开始监听 IN Endpoint（Endpoint Hook）
7. EventBus.emit('device:attached', DeviceInfo) → WebSocket → 前端设备列表更新
```
