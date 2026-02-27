# DevBridge — 全局开发指令

> 本文件适用于所有 AI 辅助开发工具（GitHub Copilot、Claude Code、Cursor 等）。  
> 这些指令定义整个项目的编码约定、架构边界和禁止事项，具有最高优先级。

---

## 一、项目基本信息

- **项目名称**: DevBridge — Universal Hardware Interface Platform
- **核心定位**: Node.js 后台服务 + React 浏览器控制面板，管理多种外设通信
- **语言**: TypeScript 5.x 严格模式（`"strict": true`），所有代码必须有完整类型
- **运行时**: Node.js ≥ 20 LTS
- **包管理**: pnpm workspace（Monorepo）
- **测试**: Vitest（单元测试）+ Playwright（E2E）

---

## 二、Monorepo 结构约定

```
packages/
  server/          # Node.js 后端服务（@DevBridge/server）
  client/          # React 前端应用（@DevBridge/client）
  shared/          # 纯类型定义（@DevBridge/shared）——零运行时依赖
  plugins/         # 内置插件（@DevBridge/plugins）
  plugin-sdk/      # 插件开发 SDK（@devbridge/plugin-sdk）
```

- `shared` 包仅允许包含 **纯 TypeScript 类型定义（`.d.ts`）**，不得包含任何运行时代码
- `shared` 包不得引用 `Buffer`、`node-hid`、`serialport`、`usb` 等任何 Node.js 服务端专属 API
- `HID Report Descriptor Parser` 位于 `server/src/transport/usb-hid/hid-parser/`，不得放入 `shared`
- `Protocol DSL 运行时引擎` 位于 `server/src/protocol/dsl-runtime/`，不得放入 `shared`
- `server` 可依赖 `shared`，不得依赖 `client`
- `client` 可依赖 `shared`，不得依赖 `server`
- 插件包（`plugins/`）只能依赖 `shared`，不得依赖 `server` 内部模块

---

## 三、命名规范

| 类型 | 规范 | 示例 |
|------|------|------|
| 文件名（TS 源码） | `kebab-case` | `device-manager.ts` |
| 文件名（React 组件）| `PascalCase` | `DeviceCard.tsx` |
| 类名 | `PascalCase` | `DeviceManager` |
| 接口名 | `I` + `PascalCase` | `ITransport`, `IDevicePlugin` |
| 枚举名 | `PascalCase` | `DeviceStatus` |
| 枚举值 | `UPPER_SNAKE_CASE` | `DeviceStatus.CONNECTED` |
| 函数/方法名 | `camelCase` | `startWatching()` |
| 常量 | `UPPER_SNAKE_CASE` | `MAX_RETRY_COUNT` |
| 事件名 | `domain:action` | `device:attached` / `device:status-changed` |
| IPC 消息类型 | `DOMAIN_ACTION` | `COMMAND_SEND` / `DATA_RECEIVED` |
| 错误码 | `DOMAIN_DESCRIPTION` | `DEVICE_NOT_FOUND` / `PROTOCOL_PARSE_FAILED` |
| API 路由 | `/api/v1/resource` | `/api/v1/devices/:id/history` |

---

## 四、架构核心约定

### 4.1 Transport / Protocol 严格分离

- **禁止** 在 Transport 实现中编写任何协议解析逻辑（帧头解析、校验计算、字段提取）
- **禁止** 在 Protocol 实现中执行任何设备连接/断开操作
- Transport 只暴露两个方向：`send(buffer: Buffer)` 和 `on('data', callback)`
- Protocol 只暴露两个方向：`encode(command) → Buffer` 和 `decode(buffer) → Message`
- 两者通过 `DeviceChannel` 在运行时组合绑定

### 4.2 Plugin 边界

- **禁止** 在 Plugin 的 `handler.ts` 中直接调用底层 Transport API（`node-hid`, `serialport` 等）
- Plugin 只能通过 `IDeviceChannel` 接口与设备交互
- Plugin 之间**禁止**互相依赖或通信
- 每个 Plugin 必须实现 `IDevicePlugin` 接口，包含完整生命周期钩子

### 4.3 Service 间通信

- **禁止** Service 之间共享内存引用（除 SharedArrayBuffer，仅用于 Driver Worker 内部二进制传输）
- Service 间只通过 `IPCMessage` 消息格式通信（MessagePort 或 IPC Channel）
- 所有 IPC 消息必须携带 `correlationId`（UUID v4）用于链路追踪
- 任何单个 Service 崩溃不得导致主进程退出

### 4.4 设备事件流向

```
Transport(原始字节) → Protocol(解码) → EventBus → WebSocket → Frontend
                          ↑
              [PacketTap 可选，关闭时零开销]
```

- **禁止** 跳过 Protocol Layer 将原始字节直接推送到前端（DevTools 抓包除外，并需明确标注）
- 前端收到的所有设备数据必须是 `DeviceEvent` 格式

---

## 五、性能关键约束（热路径）

以下规则适用于设备通信的热路径（高频读写循环）：

- **禁止** 使用 `JSON.stringify` / `JSON.parse`，改用 Buffer 二进制协议
- **禁止** 使用 `console.log`，改用 pino ring buffer 异步日志
- **禁止** 在 Driver 通信循环中分配大对象，使用预分配 Buffer Pool
- **禁止** 使用 `new Date()` / `Date.now()`，改用 `process.hrtime.bigint()`
- 并行广播命令使用 `Promise.allSettled()`，不用 `Promise.all()`（避免因单设备失败导致全体失败）
- `SharedArrayBuffer` 操作必须配合 `Atomics` API 保证线程安全
- 命令广播必须有超时机制，默认 100ms，超时设备单独降级

---

## 六、错误处理规范

- 所有错误必须包含唯一 `errorCode`（枚举值），格式 `DOMAIN_DESCRIPTION`
- 错误分域：`DEVICE_*` / `PROTOCOL_*` / `TRANSPORT_*` / `SYSTEM_*` / `PLUGIN_*`
- 可恢复错误：记录 `logger.warn()` + 触发 NotificationManager 通知 + 自动重试
- 不可恢复错误：记录 `logger.error()` + Sentry 上报 + 通知前端 + 执行降级策略
- **禁止** 静默吞噬异常（空 `catch` 块）
- 错误对象必须保留原始 `cause`（使用 `new Error('message', { cause: originalError })`）

---

## 七、日志规范

- 所有模块使用 `createLogger(module: string)` 工厂函数创建 pino child logger
- **禁止** 直接调用 `console.log` / `console.error`（CI 中会报错）
- 日志消息使用英文 key + 结构化 context 对象，**禁止**拼接字符串
  ```typescript
  // ✅ 正确
  logger.info({ deviceId, status }, 'device_status_changed');
  // ❌ 错误
  logger.info(`Device ${deviceId} status changed to ${status}`);
  ```
- Worker / Child Process 日志必须通过 IPC 传回主进程 `LogManager` 统一写入
- 热路径（设备读写循环）使用 `logger.trace()`，生产环境默认级别 `info`

---

## 八、测试规范

- 每个 Service 模块必须有 Vitest 单元测试，覆盖率 ≥ 80%
- Transport 实现必须有 Mock 测试（不真实连接硬件）
- Protocol DSL 的每个 Schema 必须通过 `examples` 字段的自动化验证
- E2E 测试（Playwright）覆盖：设备列表显示、命令发送、热插拔事件

---

## 九、TypeScript 严格模式要求

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  }
}
```

- **禁止**使用 `any`（使用 `unknown` 并收窄类型）
- **禁止**使用 `!` 非空断言（除非有注释说明原因）
- 所有 `async` 函数必须有明确的返回类型标注

---

## 十、提交规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat(transport): add BLE GATT multi-characteristic subscription
fix(device-manager): handle reconnect race condition on rapid detach
perf(command): use SharedArrayBuffer for zero-copy broadcast
docs(protocol-dsl): add Modbus RTU schema example
test(usb-hid): add report descriptor parser unit tests
```

---

## 十一、API 设计约定

- 所有 REST API 以 `/api/v1/` 为前缀
- 使用 HTTP 标准状态码
- 错误响应格式统一：`{ error: { code: string, message: string, details?: unknown } }`
- 成功响应格式统一：`{ data: T, metadata?: { total?: number, page?: number } }`
- WebSocket 消息格式：`{ type: string, payload: T, timestamp: number }`

---

## 十二、新增 Transport 类型检查清单

新增一种 Transport 类型时，以下项目必须同步完成：

- [ ] 实现 `ITransport` 接口（含双通道方法）
- [ ] 实现对应的 `IDeviceScanner`（枚举 + 热插拔监听）
- [ ] 在 `DiagnosticEngine` 注册对应的环境检查项
- [ ] 在需求文档的外设通信协议矩阵中添加行
- [ ] 提供至少一个示例 Plugin（manifest + protocol schema）
- [ ] 编写 Transport 的 Mock 单元测试

---

## 十三、禁止事项速查

| 禁止行为 | 正确替代 |
|---------|---------|
| `console.log` 在生产代码中 | `logger.info(context, 'message_key')` |
| `any` 类型 | `unknown` + 类型收窄 |
| Transport 内解析协议 | 在 Protocol Layer 解析 |
| Plugin 直接调用 `node-hid` | 通过 `IDeviceChannel` 接口 |
| Service 间共享内存引用 | 通过 `IPCMessage` 消息通信 |
| `JSON.stringify` 在热路径 | Buffer 二进制编码 |
| `Promise.all()` 广播命令 | `Promise.allSettled()` |
| `Date.now()` 时间戳 | `process.hrtime.bigint()` |
| 空 `catch` 块 | 明确处理或向上抛出 |
| 硬编码设备 VID/PID | 在 Plugin Manifest 中声明 |
| 直接 `Buffer.alloc()` 在热路径 | Buffer Pool 预分配 |
| `rawBuffer` Base64 编码入 JSON 字段 | Binary WebSocket Frame 独立传输 |
| 含 `handler.ts` 的插件在主进程或 Worker Thread 加载 | 强制使用 `child_process.fork()` 隔离 |
| 将 `hid-parser` 或 `protocol-dsl` 运行时放入 `shared` 包 | 放入 `server/src/` 相应目录 |
| 动态代码 fork 时继承父进程 `env` | 只传递 `PLUGIN_ID` 等必要字段，防止密钥/token 泄露 |
| 动态代码跳过 esbuild 直接 `require()` 执行 | 必须经过 esbuild external 白名单编译验证 |
| 动态代码中使用 `eval` / `new Function` | fork 时强制加载 `--disallow-code-generation` |
| 旧 Child Process 排水超时不强制终止 | 2s 超时后强制 SIGKILL，防止僵尸进程阻塞热更新 |
| 在 `PluginLoader` 以外调用 `child_process.fork()` | `fork()` 只能在 `PluginLoader` 内部调用，其他模块通过 MessagePort IPC 发送命令触发 |
| 在主进程或 Worker Thread 中 `require('node-ffi-napi')` | 必须在 `child_process.fork()` 隔离的 Child Process 内加载 |
| FFI Plugin Manifest 未声明 `"isolation": "child-process"` | `"transport": "ffi"` 必须配套 `"isolation": "child-process"` |
| FFI Callback 对象未持久化引用 | 必须赋值给长期变量（如 `transport._callbackRef`）防止 GC 回收导致崩溃 |
| `unstable` DLL 与其他插件共享 Child Process | `stability: "unstable"` 的 DLL 必须独占一个 Child Process |