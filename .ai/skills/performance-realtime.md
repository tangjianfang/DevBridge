# Skill: Performance & Realtime — 高性能低延迟设计

## Preconditions

当以下情况发生时激活本 skill：
- 用户实现命令广播、并行发送逻辑
- 用户涉及 SharedArrayBuffer、Buffer Pool、环形缓冲区
- 用户讨论延迟优化、热路径代码
- 代码中需要高精度时间戳
- 用户实现 Worker Thread 间二进制数据传递

---

## Instructions

### 命令广播（核心热路径）

`CommandDispatcher` 使用 `Promise.allSettled()` 并行下发，超时设备独立降级：

```typescript
class CommandDispatcher {
  private readonly BROADCAST_TIMEOUT_MS = 100;

  async broadcast(command: string, params: unknown): Promise<BroadcastResult[]> {
    const channels = this.deviceManager.getConnectedChannels();

    const startTime = process.hrtime.bigint();

    const results = await Promise.allSettled(
      channels.map(async (channel) => {
        // 每个设备独立超时，不影响其他设备
        const result = await Promise.race([
          channel.sendCommand(command, params),
          sleep(this.BROADCAST_TIMEOUT_MS).then(() => {
            throw new Error(`COMMAND_TIMEOUT: device=${channel.deviceId}`);
          })
        ]);
        return { deviceId: channel.deviceId, result };
      })
    );

    const elapsedNs = process.hrtime.bigint() - startTime;
    // 广播应在 5ms (5_000_000ns) 内完成
    if (elapsedNs > 5_000_000n) {
      logger.warn({ elapsedMs: Number(elapsedNs / 1_000_000n), deviceCount: channels.length },
        'broadcast_latency_exceeded');
    }

    return results.map((r, i) => ({
      deviceId: channels[i]!.deviceId,
      status: r.status,
      value: r.status === 'fulfilled' ? r.value : undefined,
      error: r.status === 'rejected' ? r.reason : undefined
    }));
  }
}
```

### SharedArrayBuffer 零拷贝传输

Worker Thread 间传递二进制设备数据，避免序列化开销：

```typescript
// shared-buffer-pool.ts（在 shared 包中）
export class SharedBufferPool {
  private readonly bufferSize: number;
  private readonly poolSize: number;
  private readonly sharedBuffer: SharedArrayBuffer;
  private readonly slots: Int32Array; // Atomics 控制 slot 状态: 0=空闲, 1=写入中, 2=就绪
  private readonly dataView: Uint8Array;

  constructor(bufferSize = 4096, poolSize = 16) {
    this.bufferSize = bufferSize;
    this.poolSize = poolSize;
    // 头部: poolSize 个 Int32 slot 状态 + 每个 slot 4字节长度
    const headerSize = poolSize * 8;
    this.sharedBuffer = new SharedArrayBuffer(headerSize + bufferSize * poolSize);
    this.slots = new Int32Array(this.sharedBuffer, 0, poolSize * 2);
    this.dataView = new Uint8Array(this.sharedBuffer, headerSize);
  }

  // 主进程分配 slot，写入数据
  allocate(data: Buffer): number {
    for (let i = 0; i < this.poolSize; i++) {
      // 原子 CAS: 0(空闲) → 1(写入中)
      if (Atomics.compareExchange(this.slots, i * 2, 0, 1) === 0) {
        // 写入长度
        Atomics.store(this.slots, i * 2 + 1, data.byteLength);
        // 写入数据
        this.dataView.set(data, i * this.bufferSize);
        // 标记就绪: 1(写入中) → 2(就绪)
        Atomics.store(this.slots, i * 2, 2);
        // 通知 Worker 线程
        Atomics.notify(this.slots, i * 2);
        return i;
      }
    }
    throw new Error('BUFFER_POOL_EXHAUSTED');
  }

  // Worker 线程读取 slot 数据
  readSlot(slotIndex: number): Buffer {
    // 等待 slot 就绪
    Atomics.wait(this.slots, slotIndex * 2, 1); // 等待从 1→2
    const length = Atomics.load(this.slots, slotIndex * 2 + 1);
    const data = Buffer.from(
      this.sharedBuffer,
      poolSize * 8 + slotIndex * this.bufferSize,
      length
    );
    // 释放 slot: 2(就绪) → 0(空闲)
    Atomics.store(this.slots, slotIndex * 2, 0);
    return data;
  }
}
```

### Buffer Pool — 预分配避免 GC 压力

```typescript
// buffer-pool.ts
export class BufferPool {
  private readonly pool: Buffer[] = [];
  private readonly bufferSize: number;
  private readonly maxSize: number;

  constructor(bufferSize = 1024, preallocate = 32) {
    this.bufferSize = bufferSize;
    this.maxSize = preallocate * 4;
    // 预热：分配 preallocate 个 Buffer
    for (let i = 0; i < preallocate; i++) {
      this.pool.push(Buffer.allocUnsafe(bufferSize));
    }
  }

  acquire(): Buffer {
    return this.pool.pop() ?? Buffer.allocUnsafe(this.bufferSize);
  }

  release(buf: Buffer): void {
    if (this.pool.length < this.maxSize) {
      // 清空引用但不释放内存，供下次复用
      buf.fill(0);
      this.pool.push(buf);
    }
    // 超出池容量则直接丢弃，让 GC 回收
  }
}

// 全局实例（按大小分级）
export const bufferPool = {
  small: new BufferPool(64, 64),   // 小包：控制命令
  medium: new BufferPool(1024, 32), // 中包：一般数据
  large: new BufferPool(4096, 8),   // 大包：图像/批量数据
};
```

### 高精度时间戳规范

```typescript
// ✅ 正确：纳秒级精度，单调时钟
const startTs = process.hrtime.bigint();
// ... 操作 ...
const elapsedNs = process.hrtime.bigint() - startTs;
const elapsedMs = Number(elapsedNs) / 1_000_000;

// ❌ 禁止在热路径使用
const start = Date.now();  // 毫秒精度，可能受系统时钟调整影响
```

### Ring Buffer 日志（避免热路径 I/O 阻塞）

```typescript
// 在设备通信热路径中，不直接写日志文件
// 写入 ring buffer，异步消费
class RingBufferLogger {
  private readonly buffer: string[] = new Array(1024).fill('');
  private writeIdx = 0;

  // 零分配写入（hot path 安全）
  append(entry: string): void {
    this.buffer[this.writeIdx & 1023] = entry;
    this.writeIdx++;
  }

  // 由 setImmediate 回调异步 flush 到 pino
  flush(): void {
    // 将积累的条目批量写入 pino
  }
}
```

### 背压控制

当设备处理速度跟不上命令下发速度时，触发背压：

```typescript
class DeviceChannel {
  private readonly commandQueue: Array<PendingCommand> = [];
  private readonly HIGH_WATERMARK = 50;

  async sendCommand(command: string, params: unknown): Promise<CommandResult> {
    if (this.commandQueue.length >= this.HIGH_WATERMARK) {
      throw new Error(`BACKPRESSURE_EXCEEDED: device=${this.deviceId}, queueSize=${this.commandQueue.length}`);
    }
    // ... 正常发送逻辑
  }
}
```

---

## Constraints

- **热路径禁止列表**（在设备读写循环中）：
  - `JSON.stringify` / `JSON.parse` → 改用 Buffer 二进制编码
  - `new Buffer()` / `Buffer.alloc()` → 改用 BufferPool
  - `console.log` / `logger.info()` → 改用 RingBufferLogger.append()
  - `new Date()` / `Date.now()` → 改用 `process.hrtime.bigint()`
  - `async/await` 额外微任务开销（串行关键路径）→ 使用 callback 或 `setImmediate`
- `SharedArrayBuffer` 操作必须通过 `Atomics` API，**禁止**无锁直接读写（数据竞争）
- 命令广播使用 `Promise.allSettled()`，**禁止** `Promise.all()`（防止单设备失败导致全部失败）
- 命令广播必须有 `BROADCAST_TIMEOUT_MS` 超时，默认 100ms
- Buffer Pool 大小通过配置 `config.bufferPool` 控制，默认预分配 1MB 总容量
- 延迟 SLA：命令广播 ≤ 5ms、单设备命令 < 1ms；超出时记录 `warn` 日志

---

## Examples

### 性能 Benchmark 基准

```typescript
// packages/server/src/command/__tests__/broadcast.bench.ts
import { bench } from 'vitest';

bench('broadcast to 10 devices', async () => {
  const dispatcher = createTestDispatcher(10); // 10 个 Mock DeviceChannel
  const start = process.hrtime.bigint();
  await dispatcher.broadcast('GET_STATUS', {});
  const elapsed = process.hrtime.bigint() - start;
  // 断言 < 5ms
  expect(Number(elapsed)).toBeLessThan(5_000_000); // 5ms in ns
}, { iterations: 100 });
```

### 广播时序图

```
t=0ms:   CommandDispatcher.broadcast() 开始
t=0ms:   → 10 个 Promise.allSettled() 并行启动
t=0.1ms: → channel[0].encode() + transport[0].send()  ─┐
t=0.1ms: → channel[1].encode() + transport[1].send()   │ 并行
t=0.1ms: → channel[9].encode() + transport[9].send()  ─┘
t=4.5ms: → 全部设备响应收到（最慢设备）
t=100ms: → 超时未响应的设备标记 TIMEOUT，Promise.allSettled 返回
```
