# Skill: Microservice Design — 微服务架构设计

## Preconditions

当以下情况发生时激活本 skill：
- 用户讨论服务进程拆分、进程/线程隔离策略
- 用户实现或修改 Service 模块（GatewayService、DeviceManager 等）
- 用户涉及跨 Service 通信、IPC 消息设计
- 用户讨论崩溃恢复、Watchdog、健康检查
- 用户讨论 Worker Thread 或 Child Process 的创建与管理

---

## Instructions

### Service 接口规范

每个 Service 模块必须实现 `IService` 接口：

```typescript
interface ServiceHealth {
  status: 'healthy' | 'degraded' | 'critical';
  details?: Record<string, unknown>;
}

interface ServiceMetrics {
  uptime: bigint;           // process.hrtime.bigint() 启动时间
  messageCount: number;     // 处理的 IPC 消息总数
  errorCount: number;       // 发生的错误总数
  [key: string]: unknown;   // 自定义指标
}

interface IService {
  readonly serviceId: string;     // 全局唯一，如 'device-manager'
  start(): Promise<void>;
  stop(): Promise<void>;          // graceful shutdown
  health(): Promise<ServiceHealth>;
  metrics(): ServiceMetrics;
}
```

### 进程隔离策略

**三层混合模式**：

**层级 1 — 核心 Service（各自独立 Worker Thread）**

`GatewayService` 独占主线程；`DeviceManager`、`CommandDispatcher`、`ProtocolEngine`、`ObservabilityService` 等核心 Service 各自运行在独立 Worker Thread 中，通过 `MessagePort` 与主线程通信：

```typescript
import { Worker } from 'worker_threads';

// 主线程启动各核心 Service Worker
const deviceManagerWorker = new Worker('./services/device-manager.worker.js');
const commandWorker = new Worker('./services/command-dispatcher.worker.js');
const protocolWorker = new Worker('./services/protocol-engine.worker.js');

// Worker 间直接通信（MessageChannel 点对点，避免主线程中转）
const { port1, port2 } = new MessageChannel();
deviceManagerWorker.postMessage({ type: 'BIND_PORT', port: port1 }, [port1]);
commandWorker.postMessage({ type: 'BIND_PORT', port: port2 }, [port2]);
```

**层级 2 — Driver Worker（按 Plugin Manifest `isolation` 字段决定）**

```typescript
// Plugin Manifest 中声明隔离方式
interface PluginManifest {
  isolation: 'worker-thread' | 'child-process'; // 默认 worker-thread
  // BLE、libusb 等不稳定驱动强烈建议声明 child-process
}
```

**Worker Thread**（适合稳定驱动：标准 HID、TCP）：
```typescript
import { Worker, isMainThread, parentPort } from 'worker_threads';

const worker = new Worker('./driver-worker.js', {
  workerData: { deviceId, pluginConfig }
});
worker.on('message', (msg: IPCMessage) => handleMessage(msg));
worker.on('error', (err) => watchdog.handleWorkerCrash(worker, err));
```

**Child Process**（适合不稳定/关键驱动：libusb、BLE）：
```typescript
import { fork } from 'child_process';

const child = fork('./driver-process.js', [], {
  env: { DEVICE_ID: deviceId, PLUGIN_CONFIG: JSON.stringify(config) }
});
child.on('message', (msg: IPCMessage) => handleMessage(msg));
child.on('exit', (code) => watchdog.handleProcessExit(child, code));
```

**层级 3 — Plugin handler.ts（强制 Child Process）**

含 `handler.ts` 的插件，无论 `isolation` 字段如何声明，`PluginLoader` 一律使用 `child_process.fork()` 加载：

```typescript
// PluginLoader 加载逻辑
if (plugin.hasHandler) {
  // 强制 Child Process，无视 manifest.isolation 声明
  const handlerProcess = fork(plugin.handlerPath, [], {
    env: { PLUGIN_MANIFEST: JSON.stringify(plugin.manifest) }
  });
  // handler 通过 IPC Channel 与 DeviceManager Worker 通信
  handlerProcess.on('message', (msg: IPCMessage) =>
    deviceManagerWorker.postMessage(msg)
  );
}
```

### IPC 消息协议

所有进程/线程间通信使用统一格式：

```typescript
interface IPCMessage<T = unknown> {
  type: string;             // 消息类型（大写 SNAKE_CASE）
  source: string;           // 发送方 serviceId
  target: string;           // 接收方 serviceId（'*' 为广播）
  correlationId: string;    // UUID v4，请求-响应追踪
  payload: T;               // 业务数据
  timestamp: bigint;        // process.hrtime.bigint()
}
```

**标准消息类型列表：**

| 类型 | 方向 | 说明 |
|------|------|------|
| `COMMAND_SEND` | Gateway → Dispatcher | 发送命令 |
| `COMMAND_RESPONSE` | Dispatcher → Gateway | 命令响应 |
| `DATA_RECEIVED` | Driver → DeviceManager | 设备数据上报 |
| `DEVICE_STATUS_CHANGED` | DeviceManager → Gateway | 设备状态变更 |
| `HEALTH_PING` | Watchdog → Service | 健康检查请求 |
| `HEALTH_PONG` | Service → Watchdog | 健康检查响应 |
| `LOG_ENTRY` | 任意 → LogManager | 日志条目 |
| `METRICS_UPDATE` | 任意 → Observability | 指标更新 |

### ServiceRegistry — 服务注册与发现

```typescript
class ServiceRegistry {
  private services = new Map<string, IService>();

  register(service: IService): void {
    this.services.set(service.serviceId, service);
  }

  get<T extends IService>(serviceId: string): T {
    const service = this.services.get(serviceId);
    if (!service) throw new Error(`SERVICE_NOT_FOUND: ${serviceId}`);
    return service as T;
  }

  async startAll(): Promise<void> {
    // 按依赖拓扑顺序启动
    const order = ['observability', 'diagnostic-engine', 'notification-manager',
                   'protocol-engine', 'plugin-loader',
                   'device-manager', 'command-dispatcher', 'gateway'];
    for (const id of order) {
      await this.get(id).start();
    }
  }

  async stopAll(): Promise<void> {
    // 逆序关闭
    const order = ['gateway', 'command-dispatcher', 'device-manager',
                   'plugin-loader', 'protocol-engine',
                   'notification-manager', 'diagnostic-engine', 'observability'];
    for (const id of order) {
      await this.get(id).stop();
    }
  }
}
```

### Watchdog — 进程守护与自愈

```typescript
class Watchdog {
  private readonly HEALTH_CHECK_INTERVAL = 1000;    // ms
  private readonly HEALTH_TIMEOUT = 3000;            // ms
  private readonly MAX_RESTARTS = 5;
  private restartCounts = new Map<string, number>();
  private backoffMs = new Map<string, number>();

  startMonitoring(): void {
    setInterval(() => this.checkAllServices(), this.HEALTH_CHECK_INTERVAL);
  }

  private async checkAllServices(): Promise<void> {
    for (const [id, service] of registry.entries()) {
      const health = await Promise.race([
        service.health(),
        sleep(this.HEALTH_TIMEOUT).then(() => ({ status: 'critical' as const }))
      ]);
      if (health.status === 'critical') {
        await this.handleCritical(id, service);
      }
    }
  }

  private async handleCritical(serviceId: string, service: IService): Promise<void> {
    const restarts = this.restartCounts.get(serviceId) ?? 0;
    if (restarts >= this.MAX_RESTARTS) {
      notificationManager.notify('critical', 'watchdog',
        `Service ${serviceId} permanently failed after ${restarts} restarts`);
      return;
    }
    // 指数退避重启
    const delay = Math.min(1000 * Math.pow(2, restarts), 30_000);
    await sleep(delay);
    await service.stop().catch(() => {});
    await service.start();
    this.restartCounts.set(serviceId, restarts + 1);
  }
}
```

### Graceful Shutdown

```typescript
process.on('SIGTERM', async () => {
  logger.info({}, 'graceful_shutdown_started');
  // 1. 停止接受新连接
  await gatewayService.stopAcceptingConnections();
  // 2. 等待进行中的命令完成（最长 5s）
  await commandDispatcher.drainCommands(5000);
  // 3. 逐个停止 Service（逆序）
  await registry.stopAll();
  // 4. 退出
  process.exit(0);
});
```

---

## Constraints

- Service 之间只通过 `IPCMessage` 通信，**禁止**直接调用另一个 Service 的方法引用
- **禁止** SharedArrayBuffer 在 Service 之间共享（仅限 Driver Worker 内部二进制数据传递）
- 任何 Service 的 `stop()` 方法必须幂等（多次调用不报错）
- `health()` 方法必须同步返回（不得 await），否则 Watchdog 超时判定会不准确
- Worker Thread 中发生的未捕获异常必须通过 `parentPort.postMessage({ type: 'LOG_ENTRY', payload: { level: 'error', ... } })` 上报，不得 `console.error`
- Child Process fork 时必须传入完整的 `pluginConfig`，不得在子进程中访问主进程文件系统

---

## Examples

### Worker Thread Driver 启动示例

```typescript
// main process: device-manager/driver-launcher.ts
export function launchDriverWorker(deviceId: string, plugin: PluginManifest): Worker {
  const worker = new Worker(
    new URL('./driver-worker-runner.js', import.meta.url),
    { workerData: { deviceId, plugin } }
  );
  worker.on('message', (msg: IPCMessage) => {
    ipcRouter.route(msg); // 路由到 CommandDispatcher / ObservabilityService
  });
  worker.on('error', (err) => {
    watchdog.handleWorkerCrash(deviceId, err);
  });
  return worker;
}

// worker: driver-worker-runner.ts
import { workerData, parentPort } from 'worker_threads';
const { deviceId, plugin } = workerData;

const driver = await PluginLoader.loadPlugin(plugin);
await driver.start();

driver.on('data', (event: DeviceEvent) => {
  parentPort!.postMessage({
    type: 'DATA_RECEIVED',
    source: deviceId,
    target: 'device-manager',
    correlationId: crypto.randomUUID(),
    payload: event,
    timestamp: process.hrtime.bigint()
  } satisfies IPCMessage<DeviceEvent>);
});
```
