# DevBridge — 完整需求提示词文档

> **版本**: v1.1.0 | **日期**: 2026-02-28  
> **定位**: 本文档是 DevBridge 项目的核心需求参考文档，供 AI 辅助开发时作为上下文总纲使用。

---

## 一、项目愿景与目标

### 1.1 背景与痛点

作为一名从事 PC 桌面外设通信开发 10 余年的工程师，日常工作中面临以下系统性问题：

1. **协议分裂**: 不同厂商的外设通信协议各自私有——扫码枪用 USB HID Input Report，称重仪用 RS-485 私有二进制帧，传感器用 BLE GATT Notification，POS 终端用 TCP TLV，每次对接都要从头实现一套通信栈。

2. **通信方式多样**: USB HID、串口（RS-232/RS-485）、蓝牙（Classic/BLE）、TCP/UDP 网络、USB 原生（libusb）——五种方式底层机制完全不同，难以用统一范式处理。

3. **架构退化**: 传统做法将通信逻辑与 UI 深度耦合（Electron/WinForms），导致复用性差、难以测试、一旦驱动崩溃整个应用退出。

4. **缺乏标准化**: 没有统一的设备生命周期管理，热插拔、重连、错误恢复都要各自实现，质量参差不齐。

### 1.2 目标

构建 **DevBridge**（Universal Hardware Interface Platform）——一套以 Node.js 为后台服务、React 运行在浏览器中为前端控制面板的外设通信中间件平台，实现：

- **统一接入**: 五种通信方式通过同一套架构管理，Transport 与 Protocol 完全解耦
- **零代码接入简单设备**: 通过声明式 Protocol Schema 描述协议，无需编写代码即可对接标准设备
- **高性能**: < 5ms 内将命令并行广播到所有已连接外设（≤ 10 台）
- **高稳定性**: 微服务化进程隔离，一个设备驱动崩溃不影响其他设备和主服务
- **可维护**: 完整的可观测性体系（日志、错误监控、性能指标、通信历史）

---

## 二、系统架构

### 2.1 整体三层架构

```
┌───────────────────────────────────────────────────────────┐
│                    Presentation Layer                     │
│              React SPA (Browser / localhost)              │
│  ┌─────────────── MW 中间层（业务逻辑）─────────────────┐  │
│  │  WsClient │ Zustand Stores │ CommandService │PacketTap│  │
│  └─────────────────────────────────────────────────────┘  │
│  ┌──────────────────── UI 层（纯渲染）──────────────────┐  │
│  │ DeviceList │ControlPanel │LogViewer │Metrics │DevTools│  │
│  └─────────────────────────────────────────────────────┘  │
└─────────────────────────┬─────────────────────────────────┘
                          │ WebSocket (ws://) + REST (http://)
                          │ 统一数据格式: DeviceEvent / DeviceState
┌─────────────────────────▼─────────────────────────────────┐
│                    Application Layer                      │
│                  Node.js Backend Services                 │
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │   Gateway   │  │    Device    │  │    Command      │  │
│  │  Service    │  │   Manager    │  │   Dispatcher    │  │
│  │(Fastify+ws) │  │  (lifecycle) │  │  (broadcast)    │  │
│  └─────────────┘  └──────────────┘  └─────────────────┘  │
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │ Plugin      │  │  Protocol    │  │  Observability  │  │
│  │ System      │  │  Engine      │  │ (Log/Sentry/    │  │
│  │             │  │  (DSL)       │  │  Metrics)       │  │
│  └─────────────┘  └──────────────┘  └─────────────────┘  │
└─────────────────────────┬─────────────────────────────────┘
                          │ Transport API
┌─────────────────────────▼─────────────────────────────────┐
│                    Transport Layer                        │
│                                                           │
│  ┌──────────┐ ┌────────┐ ┌─────┐ ┌─────────┐ ┌────────┐  │
│  │ USB HID  │ │Serial  │ │ BLE │ │TCP/UDP  │ │USB     │  │
│  │Transport │ │Transport│ │     │ │Transport│ │Native  │  │
│  └──────────┘ └────────┘ └─────┘ └─────────┘ └────────┘  │
└───────────────────────────────────────────────────────────┘
                          │
              物理外设（扫码枪/称重仪/传感器/POS终端...）
```

### 2.2 双层解耦原则

**Transport Layer（通信方式层）** 与 **Protocol Layer（协议解析层）** 严格分离：

| 层次 | 职责 | 不应做的事 |
|------|------|-----------|
| **Transport** | 物理连接管理、字节级收发、连接/断开、热插拔 | 不解析协议帧，不知道数据含义 |
| **Protocol** | 帧边界识别、字段解析、校验验证、命令编码 | 不管理设备连接，不关心底层通信方式 |

两者通过 Pipeline 模式组合：
```
Device ←→ Transport ←→ [PacketTap(可选)] ←→ Protocol ←→ Application
```

一个 Transport 可搭配多种 Protocol，同一种 Protocol 理论上也可运行在不同 Transport 上（如 Modbus RTU on Serial / Modbus TCP on TCP）。

### 2.3 双通道数据流模型

每个设备连接同时维护两个独立数据通道：

| 通道 | 方向 | 模式 | 典型场景 |
|------|------|------|---------|
| **Command Channel** | Host ↔ Device | 请求-响应，有 correlationId，有超时 | 发送查询命令 → 等待设备回复 |
| **Event Channel** | Device → Host | 被动监听/订阅，持续流式 | HID IN Report 上报扫码数据；BLE Notification 推传感器值 |

统一输出格式 `DeviceEvent`：
```typescript
interface DeviceEvent {
  deviceId: string;           // 设备唯一标识
  channel: 'command' | 'event';
  messageType: string;        // 由 Protocol Schema 定义的消息类型名
  data: Record<string, any>;  // Protocol 解码后的结构化数据
  rawBuffer: Buffer;          // 原始二进制数据（服务端内部类型）
  timestamp: bigint;          // process.hrtime.bigint() 高精度时间戳
  characteristicUUID?: string; // BLE 专用：来源 Characteristic
  reportId?: number;          // HID 专用：Report ID
}
```

**WebSocket 传输分帧策略：**

WebSocket 消息通道按 frame 类型区分两类数据，共用同一连接：

| Frame 类型 | 内容 | 前端处理 |
|-----------|------|--------|
| **Text Frame（JSON）** | 控制消息、设备状态、命令响应（不含 rawBuffer）| `JSON.parse()` 正常处理 |
| **Binary Frame（ArrayBuffer）** | `rawBuffer` 原始字节数据，用于 DevTools Hex Dump / PacketTap | `ws.binaryType = 'arraybuffer'`，前端用 `DataView` 解析 |

- Binary Frame 头部包含 `deviceId`（固定长度前缀）用于前端路由
- DevTools 关闭时服务端不发送 Binary Frame（零开销）
- **禁止** 将 `rawBuffer` Base64 编码后混入 JSON 字段（+33% 传输开销）

---

## 三、外设通信协议矩阵

### 3.1 六种通信方式对比

| Transport 类型 | Node.js 库 | 典型设备 | 协议特点 | 热插拔检测 |
|----------------|-----------|---------|---------|-----------|
| **USB HID** | `node-hid` + `usb` | 扫码枪、读卡器、自定义 HID 设备 | Input/Output/Feature Report，可能有 Report ID | `usb.on('attach/detach')` 原生事件 |
| **Serial (RS-232/RS-485)** | `serialport` | 称重仪、PLC、条码打印机、自定义工控设备 | 分隔符/长度前缀/魔术字节帧，ASCII 或二进制 | 轮询 `SerialPort.list()` 差异比对 |
| **BLE (Bluetooth LE)** | `@abandonware/noble` | IoT 传感器、健康设备、自定义 BLE 从机 | GATT Service/Characteristic，Notification/Indication | RSSI 超时 + `noble` 扫描回调 |
| **TCP/UDP** | Node.js `net` / `dgram` | POS 终端、网络打印机、工控网关、工业设备 | TLV、Modbus TCP、ESC/POS、自定义 JSON/Binary | 心跳超时 + `close`/`error` 事件 + mDNS |
| **USB Native** | `usb` (libusb) | 需要多 Interface、多 Endpoint 的复杂 USB 设备 | Bulk/Interrupt/Control Transfer，自定义协议 | `usb.on('attach/detach')` 原生事件 |
| **FFI（DLL/共享库）** | `node-ffi-napi` + `ref-napi` | 仅提供专有 C SDK 的设备（专有扫码枪、支付终端、工业传感器） | 直接调用 DLL 函数，由 SDK 内部定义命令格式 | 依赖 SDK 自有回调，无标准热插拔事件 |

### 3.2 协议多样性示例

**同一 Transport，不同 Protocol：**

```
串口 (SerialPort)
  ├── 称重仪 A: STX + 重量ASCII文本 + ETX + CRLF
  ├── PLC B: Modbus RTU (地址+功能码+数据+CRC16)
  └── 传感器 C: 帧头0xAA55 + 长度[1] + 命令码[1] + 数据[N] + XOR校验[1]

USB HID
  ├── 扫码枪: 标准 HID Keyboard Input Report (Usage Page 0x01)
  ├── 读卡器: 自定义 HID Feature Report (Usage Page 0xFF00)
  └── 自定义控制器: Output Report ID 0x01 控制灯/按键，Input Report ID 0x02 上报状态
```

### 3.3 FFI Transport 专项设计

**适用场景**：设备厂商仅提供 Windows DLL / Linux .so（C 接口），无法通过 USB HID 或串口直接访问。当 DLL SDK 是唯一可用的接入方式时使用 FFI Transport。

#### 进程隔离强制要求

`node-ffi-napi` 存在内存安全风险（原生代码崩溃会直接终止 v8 进程），因此：

- **DLL 加载必须在 Child Process 中执行**，不得在主进程或 Worker Thread 中 `require('node-ffi-napi')`
- PluginLoader 为所有 FFI 插件调用 `child_process.fork()`，并在 Plugin Manifest 中声明 `"isolation": "child-process"`
- 一个 Child Process 可加载多个 DLL，通过 `ffiConfig.dlls` 分组管理

#### Plugin Manifest FFI 配置

```json
{
  "name": "acme-payment-terminal",
  "version": "1.0.0",
  "isolation": "child-process",
  "transport": "ffi",

  "ffiConfig": {
    "dlls": [
      {
        "id": "core",
        "path": "C:/Program Files/ACME/AcmeSDK.dll",
        "stability": "stable"
      },
      {
        "id": "crypto",
        "path": "C:/Program Files/ACME/AcmeCrypto.dll",
        "stability": "stable"
      }
    ],
    "functions": [
      { "name": "SDK_Init",        "returnType": "int",  "argTypes": [] },
      { "name": "SDK_Connect",     "returnType": "int",  "argTypes": ["int"] },
      { "name": "SDK_SendCommand", "returnType": "int",  "argTypes": ["int", "pointer", "int"] },
      { "name": "SDK_Disconnect",  "returnType": "void", "argTypes": ["int"] }
    ],
    "callbacks": [
      { "name": "OnDeviceEvent", "returnType": "void", "argTypes": ["int", "pointer", "int"] }
    ]
  },

  "reconnect": {
    "maxRetries": 3,
    "retryInterval": 2000,
    "backoffMultiplier": 2,
    "maxRetryInterval": 30000
  }
}
```

#### DLL 隔离分组策略

| 策略 | 条件 | 说明 |
|------|------|------|
| **共享**（默认） | `stability: "stable"` — DLL 稳定，无崩溃风险 | 多个 DLL 同一 Child Process |
| **独占隔离** | `stability: "unstable"` — DLL 可能崩溃 | 每个 DLL 独立 Child Process，崩溃不影响其他设备 |

#### 连接状态轮询

FFI Transport 无标准热插拔事件，DeviceManager 对 FFI 类型设备执行心跳轮询（默认 2s），通过返回值检测连接状态变化。

---

## 四、核心设计原则

### 4.1 Transport / Protocol 完全解耦

- Transport 只负责 `send(buffer)` 和 `onData(buffer)` 两个方向
- Protocol 只负责 `encode(command) → Buffer` 和 `decode(Buffer) → Message` 两个方向
- 两者通过 `DeviceChannel` 组合绑定，运行时动态创建

### 4.2 声明式协议描述系统（Protocol DSL）

用 JSON/YAML 文件声明协议：

```jsonc
{
  "name": "my_sensor",
  "version": "1.0.0",
  "transport": "serial",
  "framing": {
    "mode": "magic-header",
    "header": ["0xAA", "0x55"],
    "lengthField": { "offset": 2, "type": "uint8", "includes": "payload" }
  },
  "channels": {
    "command": {
      "request": {
        "fields": [
          { "name": "header",   "type": "bytes",  "value": ["0xAA", "0x55"] },
          { "name": "length",   "type": "uint8",  "value": "auto" },
          { "name": "cmdCode",  "type": "uint8" },
          { "name": "payload",  "type": "bytes" },
          { "name": "checksum", "type": "uint8",  "algorithm": "xor", "range": "cmdCode..payload" }
        ]
      },
      "response": {
        "fields": [
          { "name": "header",   "type": "bytes",  "length": 2 },
          { "name": "length",   "type": "uint8" },
          { "name": "status",   "type": "uint8",  "enum": { "0x00": "OK", "0x01": "ERROR" } },
          { "name": "data",     "type": "bytes",  "length": "length - 2" },
          { "name": "checksum", "type": "uint8" }
        ]
      }
    },
    "event": {
      "input_report": {
        "fields": [
          { "name": "reportId", "type": "uint8" },
          { "name": "eventType","type": "uint8",  "enum": { "0x01": "BUTTON_PRESS", "0x02": "SENSOR_DATA" } },
          { "name": "value",    "type": "uint16le" }
        ]
      }
    }
  },
  "commands": {
    "GET_STATUS":    { "cmdCode": "0x01", "payloadFields": [] },
    "SET_LED":       { "cmdCode": "0x02", "payloadFields": [{ "name": "color", "type": "uint8" }] }
  },
  "checksum": {
    "algorithm": "xor",
    "description": "所有数据字节异或"
  },
  "examples": [
    {
      "direction": "send",
      "description": "查询设备状态",
      "hex": "AA 55 02 01 00 03",
      "decoded": { "cmdCode": "GET_STATUS", "payload": [] }
    }
  ]
}
```

**字段类型系统：**

| 类型 | 说明 |
|------|------|
| `uint8/16le/16be/32le/32be` | 无符号整数（小端/大端） |
| `int8/16le/16be/32le/32be` | 有符号整数 |
| `float32/float64` | 浮点数 |
| `ascii` | ASCII 字符串 |
| `hex` | 原始十六进制字节 |
| `bcd` | BCD 编码数字 |
| `bitmap` | 位图（按位定义字段含义） |
| `bytes` | 原始字节数组 |
| `enum` | 枚举映射 |
| `struct` | 嵌套结构 |
| `array` | 重复字段数组 |
| `conditional` | 条件字段（根据其他字段值决定） |

**内置校验算法：** `crc16-modbus` / `crc16-ccitt` / `crc32` / `xor` / `sum8` / `lrc`

### 4.3 插件化架构

一个完整设备插件由三部分组成：

```
plugins/
└── my-device-v1.0/
    ├── manifest.json          # 插件元信息（含沙箱声明）
    ├── protocol.schema.json   # 声明式协议定义
    └── handler.ts             # (可选) 复杂业务逻辑，强制在 Child Process 中运行
```

`manifest.json` 示例：
```json
{
  "name": "my-sensor",
  "version": "1.0.0",
  "description": "某品牌传感器驱动",
  "transportType": "serial",
  "protocolRef": "my_sensor",
  "isolation": "child-process",
  "match": {
    "pnpId": "USB\\VID_1234&PID_5678",
    "baudRate": 9600
  },
  "reconnect": {
    "maxRetries": -1,
    "retryInterval": 1000,
    "backoffMultiplier": 2,
    "maxRetryInterval": 30000
  },
  "hidConfig": null,
  "bleConfig": null
}
```

**插件沙箱策略：**

| 插件类型 | 沙箱机制 | 理由 |
|---------|---------|------|
| 仅 `manifest.json` + `protocol.schema.json`（零代码插件）| Schema 验证 + examples 自检 | 无可执行代码，风险最低 |
| 含 `handler.ts` 的插件 | **强制 `child_process.fork()` 隔离** | handler 是任意可执行代码，必须与主进程隔离 |

- `handler.ts` 存在时，`isolation` 字段**强制为** `"child-process"`，PluginLoader 拒绝加载违反此规则的插件
- Child Process 内的 handler 通过 IPC Channel 与 DeviceManager Worker 通信，不能直接访问主进程内存
- 未来可在 Linux 上通过 seccomp/AppArmor 进一步限制 Child Process 的系统调用权限

最简插件（零代码）= `manifest.json` + `protocol.schema.json`，Protocol Runtime Engine 自动处理 encode/decode。

### 4.4 协议热加载

- 使用 `chokidar` 监听 `protocols/` 和 `plugins/*/` 目录
- 文件变更 → Schema 验证 → 沙箱测试（运行 examples 自检）→ 注册到 ProtocolRegistry → 通知 DeviceManager
- 热加载不中断正在进行的设备通信（等待当前事务完成再切换）
- 加载失败时保留旧版本，回报错误到前端

---

## 五、微服务化架构设计

### 5.1 服务模块拆分

| Service | 运行位置 | 线程模型 | 职责 |
|---------|---------|---------|------|
| **Gateway Service** | 主线程（Main Thread）| 独占主线程 | HTTP/WebSocket 网关，纯 I/O 转发，Fastify + ws |
| **Device Manager** | Worker Thread | 独立 Worker | 设备生命周期管理：枚举、热插拔、状态机；**拥有所有 `DeviceChannel` 实例** |
| **Command Dispatcher** | Worker Thread | 独立 Worker | 命令路由、并行广播、优先级队列；通过 IPC 消息驱动 DeviceManager |
| **Protocol Engine** | Worker Thread | 独立 Worker | Protocol Schema 加载、热更新、encode/decode |
| **Observability** | Worker Thread | 独立 Worker | 日志汇聚、Sentry、Metrics 采集 |
| **Driver Worker** × N | Worker Thread / Child Process | 由 Plugin Manifest `isolation` 字段决定 | 每个设备驱动实例，独立运行 |
| **Plugin Handler** × N | Child Process（强制）| `child_process.fork()` | 含 handler.ts 的插件业务逻辑，强制隔离 |
| **Watchdog** | 主线程（Main Thread）| 与 GatewayService 同线程 | 健康检查、崩溃自愈、进程守护 |

> **GatewayService 独占主线程**：确保 HTTP/WS I/O 响应不受设备扫描、协议解析等计算操作阻塞。所有耗时操作（设备枚举、命令广播）均在各自的 Worker Thread 中异步完成，通过 `MessagePort` 与主线程通信。
>
> **DeviceChannel 所有权归 DeviceManager Worker**：`CommandDispatcher` 不直接持有 `DeviceChannel` 引用，而是通过 IPC 消息（`COMMAND_SEND`）发送到 `DeviceManager Worker`，由后者执行实际的 Transport 发送操作，消除跨 Worker 的循环依赖。

### 5.2 进程隔离策略（混合模式）

| 场景 | 隔离方式 | 理由 |
|------|---------|------|
| 稳定设备驱动（标准 HID、TCP） | Worker Thread | 共享内存优势，创建开销低 |
| 不稳定/关键设备驱动（libusb、BLE） | Child Process (`fork`) | 崩溃完全隔离，不影响主进程 |
| 所有 Driver 默认 | Worker Thread | 通过 Plugin Manifest 声明可覆盖为 Process |

每个 Driver Worker 实现 `IService` 接口：
```typescript
interface IService {
  start(): Promise<void>;
  stop(): Promise<void>;
  health(): ServiceHealth;
  metrics(): ServiceMetrics;
}
```

### 5.3 IPC 消息协议

所有进程/线程间通信使用统一消息格式：
```typescript
interface IPCMessage {
  type: string;             // 消息类型（如 'COMMAND_SEND' / 'DATA_RECEIVED'）
  source: string;           // 发送方 serviceId
  target: string;           // 接收方 serviceId（'*' 为广播）
  correlationId: string;    // 请求-响应追踪 ID（UUID v4）
  payload: unknown;         // 业务数据
  timestamp: bigint;        // 发送时间 process.hrtime.bigint()
}
```

进程内：`EventEmitter` + `SharedArrayBuffer`（零拷贝二进制）  
进程间：`MessagePort`（Worker Thread）/ IPC Channel（Child Process）

### 5.4 Watchdog 与自愈

- Watchdog 定期（1s）向所有 Service 发送 health ping
- 超时未响应或 health 返回 `critical` → 执行重启流程
- 重启策略：指数退避（1s → 2s → 4s...，最大 30s）
- 连续重启超过阈值 → 标记为 `permanently_failed`，通知用户介入
- Graceful Shutdown：收到 SIGTERM → 逐个 `service.stop()` → 等待进行中命令完成（最长 5s）→ exit

---

## 六、性能指标（SLA）

| 指标 | 目标值 | 说明 |
|------|--------|------|
| 命令广播延迟 | **≤ 5ms** | 从 Host 发出到所有已连接外设均收到命令（≤ 10 台） |
| 单设备命令发送延迟 | **< 1ms** | 不含设备响应时间 |
| WebSocket Round-Trip | **< 10ms**（本地）/ **< 50ms**（LAN） | 前端到设备命令的完整 RTT |
| 设备热插拔检测延迟 | **< 500ms** | USB 原生事件 < 100ms；Serial 轮询 ≤ 1s |
| 服务启动到就绪 | **< 3s** | 冷启动，包含全量设备扫描 |
| 内存占用（空载） | **< 100MB** | 无设备连接时 |
| 内存占用（10 台设备） | **< 200MB** | 满载运行时 |
| Protocol Schema 热加载 | **< 200ms** | 从文件变更到新协议生效 |

### 热路径优化策略

- 命令广播：`Promise.allSettled()` 并行下发，不等最慢设备，超时（默认 100ms）设备独立降级
- 零拷贝：Worker Thread 之间使用 `SharedArrayBuffer` + `Atomics` 传递设备二进制数据
- Buffer Pool：预分配环形缓冲区，避免高频通信中反复 `Buffer.alloc()`
- 高精度时间戳：使用 `process.hrtime.bigint()`，不用 `Date.now()`
- 热路径禁止：`JSON.stringify/parse`（改用 Buffer 二进制协议）、闭包大对象捕获、`console.log`

---

## 七、设备生命周期管理

### 7.1 设备枚举

服务启动时及按需扫描所有 Transport 类型，返回统一格式的设备列表：

```typescript
interface DeviceInfo {
  deviceId: string;           // Transport类型:指纹Hash
  transportType: TransportType;
  status: DeviceStatus;       // 见状态机
  name: string;
  address: string;            // COM3 | USB:1-2 | BLE:MAC | IP:PORT
  vendorId?: number;
  productId?: number;
  serialNumber?: string;
  matchedPlugin?: string;     // 匹配到的插件名
  pluginConfig?: Record<string, unknown>;
  lastSeen: bigint;
  connectedAt?: bigint;
}
```

### 7.2 设备状态机

```
                      ┌──识别完成──┐
unknown ──发现设备──► scanning ──► identified ──► connecting ──connected──► [运行中]
                                                       |                       |
                                                  connect失败              disconnect事件
                                                       |                       |
                                                     error              disconnected ──auto-reconnect──► reconnecting
                                                                                                              |
                                                                                                         重连成功 → connected
                                                                                                         超出maxRetries → error
          任意状态 ──物理拔出──► detached ──► removed ──► [从列表清除]
```

### 7.3 自动重连策略

```typescript
interface ReconnectConfig {
  maxRetries: number;       // -1 = 无限，0 = 不重连，默认 5
  retryInterval: number;    // 初始间隔 ms，默认 1000
  backoffMultiplier: number;// 指数退避倍数，默认 2
  maxRetryInterval: number; // 最大间隔，默认 30000ms
  reconnectOn: ('detach' | 'disconnect' | 'error')[];
}
```

重连时保留设备的所有配置（Protocol Schema、BLE 订阅列表等），重连成功后自动恢复。

### 7.4 各 Transport 热插拔检测

| Transport | 机制 | 延迟 |
|-----------|------|------|
| USB HID | `usb.on('attach/detach')` 原生 hotplug | < 100ms |
| USB Native | `usb.on('attach/detach')` | < 100ms |
| Serial | 轮询 `SerialPort.list()` 差异比对 | ≤ 1s（轮询间隔可配置） |
| BLE | RSSI 超时 + `noble.on('discover')` | 5-10s（软性检测）|
| TCP/UDP | 心跳超时 + mDNS 服务消失 + socket `close/error` | 1-30s（心跳间隔可配置）|| FFI | SDK 自有回调（`on-device-disconnected` 等）或无（需 isConnected 轮询）| 依赖 SDK，通常 1-5s |
---

## 八、USB HID 深度设计

### 8.1 标准 HID vs 自定义 HID 识别策略

三步识别流程：

1. **自动解析 Report Descriptor**: 调用 `node-hid` 或 `usb` 库获取 HID Report Descriptor 二进制数据，使用内置 `HidReportDescriptorParser` 解析
2. **Usage Page 分类**:
   - `0x01 Generic Desktop` → 根据 Usage ID 进一步细分（Keyboard/Mouse/Joystick/...）
   - `0x0C Consumer Device` → 多媒体键
   - `0x8C Bar Code Scanner` → 标准扫码枪
   - `0xFF00+` (Vendor Defined) → **自定义 HID**
3. **Fallback**: 解析失败或无法获取 Descriptor → 查 Plugin Manifest 的 `hidConfig.type` 声明 → 最终默认当作 Custom HID

### 8.2 Endpoint Hook 机制

```
节点 HID 设备
  ├── Interface 0 (标准 HID)
  │     ├── Interrupt IN Endpoint  ← node-hid: device.on('data', buffer => ...)
  │     └── Interrupt OUT Endpoint ← node-hid: device.write(buffer)
  └── Interface 1 (自定义 / 复合设备)
        ├── Interrupt IN Endpoint  ← usb: endpoint.startPoll() + endpoint.on('data', ...)
        └── Interrupt OUT Endpoint ← usb: endpoint.transfer(buffer)
```

对于复合 HID 设备：
- 通过 `usb` 库枚举所有 Interface
- 对每个 Interface 调用 `interface.claim()`
- 找到 Interrupt IN Endpoint，调用 `endpoint.startPoll(numTransfers, transferSize)` 持续监听
- 同时可通过 `device.setInterface()` 在多 Interface 间切换

### 8.3 Report ID 路由

Plugin Manifest 中声明 Report ID 到协议解析规则的映射：
```json
{
  "hidConfig": {
    "type": "custom",
    "reportRouting": {
      "0x01": "status_report",
      "0x02": "sensor_data_report",
      "0x03": "error_report"
    }
  }
}
```

---

## 九、BLE GATT 深度设计

### 9.1 订阅声明格式

在 Plugin Manifest 中声明完整的 GATT 订阅配置：

```json
{
  "bleConfig": {
    "deviceNameFilter": "MySensor",
    "serviceUUIDs": ["6E400001-B5A3-F393-E0A9-E50E24DCCA9E"],
    "mtu": 512,
    "subscriptions": [
      {
        "serviceUUID": "180F",
        "characteristicUUID": "2A19",
        "mode": "notification",
        "protocolRef": "battery_level"
      },
      {
        "serviceUUID": "6E400001-B5A3-F393-E0A9-E50E24DCCA9E",
        "characteristicUUID": "6E400003-B5A3-F393-E0A9-E50E24DCCA9E",
        "mode": "notification",
        "protocolRef": "vendor_sensor_stream"
      }
    ],
    "writeCharacteristic": {
      "serviceUUID": "6E400001-B5A3-F393-E0A9-E50E24DCCA9E",
      "characteristicUUID": "6E400002-B5A3-F393-E0A9-E50E24DCCA9E",
      "writeType": "withResponse"
    }
  }
}
```

### 9.2 数据聚合

Protocol Schema 可声明将多个 Characteristic 的数据按时间窗口聚合为复合事件：
```json
{
  "aggregation": {
    "window": 100,
    "mergeCharacteristics": ["2A6E", "2A6F"],
    "outputSchema": { "temperature": "2A6E.value", "humidity": "2A6F.value" }
  }
}
```

---

## 十、部署模式

### 10.1 本地模式

```
[Browser on same PC]
      ↕ localhost:3000 (HTTP/WS)
[Node.js Service on same PC]
      ↕ USB / COM / BLE / TCP
[Physical Devices]
```

- WebSocket 无需认证（localhost 绑定）
- 服务通过 PM2 或 Windows Service 常驻运行
- 前端访问 `http://localhost:3000`

### 10.2 局域网模式

```
[Browser on Control PC]
      ↕ LAN: ws://192.168.x.x:3000 (API Key 认证)
[Node.js Service on Device PC]
      ↕ USB / COM / BLE / TCP
[Physical Devices]
```

- WebSocket/REST 加 API Key Header 认证
- 通过 mDNS (Bonjour) 自动发现服务（`DevBridge._tcp.local`）
- CORS 白名单配置
- 可选 HTTPS/WSS（自签名证书）

---

## 十一、可观测性体系

### 11.1 日志系统

- **库**: `pino`（高性能 JSON 结构化日志）
- **日志分级**: `trace` / `debug` / `info` / `warn` / `error` / `fatal`
- **日志分类**:
  - `logs/system.log` — 主进程系统日志
  - `logs/error.log` — 仅 error + fatal
  - `logs/devices/{deviceId}.log` — 每设备独立通信日志
- **文件轮转**: 单文件最大 10MB，按日归档，保留最近 30 天
- **前端查看**: REST API `GET /api/v1/logs` + WebSocket 实时流 `ws://host/logs/stream`

### 11.2 Sentry 错误监控

- `@sentry/node`（后端）+ `@sentry/react`（前端）
- 上下文附加：当前连接设备列表、最近 10 条通信记录（breadcrumbs）、系统信息
- 可完全关闭（离线/隐私场景），关闭时 fallback 到本地 error 日志
- Source Map 上传：构建时自动上传

### 11.3 性能 Metrics

- 采集项：CPU、内存 Heap/RSS、Event Loop Lag、已连接设备数、命令 QPS、延迟 P50/P95/P99、WebSocket 客户端数
- 存储：内存环形缓冲区（最近 1 小时）
- API: `GET /api/v1/metrics` + WebSocket 订阅 `metrics:update`（5s 推送）
- 可选 Prometheus endpoint `/metrics`（`prom-client`）

### 11.4 通信历史记录

- 每设备最近 1000 条记录（内存环形缓冲区）
- 可选写入 SQLite（长期保存）
- 记录内容：时间戳、方向、channel、rawHex、decoded 结果、状态（success/error/timeout）
- API: `GET /api/v1/devices/:id/history`

---

## 十二、环境诊断系统

服务启动时自动执行，也可手动触发 `POST /api/v1/diagnostics/run`：

| 类别 | 检测项 | 判定标准 |
|------|--------|---------|
| Runtime | Node.js 版本 | ≥ 20 LTS |
| OS | 操作系统版本 | Windows 10+ / macOS 12+ / Ubuntu 20.04+ |
| Hardware | USB 控制器 | 至少 1 个可用 |
| Hardware | 蓝牙适配器 | 系统蓝牙服务可用 |
| Driver | WinUSB/libusb | 自定义 HID / USB Native 所需 |
| Native | `node-hid` 编译状态 | prebuild 可用 or node-gyp 成功 |
| Native | `serialport` 编译状态 | 同上 |
| Native | `usb` 编译状态 | 同上 |
| Network | 端口占用 | HTTP + WebSocket 端口可绑定 |
| Permission | USB 访问权限 | Windows: HID 权限；Linux: udev rules |
| Permission | 串口访问权限 | Linux: `dialout` 用户组 |
| Disk | 日志目录可写 | `logs/` 目录有写权限 |

每项返回 `{ name, category, status: 'pass' | 'warn' | 'fail', message, suggestion }`，`suggestion` 提供具体可操作修复步骤。

---

## 十三、异常状态通知

| 级别 | 触发条件 | 展示方式 |
|------|---------|---------|
| `info` | 设备成功连接 | 前端 Toast（3s 自动消失）|
| `warning` | 设备意外断开、命令超时率升高、磁盘空间不足 | 前端 Toast + 系统 Notification |
| `error` | 自动重连耗尽、通信错误率超阈值 | 前端持久通知栏 + 系统 Notification |
| `critical` | 服务进程崩溃重启、环境诊断有 `fail` 项 | 前端持久通知栏 + 系统 Notification + 声音（可选）|

- **前端通知中心**: 所有历史通知列表，可标记已读
- **系统通知**: `node-notifier`（桌面 OS 通知）+ Web Notification API（浏览器推送，浏览器最小化时也可见）
- **防打扰**: 同类型通知 30s 内不重复；支持用户自定义静音时段

---

## 十四、开发调试工具

### 14.1 通信抓包（Packet Capture）

- 在 Transport → Protocol 之间插入可选 `PacketTap` 层（关闭时零开销）
- 前端 DevTools 面板：Hex Dump 视图 + 协议字段彩色高亮标注
- 录制/回放：导出 JSONL 格式 `.capture` 文件
- 手动发送：`POST /api/v1/devices/:id/send-raw` body `{ hex: "AA55..." }`
- API: `POST /api/v1/devices/:id/capture/start` / `stop` + WebSocket 实时流 `ws://host/capture/:deviceId`

### 14.2 自动更新

| 层次 | 更新方式 |
|------|---------|
| 服务端核心 | 版本检查 → 下载 → 验证 SHA256 → 替换 → 重启（PM2 管理）|
| 插件 | 从 Plugin Registry 拉取 → 解压到 `plugins/` → 热加载（零停机）|
| Protocol Schema | 同上，覆盖 `protocols/` → 热加载 |
| 前端 | 新版本通知 → 用户确认 → 刷新页面 |

- 更新源可配置（支持内网私有源）
- 保留前 3 个版本，更新失败自动回滚

### 14.3 配置导入导出

- 导出：`GET /api/v1/config/export` → `.hid-config.zip`（devices.json + plugins/ + protocols/ + settings.json）
- 导入：上传 zip → 预览 diff → 确认应用
- 场景：多机部署、配置备份/恢复、团队共享

---

## 十五、国际化（i18n）

- 前端 `react-i18next`，默认中文 + 英文
- 后端所有面向用户的消息使用 message key，前端按当前语言渲染
- 语言包 `packages/client/locales/{lang}.json`
- 语言切换持久化到 `data/settings.json`

---

## 十六、技术选型汇总

### 后端

| 用途 | 选型 | 理由 |
|------|------|------|
| HTTP/WS 框架 | **Fastify** | TypeScript 友好，性能优于 Express，插件生态完整 |
| WebSocket | **ws** | 轻量、高性能、无依赖 |
| USB HID | **node-hid** | 跨平台 HID API，系统驱动级访问 |
| USB Native | **usb** | libusb 绑定，低层 Transfer 控制 |
| FFI | **node-ffi-napi** | DLL/共享库接入，仅限 Child Process |
| 串口 | **serialport** | 最成熟的 Node.js 串口库，Parser 体系完整 |
| BLE | **@abandonware/noble** | 最活跃的 Node.js BLE 库 |
| 文件监听 | **chokidar** | 跨平台文件系统监听 |
| 日志 | **pino** + **pino-roll** | 最高性能 Node.js 日志库，自动轮转 |
| 错误监控 | **@sentry/node** | 业界标准错误采集 |
| 系统通知 | **node-notifier** | 跨平台桌面通知 |
| Schema 验证 | **zod** | TypeScript-first Schema 验证 |
| SQLite（可选）| **better-sqlite3** | 同步 API，性能优秀，嵌入式存储 |
| 进程守护 | **PM2** / Windows Service | 生产环境进程管理 |

### 前端

| 用途 | 选型 |
|------|------|
| Framework | React 18+ + TypeScript |
| 状态管理 | Zustand |
| UI 组件库 | Shadcn/UI + Tailwind CSS |
| 图表 | Recharts |
| 国际化 | react-i18next |
| 构建工具 | Vite |

### 工程化

| 用途 | 选型 |
|------|------|
| Monorepo | pnpm workspace |
| 单元测试 | Vitest |
| E2E 测试 | Playwright |
| 提交规范 | Conventional Commits |
| 代码规范 | ESLint + Prettier |

---

## 十七、目录结构

```
DevBridge/
├── packages/
│   ├── server/
│   │   ├── src/
│   │   │   ├── gateway/         # HTTP/WebSocket 网关
│   │   │   ├── device-manager/  # 设备生命周期
│   │   │   ├── command/         # 命令分发
│   │   │   ├── transport/       # 6 种 Transport 实现
│   │   │   │   ├── usb-hid/
│   │   │   │   │   └── hid-parser/  # HID Report Descriptor Parser（服务端专属）
│   │   │   │   ├── ble/
│   │   │   │   ├── serial/
│   │   │   │   ├── network/
│   │   │   │   ├── usb-native/
│   │   │   │   └── ffi/             # node-ffi-napi DLL 加载（Child Process 专属）
│   │   │   ├── protocol/        # Protocol DSL 引擎
│   │   │   │   └── dsl-runtime/ # Protocol DSL 运行时引擎（服务端专属）
│   │   │   ├── plugins/         # 插件加载器
│   │   │   ├── observability/   # 日志/Sentry/Metrics
│   │   │   ├── diagnostics/     # 环境诊断
│   │   │   ├── notification/    # 通知系统
│   │   │   ├── devtools/        # 抓包/调试工具
│   │   │   ├── update/          # 自动更新
│   │   │   └── watchdog/        # 进程守护
│   │   └── package.json
│   ├── client/
│   │   ├── src/
   │   │   ├── mw/              # 中间层：业务逻辑（无 JSX）
   │   │   │   ├── ws/          # WsClient 单例、消息路由
   │   │   │   ├── stores/      # Zustand Store
   │   │   │   ├── commands/    # CommandService
   │   │   │   └── protocol/    # PacketTap Binary Frame 解析
   │   │   └── ui/              # UI 层：纯渲染
   │   │       ├── components/  # React 组件（无业务逻辑）
   │   │       ├── pages/       # 页面路由
   │   │       ├── hooks/       # useDevice / useCommand 等
   │   │       └── theme/       # Tailwind / Shadcn 主题
│   │   └── package.json
│   ├── shared/
│   │   ├── src/
│   │   │   └── types/           # 共享 TypeScript 类型（纯类型定义，零运行时依赖）
│   │   │       ├── device.d.ts          # DeviceInfo, DeviceStatus, DeviceEvent
│   │   │       ├── ipc.d.ts             # IPCMessage
│   │   │       ├── protocol-dsl.d.ts    # Protocol DSL Schema 类型（不含运行时引擎）
│   │   │       └── transport.d.ts       # TransportType, ITransport 接口类型
│   │   └── package.json   ├── plugin-sdk/
   │   └── src/                 # @devbridge/plugin-sdk：createPluginContext 等 SDK 接口│   └── plugins/
│       └── builtin/             # 内置设备驱动插件
├── protocols/                   # 协议 Schema 文件（热加载目录）
├── plugins/                     # 第三方插件目录（热加载目录）
├── data/
│   ├── devices.json             # 设备持久化配置
│   └── settings.json            # 系统设置
├── logs/                        # 日志文件目录
├── docs/
│   └── prompt-requirements.md
└── .ai/
    ├── instructions.md
    └── skills/
```

---

## 十八、安全设计

- **本地模式**: 仅绑定 `127.0.0.1`，无需认证
- **局域网模式**: API Key Header 认证（`X-DevBridge-Key: <token>`），在 `settings.json` 中配置
- **CORS**: 白名单配置，默认只允许 `localhost`
- **原始数据发送**: 手动发送 Raw Hex 需要二次确认
- **插件沙箱**: 热加载的插件/协议先经过 Schema 验证 + examples 自测后才投入使用
- **配置导入**: 导入前显示 diff 预览，用户确认后才应用

---

## 十九、未来趋势预留

| 技术 | 当前策略 | 预留方式 |
|------|---------|---------|
| **WebUSB / Web Serial / Web Bluetooth** | Node.js 后端统一处理 | 浏览器原生 API 作为 fallback Transport，在支持的环境下可绕过 Node.js 后端 |
| **Matter 协议** | 暂不实现 | Transport 层预留 `MatterTransport` 接口占位 |
| **USB4 / Thunderbolt** | 与 USB Native 兼容 | libusb 层天然兼容 |
| **gRPC** | 使用 REST + WebSocket | 性能极致场景可替换 REST 为 gRPC（`@grpc/grpc-js`） |
| **Bun / Deno 运行时** | Node.js 20 LTS | Transport 层避免使用 Node.js 私有 API，保留迁移可能 |

---

*文档版本: v1.0.0 | 项目: DevBridge | 生成日期: 2026-02-28*
