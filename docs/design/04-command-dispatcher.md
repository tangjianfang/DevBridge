# 设计文档 04 — CommandDispatcher

> **所属模块**: `packages/server/src/command-dispatcher/`  
> **线程模型**: 运行在独立的 Worker Thread（`CommandDispatcherWorker`）  
> **类型定义**: `packages/shared/src/types/command.d.ts`

---

## 1. 核心类型

```typescript
// packages/shared/src/types/command.d.ts

export interface CommandResult {
  deviceId:      string;
  correlationId: string;           // UUIDv4，由 GatewayService 在请求时生成
  success:       boolean;
  data?:         Record<string, unknown>;  // protocol.decode 后的 fields
  rawBuffer?:    Buffer;
  durationMs:    number;           // 从发送到响应的耗时
  errorCode?:    string;
  errorMessage?: string;
}

export interface BroadcastResult {
  correlationId: string;
  results: Array<{
    deviceId: string;
    success:  boolean;
    data?:    Record<string, unknown>;
    errorCode?: string;
  }>;
  succeededCount: number;
  failedCount:    number;
  totalMs:        number;
}
```

---

## 2. CommandDispatcher 类

```typescript
// packages/server/src/command-dispatcher/command-dispatcher.ts

const QUEUE_MAX_PER_DEVICE   = 32;
const DEFAULT_COMMAND_TIMEOUT = 5000;   // ms
const BROADCAST_PER_DEVICE_TIMEOUT = 100; // ms

export class CommandDispatcher implements IService {
  // 每个设备独立的命令队列（背压保护）
  private queues = new Map<string, Array<PendingCommand>>();

  async start(): Promise<void> { /* no-op：被动响应 IPC */ }
  async stop():  Promise<void> {
    for (const [, q] of this.queues) {
      for (const pending of q) {
        pending.reject(Object.assign(
          new Error('COMMAND_DISPATCH_FAILED: service stopping'),
          { errorCode: 'COMMAND_DISPATCH_FAILED' }
        ));
      }
    }
    this.queues.clear();
  }

  async health(): Promise<ServiceHealth> {
    return {
      status: 'ok',
      details: { pendingQueues: this.queues.size }
    };
  }

  handleIPCMessage(msg: IPCMessage): void {
    switch (msg.type) {
      case 'COMMAND_SEND':     this.dispatchCommand(msg.payload);   break;
      case 'COMMAND_BROADCAST': this.broadcastCommand(msg.payload); break;
      case 'DATA_RECEIVED':   this.resolveCommand(msg.payload);    break;
      case 'SUBSCRIBE_EVENTS': this.forwardSubscribe(msg.payload);  break;
    }
  }

  private async dispatchCommand(payload: {
    deviceId:      string;
    commandId:     string;
    params:        Record<string, unknown>;
    correlationId: string;
    timeoutMs?:    number;
  }): Promise<void> {
    const { deviceId, correlationId } = payload;

    // 背压检查
    const queue = this.queues.get(deviceId) ?? [];
    if (queue.length >= QUEUE_MAX_PER_DEVICE) {
      this.replyError(correlationId, 'COMMAND_QUEUE_FULL',
        `Device ${deviceId} command queue is full`);
      return;
    }

    const timeout = payload.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT;
    const startAt = Date.now();

    const pending = new Promise<CommandResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removePending(deviceId, correlationId);
        reject(Object.assign(
          new Error(`COMMAND_TIMEOUT: ${correlationId}`),
          { errorCode: 'COMMAND_TIMEOUT', correlationId }
        ));
      }, timeout);

      queue.push({ correlationId, resolve, reject, timer, startAt });
      this.queues.set(deviceId, queue);
    });

    // 转发到 DeviceManager Worker
    workerPort.postMessage({
      type: 'COMMAND_SEND', payload
    } satisfies IPCMessage);

    try {
      const result = await pending;
      workerPort.postMessage({
        type: 'COMMAND_RESULT', payload: result
      } satisfies IPCMessage);
    } catch (err) {
      const e = err as Error & { errorCode?: string };
      this.replyError(correlationId, e.errorCode ?? 'COMMAND_DISPATCH_FAILED', e.message);
    }
  }

  private async broadcastCommand(payload: {
    commandId:     string;
    params:        Record<string, unknown>;
    correlationId: string;
    deviceIds:     string[];
  }): Promise<void> {
    const { deviceIds, commandId, params, correlationId } = payload;
    const startAt = Date.now();

    const promises = deviceIds.map(deviceId =>
      this.dispatchSingleForBroadcast(deviceId, commandId, params)
    );

    const settled = await Promise.allSettled(
      promises.map(p =>
        Promise.race([
          p,
          new Promise<never>((_, rej) =>
            setTimeout(() =>
              rej(Object.assign(
                new Error('COMMAND_BROADCAST_TIMEOUT'),
                { errorCode: 'COMMAND_BROADCAST_TIMEOUT' }
              )),
              BROADCAST_PER_DEVICE_TIMEOUT
            )
          ),
        ])
      )
    );

    const results = settled.map((s, i) => ({
      deviceId: deviceIds[i],
      success:  s.status === 'fulfilled',
      data:     s.status === 'fulfilled' ? s.value?.data : undefined,
      errorCode: s.status === 'rejected'
        ? (s.reason as Error & { errorCode?: string }).errorCode
        : undefined,
    }));

    const broadcast: BroadcastResult = {
      correlationId,
      results,
      succeededCount: results.filter(r => r.success).length,
      failedCount:    results.filter(r => !r.success).length,
      totalMs:        Date.now() - startAt,
    };

    workerPort.postMessage({
      type: 'BROADCAST_RESULT', payload: broadcast
    } satisfies IPCMessage);
  }

  private resolveCommand(payload: {
    correlationId: string;
    deviceId:      string;
    message:       DecodedMessage;
    rawBuffer:     Buffer;
  }): void {
    const { deviceId, correlationId, message, rawBuffer } = payload;
    const queue = this.queues.get(deviceId);
    if (!queue) return;
    const idx = queue.findIndex(p => p.correlationId === correlationId);
    if (idx === -1) return;
    const [pending] = queue.splice(idx, 1);
    clearTimeout(pending.timer);
    pending.resolve({
      deviceId, correlationId,
      success:   true,
      data:      message.fields,
      rawBuffer,
      durationMs: Date.now() - pending.startAt,
    });
  }

  private removePending(deviceId: string, correlationId: string): void {
    const queue = this.queues.get(deviceId);
    if (!queue) return;
    const idx = queue.findIndex(p => p.correlationId === correlationId);
    if (idx !== -1) queue.splice(idx, 1);
  }

  private replyError(correlationId: string, code: string, msg: string): void {
    workerPort.postMessage({
      type: 'COMMAND_RESULT',
      payload: {
        correlationId, success: false,
        errorCode: code, errorMessage: msg, durationMs: 0,
      } satisfies CommandResult,
    } satisfies IPCMessage);
  }

  private forwardSubscribe(payload: unknown): void {
    workerPort.postMessage({ type: 'SUBSCRIBE_EVENTS', payload } satisfies IPCMessage);
  }

  private async dispatchSingleForBroadcast(
    deviceId:  string,
    commandId: string,
    params:    Record<string, unknown>
  ): Promise<CommandResult> {
    const correlationId = `broadcast-${crypto.randomUUID()}`;
    return new Promise<CommandResult>((resolve, reject) => {
      this.dispatchCommand({ deviceId, commandId, params,
        correlationId, timeoutMs: BROADCAST_PER_DEVICE_TIMEOUT })
        .then(resolve).catch(reject);
    });
  }
}

interface PendingCommand {
  correlationId: string;
  resolve:       (result: CommandResult) => void;
  reject:        (err: Error) => void;
  timer:         ReturnType<typeof setTimeout>;
  startAt:       number;
}
```

---

## 3. Command Channel 时序

```
Browser (WebSocket)
    │  POST /devices/:id/command
    │  或 WS: device:command { deviceId, commandId, params }
    │  correlationId = UUIDv4
    ▼
GatewayService (Main Thread)
    │  IPC → CommandDispatcher Worker
    │  type: COMMAND_SEND
    ▼
CommandDispatcher Worker
    │  入队列（检查 QUEUE_MAX_PER_DEVICE=32）
    │  启动超时定时器（5000ms）
    │  IPC → DeviceManager Worker
    │  type: COMMAND_SEND
    ▼
DeviceManager Worker
    │  DeviceChannel → protocol.encode(commandId, params)
    │  transport.send(encodedBuffer)
    ▼
Device Hardware
    │  处理命令
    │  返回响应字节
    ▼
transport.on('data') [DeviceManager Worker]
    │  protocol.decode(responseBuffer) → DecodedMessage
    │  IPC → CommandDispatcher Worker
    │  type: DATA_RECEIVED { deviceId, correlationId, message }
    ▼
CommandDispatcher Worker
    │  从队列中找到对应 correlationId
    │  clearTimeout(timer)
    │  IPC → GatewayService Main Thread
    │  type: COMMAND_RESULT { success, data, durationMs }
    ▼
GatewayService (Main Thread)
    │  WS 响应 → Browser
    │  type: device:response { correlationId, success, data }
    ▼
Browser
```

---

## 4. Event Channel 时序

```
Device Hardware
    │  主动上报数据（HID IN Report / Serial 数据流 / BLE Notification）
    ▼
transport.on('event') [DeviceManager Worker]
    │  DeviceChannel.onEvent(buf, endpointId)
    │  protocol.decode(buf) → DecodedMessage（可选）
    │  构建 BINARY_FRAME payload（含 deviceId, endpoint, buffer）
    │  IPC → GatewayService Main Thread
    │  type: BINARY_FRAME
    ▼
GatewayService (Main Thread)
    │  转发 Text Frame 给所有订阅了该 deviceId 的 WS Client
    │  type: device:event { deviceId, eventId, fields, timestamp }
    │
    │  若有 packettap:subscribe 存在：
    │  组装 Binary Frame（32-byte DBRG 头 + payload）
    │  WS binaryType → 发送 ArrayBuffer 给订阅的 WS Client
    ▼
Browser (WS 消息)
    │  Text Frame  → DeviceStore.appendEvent()
    │  Binary Frame → PacketTap buffer 解析（HexDump 组件）
```

---

## 5. IPC 消息表

### CommandDispatcher 接收（从 Main Thread / DeviceManager）

| type | payload | 来源 | 处理动作 |
|------|---------|------|---------|
| `COMMAND_SEND` | `{ deviceId, commandId, params, correlationId, timeoutMs? }` | Main Thread | 入队 + 转发给 DeviceManager |
| `COMMAND_BROADCAST` | `{ commandId, params, correlationId, deviceIds }` | Main Thread | 并发分发，Promise.allSettled |
| `DATA_RECEIVED` | `{ deviceId, correlationId, message, rawBuffer }` | DeviceManager | resolve 对应 Promise |
| `SUBSCRIBE_EVENTS` | `{ deviceId, endpointIds? }` | Main Thread | 透传给 DeviceManager |

### CommandDispatcher 发送（到 Main Thread）

| type | payload | 触发时机 |
|------|---------|---------|
| `COMMAND_RESULT` | `CommandResult` | 命令响应/超时/失败 |
| `BROADCAST_RESULT` | `BroadcastResult` | 广播全部 settle 后 |

---

## 6. 背压策略

| 参数 | 值 | 说明 |
|------|---|------|
| `QUEUE_MAX_PER_DEVICE` | 32 | 单设备最大排队命令数 |
| `DEFAULT_COMMAND_TIMEOUT` | 5000 ms | 单条命令超时 |
| `BROADCAST_PER_DEVICE_TIMEOUT` | 100 ms | 广播中每台设备超时 |

**队列满行为**：立即 reject，返回 `COMMAND_QUEUE_FULL` 错误，**不**丢弃队列中已有命令。  
**超时行为**：仅从队列移除该条命令，**不**取消 transport 层已发送的字节（底层无法撤回）。

---

## 7. 错误码全集 — COMMAND_*

| 错误码 | 触发场景 | HTTP 状态码 |
|--------|---------|-----------|
| `COMMAND_DEVICE_NOT_FOUND` | DeviceManager 中 deviceId 未命中 | 404 |
| `COMMAND_DISPATCH_FAILED` | 发送过程抛出未知错误 | 500 |
| `COMMAND_TIMEOUT` | 5000ms 内未收到响应 | 504 |
| `COMMAND_BROADCAST_TIMEOUT` | 广播中某台设备 100ms 内未响应 | 504 |
| `COMMAND_QUEUE_FULL` | 单设备队列已满 32 条 | 429 |
| `COMMAND_UNKNOWN` | commandId 不在协议 schema 中定义 | 400 |

---

## 8. 测试要点

- **正常时序**：dispatchCommand → 注入 DATA_RECEIVED → 断言 resolve 含正确字段
- **超时**：dispatchCommand 后不注入 DATA_RECEIVED，等待 5100ms，断言 reject `COMMAND_TIMEOUT`
- **队列满**：先入队 32 条不响应命令，第 33 条断言立即 reject `COMMAND_QUEUE_FULL`
- **stop() 幂等**：有 10 条 pending 命令时调用 stop()，断言全部被 reject，再次调用 stop() 不抛错
- **广播全成功**：3 台设备都在 100ms 内响应，断言 succeededCount=3，failedCount=0
- **广播部分超时**：第 2 台超时，断言 succeededCount=2，failedCount=1，第 1/3 台数据正确
- **correlationId 唯一匹配**：并发 2 条命令，响应乱序到达，断言各自 resolve 到正确 correlationId
