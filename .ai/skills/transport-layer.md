# Skill: Transport Layer — Transport 抽象层

## Preconditions

当以下情况发生时激活本 skill：
- 用户实现新的 Transport 类型
- 用户修改 `ITransport` 接口或 `TransportFactory`
- 涉及设备连接/断开/重连的底层实现
- 用户实现 subscribe/unsubscribe 订阅机制
- 用户涉及 Transport 的错误处理和背压控制

---

## Instructions

### ITransport 接口定义

```typescript
export interface TransportCapabilities {
  canSubscribe: boolean;      // 支持被动监听（HID IN、BLE Notification）
  canRequest: boolean;        // 支持请求-响应
  canBroadcast: boolean;      // 支持广播发送（UDP）
  maxPacketSize: number;      // 单次发送最大字节数
  isWireless: boolean;        // 无线传输（BLE/TCP 需考虑延迟抖动）
}

export interface EndpointInfo {
  id: string;                 // 端点唯一标识
  direction: 'in' | 'out' | 'bidir';
  type: 'interrupt' | 'bulk' | 'control' | 'stream' | 'notification';
  description?: string;
}

export interface ITransport extends EventEmitter {
  readonly transportType: TransportType;
  readonly deviceId: string;

  // ── 连接管理 ──────────────────────────────────────────
  connect(config: TransportConfig): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getInfo(): DeviceInfo;
  getCapabilities(): TransportCapabilities;
  getEndpoints(): EndpointInfo[];

  // ── Command Channel（请求-响应）───────────────────────
  send(buffer: Buffer): Promise<void>;
  // 发送并等待第一个响应（简单协议使用）
  request(buffer: Buffer, timeoutMs?: number): Promise<Buffer>;

  // ── Event Channel（被动监听）──────────────────────────
  subscribe(endpointId: string): Promise<void>;
  unsubscribe(endpointId: string): Promise<void>;
  subscribeAll(): Promise<void>;  // 订阅 manifest 中声明的所有端点

  // ── 事件（继承自 EventEmitter）───────────────────────
  // 'data'     (buffer: Buffer, endpointId: string)  命令响应数据
  // 'event'    (buffer: Buffer, endpointId: string)  订阅数据（主动上报）
  // 'open'     ()                                     连接建立
  // 'close'    (reason?: string)                      连接关闭
  // 'error'    (err: Error)                           错误
}
```

### TransportFactory — 工厂模式

```typescript
class TransportFactory {
  private static registry = new Map<TransportType, new () => ITransport>();

  static register(type: TransportType, ctor: new () => ITransport): void {
    this.registry.set(type, ctor);
  }

  static create(type: TransportType, deviceId: string): ITransport {
    const Ctor = this.registry.get(type);
    if (!Ctor) throw new Error(`TRANSPORT_NOT_SUPPORTED: ${type}`);
    return new Ctor();
  }
}

// 注册所有 Transport
TransportFactory.register('usb-hid', UsbHidTransport);
TransportFactory.register('serial', SerialTransport);
TransportFactory.register('ble', BleTransport);
TransportFactory.register('tcp', TcpTransport);
TransportFactory.register('usb-native', UsbNativeTransport);
TransportFactory.register('ffi', FfiTransport);   // DLL，必须配合 Child Process 隔离
```

### BaseTransport — 公共基类

```typescript
abstract class BaseTransport extends EventEmitter implements ITransport {
  protected _connected = false;
  protected subscriptions = new Set<string>();
  protected _eventBuffer: Buffer[] = []; // 内部 ring buffer（背压保护）
  private readonly EVENT_BUFFER_MAX = 256;

  abstract connect(config: TransportConfig): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract send(buffer: Buffer): Promise<void>;
  abstract getCapabilities(): TransportCapabilities;
  abstract getEndpoints(): EndpointInfo[];

  isConnected(): boolean {
    return this._connected;
  }

  async request(buffer: Buffer, timeoutMs = 5000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('data', handler);
        reject(new Error('TRANSPORT_REQUEST_TIMEOUT'));
      }, timeoutMs);

      const handler = (data: Buffer) => {
        clearTimeout(timer);
        resolve(data);
      };
      this.once('data', handler);
      this.send(buffer).catch(reject);
    });
  }

  // 子类在收到 Event Channel 数据时调用
  protected emitEvent(buffer: Buffer, endpointId: string): void {
    // 背压保护
    if (this._eventBuffer.length >= this.EVENT_BUFFER_MAX) {
      logger.warn({ deviceId: this.deviceId, endpointId }, 'event_buffer_overflow_dropping');
      this._eventBuffer.shift(); // 丢弃最旧的
    }
    this._eventBuffer.push(buffer);
    this.emit('event', buffer, endpointId);
  }
}
```

### Transport 配置格式

```typescript
type TransportConfig =
  | UsbHidConfig
  | SerialConfig
  | BleConfig
  | TcpConfig
  | UsbNativeConfig;

interface UsbHidConfig {
  type: 'usb-hid';
  vendorId: number;
  productId: number;
  interface?: number;       // 默认 0
  usagePageFilter?: number; // 过滤 Usage Page
}

interface SerialConfig {
  type: 'serial';
  path: string;             // 'COM3' | '/dev/ttyUSB0'
  baudRate: number;
  dataBits?: 5 | 6 | 7 | 8;
  stopBits?: 1 | 1.5 | 2;
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
  flowControl?: 'none' | 'rtscts' | 'xon/xoff';
}

interface BleConfig {
  type: 'ble';
  peripheralId: string;     // noble peripheral ID
  mtu?: number;             // 默认 512
}

interface TcpConfig {
  type: 'tcp';
  host: string;
  port: number;
  keepAlive?: boolean;
  keepAliveInterval?: number;
  connectTimeout?: number;
}
```

---

## Constraints

- 所有 Transport 都必须继承 `BaseTransport`，**禁止**直接实现 `ITransport`（保证公共行为一致）
- Transport 实现中**禁止**任何协议解析逻辑（帧解析、CRC 计算、字段提取）
- Event Channel 的数据流**必须**在后台持续维护：即使当前无消费者，Transport 也要接收数据存入缓冲区
- `disconnect()` 必须幂等（已断开状态再次调用不报错）
- Transport 发出的 `'error'` 事件必须被 `DeviceChannel` 捕获，**禁止**未处理的 `error` 事件（Node.js 会 crash）
- `subscribe()` / `unsubscribe()` 失败需单独报错，**禁止**中断整个连接流程（其他端点继续运行）

---

## Examples

### TCP Transport 实现骨架

```typescript
class TcpTransport extends BaseTransport {
  readonly transportType = 'tcp' as const;
  private socket?: net.Socket;
  private heartbeatTimer?: NodeJS.Timeout;

  async connect(config: TcpConfig): Promise<void> {
    this.socket = new net.Socket();
    await new Promise<void>((resolve, reject) => {
      this.socket!.connect(config.port, config.host, resolve);
      this.socket!.once('error', reject);
    });
    this._connected = true;
    this.socket.on('data', (data) => this.emit('data', data, 'stream'));
    this.socket.on('close', () => {
      this._connected = false;
      this.emit('close');
    });
    this.socket.on('error', (err) => this.emit('error', err));
    if (config.keepAlive) this.startHeartbeat(config.keepAliveInterval ?? 10_000);
    this.emit('open');
  }

  async send(buffer: Buffer): Promise<void> {
    if (!this.socket?.writable) throw new Error('TRANSPORT_NOT_CONNECTED');
    return new Promise((resolve, reject) => {
      this.socket!.write(buffer, (err) => err ? reject(err) : resolve());
    });
  }

  async disconnect(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.socket?.destroy();
    this._connected = false;
  }

  getCapabilities(): TransportCapabilities {
    return { canSubscribe: true, canRequest: true, canBroadcast: false,
             maxPacketSize: 65535, isWireless: true };
  }
}
```
