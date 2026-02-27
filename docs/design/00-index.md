# DevBridge — 详细设计文档索引

> **版本**: v1.0.0 | **日期**: 2026-02-28  
> **用途**: 本目录下文档规定各模块**实现方式**，是 `docs/prompt-requirements.md` 的具体化。  
> **与其他文档的关系**:
> - `docs/prompt-requirements.md` → 规定"做什么"（需求）
> - `.ai/skills/*.md` → AI 提示上下文（辅助工具）
> - `docs/design/*.md` → 规定"怎么做"（本目录，面向实现者）

---

## 文档导航

| # | 文档 | 主题 | 核心接口 |
|---|------|------|---------|
| 01 | [Transport 层](./01-transport-layer.md) | 六种 Transport 接口、Config Schema、错误码 | `ITransport`, `TransportFactory` |
| 02 | [Protocol DSL 引擎](./02-protocol-dsl.md) | Schema 完整定义、运行时流水线、热加载 | `IProtocol`, `ProtocolSchema` |
| 03 | [DeviceManager](./03-device-manager.md) | 设备状态机、扫描器、DeviceChannel 生命周期 | `DeviceManager`, `DeviceChannel` |
| 04 | [CommandDispatcher](./04-command-dispatcher.md) | 双通道数据流、广播策略、IPC 消息全集 | `CommandDispatcher`, `IPCMessage` |
| 05 | [GatewayService](./05-gateway-service.md) | REST API 完整表格、WebSocket 事件全集、认证 | `GatewayService`, REST/WS API |
| 06 | [PluginLoader](./06-plugin-loader.md) | Manifest Schema、生命周期钩子、动态热更新 | `PluginLoader`, `IDevicePlugin` |
| 07 | [Frontend MW/UI](./07-frontend-mw-ui.md) | MW 模块接口、Store Schema、组件树 | `WsClient`, `useDeviceStore` |

---

## 公共约定

### IPCMessage 信封格式

所有 Worker Thread / Child Process 之间的通信必须使用此信封：

```typescript
// packages/shared/src/types/ipc.d.ts

interface IPCMessage<T = unknown> {
  type:          string;    // UPPER_SNAKE_CASE，如 COMMAND_SEND
  source:        string;    // 发送方 serviceId，如 'command-dispatcher'
  target:        string;    // 接收方 serviceId；'*' = 广播到所有 Worker
  correlationId: string;    // UUID v4，全链路追踪
  payload:       T;
  timestamp:     bigint;    // process.hrtime.bigint()，纳秒级
}
```

**构造工具函数：**

```typescript
function createIPCMessage<T>(
  type:          string,
  source:        string,
  target:        string,
  payload:       T,
  correlationId?: string
): IPCMessage<T> {
  return {
    type,
    source,
    target,
    correlationId: correlationId ?? crypto.randomUUID(),
    payload,
    timestamp: process.hrtime.bigint(),
  };
}
```

---

### 错误码域

| 域前缀 | 模块 | 文档 |
|--------|------|------|
| `TRANSPORT_*` | Transport 层 | [01-transport-layer.md](./01-transport-layer.md) |
| `PROTOCOL_*` | Protocol DSL | [02-protocol-dsl.md](./02-protocol-dsl.md) |
| `DEVICE_*` | DeviceManager | [03-device-manager.md](./03-device-manager.md) |
| `COMMAND_*` | CommandDispatcher | [04-command-dispatcher.md](./04-command-dispatcher.md) |
| `GATEWAY_*` | GatewayService | [05-gateway-service.md](./05-gateway-service.md) |
| `PLUGIN_*` | PluginLoader | [06-plugin-loader.md](./06-plugin-loader.md) |
| `SYSTEM_*` | 基础设施（日志、Sentry、健康检查）| — |

**错误响应统一格式：**

```typescript
interface ErrorResponse {
  error: {
    code:     string;    // 域前缀_描述，如 DEVICE_NOT_FOUND
    message:  string;    // 人类可读
    details?: unknown;   // 仅开发/调试模式返回
  };
}
```

---

### 公共类型路径

| 类型 | 路径 | 包 |
|------|------|----|
| `TransportType`, `ITransport`, `TransportConfig` | `packages/shared/src/types/transport.d.ts` | `@devbridge/shared` |
| `DeviceInfo`, `DeviceStatus`, `DeviceEvent` | `packages/shared/src/types/device.d.ts` | `@devbridge/shared` |
| `IPCMessage` | `packages/shared/src/types/ipc.d.ts` | `@devbridge/shared` |
| `ProtocolSchema`, `IProtocol`, `DecodedMessage` | `packages/shared/src/types/protocol-dsl.d.ts` | `@devbridge/shared` |
| `PluginManifest`, `IDevicePlugin` | `packages/shared/src/types/plugin.d.ts` | `@devbridge/shared` |
| `PluginContext` | `packages/plugin-sdk/src/index.ts` | `@devbridge/plugin-sdk` |

---

### Service 启动 / 关闭顺序

```
启动顺序（依赖拓扑）:
  1. observability        ← 最先启动，其他服务依赖日志/metrics
  2. diagnostic-engine    ← 环境检查
  3. notification-manager ← 通知基础设施
  4. protocol-engine      ← 协议运行时
  5. plugin-loader        ← 插件加载（依赖 protocol-engine）
  6. device-manager       ← 设备管理（依赖 plugin-loader）
  7. command-dispatcher   ← 命令路由（依赖 device-manager）
  8. gateway              ← 最后启动，对外暴露服务

关闭顺序（逆序）:
  1. gateway              ← 最先关闭，停止接受新连接
  2. command-dispatcher   ← 排水进行中的命令（最多 5s）
  3. device-manager       ← 断开所有设备
  4. plugin-loader        ← 终止所有 Child Process
  5. protocol-engine
  6. notification-manager
  7. diagnostic-engine
  8. observability        ← 最后关闭，确保所有日志落盘
```

---

### IService 基础接口

所有 Worker Thread 中运行的 Service 必须实现：

```typescript
interface ServiceHealth {
  status:   'healthy' | 'degraded' | 'critical';
  details?: Record<string, unknown>;
}

interface ServiceMetrics {
  uptime:       bigint;   // process.hrtime.bigint() 启动时间
  messageCount: number;   // 处理的 IPC 消息总数
  errorCount:   number;
  [key: string]: unknown; // 自定义指标
}

interface IService {
  readonly serviceId: string;
  start():             Promise<void>;
  stop():              Promise<void>;
  health():            Promise<ServiceHealth>;
  metrics():           ServiceMetrics;
}
```
