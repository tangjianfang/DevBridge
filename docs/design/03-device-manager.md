# 设计文档 03 — DeviceManager

> **所属模块**: `packages/server/src/device-manager/`  
> **线程模型**: 运行在独立的 Worker Thread（`DeviceManagerWorker`）  
> **类型定义**: `packages/shared/src/types/device.d.ts`

---

## 1. 核心类型

### 1.1 DeviceStatus

```typescript
// packages/shared/src/types/device.d.ts

export type DeviceStatus =
  | 'unknown'         // 初始/未知
  | 'scanning'        // 扫描中（尚未识别）
  | 'identified'      // 识别完成（有 Protocol + Plugin 匹配）
  | 'connecting'      // 正在建立传输连接
  | 'connected'       // 已连接，可收发数据
  | 'disconnected'    // 已断开（非意外，正常关闭或等待重连）
  | 'reconnecting'    // 正在执行自动重连
  | 'detached'        // 物理拔出（USB/BLE）
  | 'removed'         // 手动移除或永久失联
  | 'error';          // 不可恢复错误
```

### 1.2 DeviceInfo

```typescript
export interface DeviceInfo {
  deviceId:       string;       // '{transportType}:{fingerprintHash8}'
                                // 例："usb-hid:a3f2c1d7"
  transportType:  TransportType;
  status:         DeviceStatus;
  name:           string;       // 优先 plugin.manifest.name，否则 OS 名称
  vendorId?:      number;
  productId?:     number;
  serialNumber?:  string;
  address:        string;       // 原始地址（路径/MAC/IP:port）
  protocolName?:  string;       // 匹配到的协议名称
  pluginId?:      string;       // 匹配到的插件 ID
  connectedAt?:   number;       // 连接时刻 timestamp
  lastSeenAt:     number;       // 最近活跃 timestamp
  reconnectCount: number;       // 本次连接周期累计重连次数
  metadata?:      Record<string, unknown>; // Plugin 可写入的扩展信息
}
```

### 1.3 DeviceEvent

```typescript
export interface DeviceEvent {
  deviceId:   string;
  eventId:    string;           // Protocol Schema 中定义的事件名
  fields:     Record<string, unknown>;
  rawBuffer:  Buffer;
  timestamp:  number;
}
```

---

## 2. 设备状态机

### 2.1 状态转换图

```
                       ┌─────────────────────────────────────┐
                       │                                     │
         scanner附加   │                           拔出/移除  │
  unknown ──────────► scanning ──识别失败──────────────────► removed
                       │
                       │ 识别成功（协议+插件匹配）
                       ▼
                   identified
                       │
                       │ connect() 调用
                       ▼
                   connecting ──────────── 连接失败 ──────► error
                       │
                       │ 连接成功
                       ▼
                   connected ◄───────────────────────────────┐
                       │                                     │
                       │ 意外断开           重连成功          │
                       ▼                                     │
                  disconnected ──── 自动重连 ──► reconnecting┘
                       │               │
                       │ 物理拔出       │ 重连耗尽/手动移除
                       ▼               ▼
                   detached          removed
                       │
                       │ 重新插入（热插拔恢复）
                       ▼
                   scanning（重新识别）
```

### 2.2 状态对应 WS 事件

| 新状态 | 广播 WS event type | payload 关键字段 |
|--------|-------------------|-----------------|
| `scanning` | — | — |
| `identified` | `device:status` | `{ deviceId, status, protocolName, pluginId }` |
| `connecting` | `device:status` | `{ deviceId, status }` |
| `connected` | `device:connected` | `{ device: DeviceInfo }` |
| `disconnected` | `device:disconnected` | `{ deviceId, reason }` |
| `reconnecting` | `device:reconnecting` | `{ deviceId, attempt, nextRetryMs }` |
| `detached` | `device:status` | `{ deviceId, status: 'detached' }` |
| `removed` | `device:removed` | `{ deviceId }` |
| `error` | `device:status` | `{ deviceId, status: 'error', errorCode }` |

---

## 3. DeviceManager 类

```typescript
// packages/server/src/device-manager/device-manager.ts

export class DeviceManager implements IService {
  private devices  = new Map<string, DeviceChannel>();
  private scanners = new Map<TransportType, IDeviceScanner>();

  // ── IService ─────────────────────────────────────────────────
  async start(): Promise<void> {
    for (const [, scanner] of this.scanners) {
      scanner.on('attached', (raw) => this.onDeviceAttached(raw));
      scanner.on('detached', (addr) => this.onDeviceDetached(addr));
      scanner.startWatching();
    }
  }

  async stop(): Promise<void> {   // 幂等：多次调用安全
    for (const [, ch] of this.devices) await ch.close('manager-stop');
    for (const [, sc] of this.scanners) sc.stopWatching();
  }

  async health(): Promise<ServiceHealth> {
    return {
      status:  'ok',
      details: { connectedDevices: this.countByStatus('connected') }
    };
  }

  // ── 公开 API（供 CommandDispatcher 通过 IPC 调用）─────────────
  listDevices():             DeviceInfo[]  {
    return [...this.devices.values()].map(ch => ch.info);
  }
  getDevice(id: string):    DeviceChannel {
    const ch = this.devices.get(id);
    if (!ch) throw Object.assign(
      new Error(`DEVICE_NOT_FOUND: ${id}`),
      { errorCode: 'DEVICE_NOT_FOUND' }
    );
    return ch;
  }

  // ── IPC 消息处理 ──────────────────────────────────────────────
  handleIPCMessage(msg: IPCMessage): void {
    switch (msg.type) {
      case 'COMMAND_SEND':       this.routeCommand(msg);     break;
      case 'SUBSCRIBE_EVENTS':   this.subscribeEvents(msg);  break;
      case 'PLUGIN_LOADED':      this.assignPlugin(msg);     break;
      case 'PLUGIN_HOT_UPDATED': this.reassignPlugin(msg);   break;
    }
  }

  private onDeviceAttached(raw: RawDeviceInfo): void {
    const id = buildDeviceId(raw);
    if (this.devices.has(id)) return; // 去重
    const ch = DeviceChannel.create(raw, this.selectProtocol(raw));
    this.devices.set(id, ch);
    this.publishStatusIPC(ch.info);
  }

  private onDeviceDetached(address: string): void {
    for (const [id, ch] of this.devices) {
      if (ch.info.address === address) {
        ch.updateStatus('detached');
        this.publishStatusIPC(ch.info);
        break;
      }
    }
  }

  private countByStatus(s: DeviceStatus): number {
    return [...this.devices.values()].filter(c => c.info.status === s).length;
  }

  private publishStatusIPC(info: DeviceInfo): void {
    workerPort.postMessage({
      type: 'DEVICE_STATUS_CHANGED', payload: info
    } satisfies IPCMessage);
  }
}
```

---

## 4. DeviceChannel.create()（9 步流程）

```typescript
// packages/server/src/device-manager/device-channel.ts

export class DeviceChannel {
  info:      DeviceInfo;
  transport: ITransport;
  protocol:  IProtocol | null;
  plugin:    IDevicePlugin | null;

  private reconnector?: ReconnectController;

  static create(raw: RawDeviceInfo, proto: IProtocol | null): DeviceChannel {
    // 步骤 1：生成 DeviceInfo
    const info: DeviceInfo = {
      deviceId:       buildDeviceId(raw),
      transportType:  raw.transportType,
      status:         'scanning',
      name:           raw.name ?? 'Unknown Device',
      vendorId:       raw.vendorId,
      productId:      raw.productId,
      address:        raw.address,
      protocolName:   proto?.name,
      lastSeenAt:     Date.now(),
      reconnectCount: 0,
    };

    // 步骤 2：创建 Transport 实例
    const transport = TransportFactory.create(raw.transportType);

    // 步骤 3：创建 DeviceChannel
    const ch = new DeviceChannel(info, transport, proto);

    // 步骤 4：绑定 Transport 事件
    transport.on('data',  (buf, ep) => ch.onData(buf, ep));
    transport.on('event', (buf, ep) => ch.onEvent(buf, ep));
    transport.on('open',  ()        => ch.onOpen());
    transport.on('close', (reason)  => ch.onClose(reason));
    transport.on('error', (err)     => ch.onError(err));

    // 步骤 5：匹配协议（若 proto 非 null，标记 identified）
    if (proto) ch.updateStatus('identified');

    // 步骤 6：创建重连控制器
    ch.reconnector = new ReconnectController(ch, { maxAttempts: 10 });

    // 步骤 7：后台异步连接（不阻塞扫描线程）
    setImmediate(() => ch.connect());

    // 步骤 8：（Plugin 匹配延迟到 PluginLoader 返回 PLUGIN_LOADED IPC 时）
    // 步骤 9：返回 DeviceChannel 实例
    return ch;
  }

  async connect(): Promise<void> {
    this.updateStatus('connecting');
    try {
      await this.transport.connect(this.info as unknown as TransportConfig);
    } catch (err) {
      this.updateStatus('error');
      this.sendIPC('LOG_ENTRY', { level: 'error', message: String(err) });
    }
  }

  updateStatus(s: DeviceStatus, extra?: Partial<DeviceInfo>): void {
    this.info = { ...this.info, ...extra, status: s, lastSeenAt: Date.now() };
    workerPort.postMessage({
      type: 'DEVICE_STATUS_CHANGED', payload: this.info
    } satisfies IPCMessage);
  }

  private onData(buf: Buffer, _ep: string): void {
    if (!this.protocol) return;
    const msg = this.protocol.decode(buf);
    this.sendIPC('DATA_RECEIVED', { deviceId: this.info.deviceId, message: msg });
  }

  private onEvent(buf: Buffer, ep: string): void {
    const msg = this.protocol?.decode(buf);
    this.sendIPC('BINARY_FRAME', {
      deviceId: this.info.deviceId, endpoint: ep,
      buffer: buf, decoded: msg
    });
  }

  private onOpen(): void  { this.updateStatus('connected', { connectedAt: Date.now() }); }
  private onClose(reason?: string): void {
    this.updateStatus('disconnected');
    this.reconnector?.scheduleRetry(reason);
  }
  private onError(err: Error): void {
    this.sendIPC('LOG_ENTRY', { level: 'error', message: err.message });
  }

  async close(reason = 'manual'): Promise<void> {
    this.reconnector?.cancel();
    await this.transport.disconnect();
    this.updateStatus('removed');
  }

  private sendIPC<T>(type: string, payload: T): void {
    workerPort.postMessage({ type, payload } satisfies IPCMessage);
  }
}
```

---

## 5. ReconnectController（指数退避）

```typescript
// packages/server/src/device-manager/reconnect-controller.ts

export interface ReconnectOptions {
  maxAttempts:   number;    // 默认 10
  initialDelay:  number;    // ms，默认 1000
  multiplier:    number;    // 倍率，默认 1.5
  maxDelay:      number;    // ms，默认 30000
  jitter:        boolean;   // 随机抖动，默认 true
}

const DEFAULT_OPTIONS: ReconnectOptions = {
  maxAttempts: 10, initialDelay: 1000,
  multiplier: 1.5, maxDelay: 30000, jitter: true
};

export class ReconnectController {
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private cancelled = false;

  constructor(
    private channel: DeviceChannel,
    private opts:    Partial<ReconnectOptions> = {}
  ) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  scheduleRetry(reason?: string): void {
    if (this.cancelled) return;
    const o = this.opts as ReconnectOptions;
    if (this.attempt >= o.maxAttempts) {
      this.channel.updateStatus('removed');
      return;
    }

    // 退避公式：min(initialDelay * multiplier^attempt, maxDelay)
    let delay = Math.min(
      o.initialDelay * Math.pow(o.multiplier, this.attempt),
      o.maxDelay
    );
    if (o.jitter) delay *= (0.8 + Math.random() * 0.4); // ±20% 抖动
    delay = Math.round(delay);

    this.channel.updateStatus('reconnecting', {
      metadata: { attempt: this.attempt + 1, nextRetryMs: delay, reason }
    });
    workerPort.postMessage({
      type: 'DEVICE_STATUS_CHANGED',
      payload: { ...this.channel.info, reconnectCount: this.attempt + 1 }
    } satisfies IPCMessage);

    this.timer = setTimeout(async () => {
      if (this.cancelled) return;
      this.attempt++;
      await this.channel.connect();
    }, delay);
  }

  cancel(): void {
    this.cancelled = true;
    if (this.timer) clearTimeout(this.timer);
  }

  resetAttempts(): void { this.attempt = 0; }
}
```

---

## 6. IPC 消息表

### DeviceManager 接收（从 Main Thread）

| type | payload | 处理动作 |
|------|---------|---------|
| `COMMAND_SEND` | `{ deviceId, commandId, params, correlationId }` | 路由到 DeviceChannel，调用 protocol.encode + transport.send |
| `SUBSCRIBE_EVENTS` | `{ deviceId, endpointIds? }` | 调用 transport.subscribeAll() 或指定 endpointIds |
| `PLUGIN_LOADED` | `{ pluginId, deviceId }` | 将 Plugin 实例赋给 DeviceChannel |
| `PLUGIN_HOT_UPDATED` | `{ pluginId, deviceId }` | 替换 DeviceChannel 中的 Plugin 实例 |

### DeviceManager 发送（到 Main Thread）

| type | payload | 触发时机 |
|------|---------|---------|
| `DEVICE_STATUS_CHANGED` | `DeviceInfo` | 任何状态变更 |
| `DATA_RECEIVED` | `{ deviceId, correlationId?, message: DecodedMessage }` | 命令响应解码完成 |
| `BINARY_FRAME` | `{ deviceId, endpoint, buffer: Buffer, decoded? }` | 订阅事件帧到达 |
| `LOG_ENTRY` | `{ level, message, deviceId? }` | 错误/警告日志 |
| `METRICS_UPDATE` | `{ deviceId, bytesIn, bytesOut, timestamp }` | 每 5s 汇报一次 |

---

## 7. 设备 ID 生成

```typescript
// packages/server/src/device-manager/device-id.ts

import { createHash } from 'crypto';

export function buildDeviceId(raw: RawDeviceInfo): string {
  // fingerprintHash8：取 address + vendorId + productId + serialNumber 的 SHA-256 前 8 字符
  const fingerprint = `${raw.address}:${raw.vendorId ?? 0}:${raw.productId ?? 0}:${raw.serialNumber ?? ''}`;
  const hash = createHash('sha256').update(fingerprint).digest('hex').slice(0, 8);
  return `${raw.transportType}:${hash}`;
}
```

---

## 8. 错误码全集 — DEVICE_*

| 错误码 | 触发场景 | HTTP 状态码 |
|--------|---------|-----------|
| `DEVICE_NOT_FOUND` | getDevice() 未命中 | 404 |
| `DEVICE_NOT_CONNECTED` | 设备当前非 connected 状态 | 409 |
| `DEVICE_ALREADY_CONNECTED` | 尝试重复连接 | 409 |
| `DEVICE_CONNECT_FAILED` | transport.connect() 抛错 | 500 |
| `DEVICE_COMMAND_FAILED` | 命令发送/响应流程失败 | 500 |
| `DEVICE_PROTOCOL_MISSING` | 设备无匹配协议，无法编解码 | 422 |
| `DEVICE_PLUGIN_MISSING` | 设备无匹配插件 | 404 |
| `DEVICE_RECONNECT_EXHAUSTED` | 超过 maxAttempts，状态转 removed | 503 |

---

## 9. 测试要点

- **状态机全路径**：scanning → identified → connecting → connected → disconnected → reconnecting → connected（恢复）
- **reconnect 退避**：验证第 n 次重连间隔 ≈ `1000 * 1.5^n`（忽略 jitter），且不超 30000ms
- **maxAttempts**：第 11 次不调用 connect()，改为 updateStatus('removed')
- **detach 恢复**：MockScanner 先 'detached' 后再 'attached' 同地址，断言复用同 deviceId
- **buildDeviceId 稳定性**：相同 raw 输入两次调用，返回相同 deviceId
- **close() 幂等**：连续调用 2 次 close()，不抛错，状态不重复变更
