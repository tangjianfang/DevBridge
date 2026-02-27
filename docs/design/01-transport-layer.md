# 设计文档 01 — Transport 层

> **所属模块**: `packages/server/src/transport/`  
> **线程模型**: 运行在 DeviceManager 所在的 Worker Thread（FFI 专属 Child Process）  
> **类型定义**: `packages/shared/src/types/transport.d.ts`

---

## 1. 核心接口

### 1.1 ITransport

```typescript
// packages/shared/src/types/transport.d.ts

export type TransportType =
  | 'usb-hid'
  | 'serial'
  | 'ble'
  | 'tcp'
  | 'usb-native'
  | 'ffi';

export interface TransportCapabilities {
  canSubscribe:       boolean;  // 支持被动监听（HID IN、BLE Notification）
  canRequest:         boolean;  // 支持请求-响应
  canBroadcast:       boolean;  // 支持广播（UDP）
  maxPacketSize:      number;   // 单次最大字节数
  isWireless:         boolean;  // 无线传输（延迟抖动影响）
  requiresIsolation:  boolean;  // 是否强制在 Child Process 内运行（FFI）
}

export interface EndpointInfo {
  id:           string;
  direction:    'in' | 'out' | 'bidir';
  type:         'interrupt' | 'bulk' | 'control' | 'stream' | 'notification';
  description?: string;
}

export interface ITransport extends NodeJS.EventEmitter {
  readonly transportType: TransportType;
  readonly deviceId:      string;

  // ── 连接管理 ──────────────────────────────────────────────
  connect(config: TransportConfig): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  getInfo(): DeviceInfo;
  getCapabilities(): TransportCapabilities;
  getEndpoints(): EndpointInfo[];

  // ── Command Channel（请求-响应）────────────────────────────
  send(buffer: Buffer): Promise<void>;
  request(buffer: Buffer, timeoutMs?: number): Promise<Buffer>;

  // ── Event Channel（被动监听）───────────────────────────────
  subscribe(endpointId: string): Promise<void>;
  unsubscribe(endpointId: string): Promise<void>;
  subscribeAll(): Promise<void>;  // 订阅 manifest 中声明的所有端点

  // ── 事件（继承自 EventEmitter）───────────────────────────
  // 'data'  (buffer: Buffer, endpointId: string) — 命令响应数据
  // 'event' (buffer: Buffer, endpointId: string) — 订阅数据（设备主动上报）
  // 'open'  ()                                   — 连接建立
  // 'close' (reason?: string)                    — 连接关闭
  // 'error' (err: Error)                         — 传输层错误
}
```

---

### 1.2 TransportConfig 联合类型

```typescript
export type TransportConfig =
  | UsbHidConfig
  | SerialConfig
  | BleConfig
  | TcpConfig
  | UsbNativeConfig
  | FfiConfig;

// ─── USB HID ─────────────────────────────────────────────────
export interface UsbHidConfig {
  type:         'usb-hid';
  vendorId:      number;
  productId:     number;
  usagePage?:    number;
  usage?:        number;
  preferLibusb?: boolean;       // 默认 false，优先 node-hid 内置驱动
  reportIds?: {
    input:    number[];
    output:   number[];
    feature:  number[];
  };
}

// ─── Serial ──────────────────────────────────────────────────
export interface SerialConfig {
  type:      'serial';
  path:      string;            // 'COM3' | '/dev/ttyUSB0'
  baudRate:  number;
  dataBits?: 5 | 6 | 7 | 8;   // 默认 8
  stopBits?: 1 | 1.5 | 2;     // 默认 1
  parity?:   'none' | 'even' | 'odd' | 'mark' | 'space'; // 默认 'none'
  rtscts?:   boolean;
  xon?:      boolean;
  xoff?:     boolean;
  parser?:   'delimiter' | 'length-prefix' | 'inter-byte-timeout' | 'raw';
  parserOptions?: Record<string, unknown>;
}

// ─── BLE ─────────────────────────────────────────────────────
export interface BleConfig {
  type:          'ble';
  address:       string;        // 'AA:BB:CC:DD:EE:FF'
  addressType?:  'public' | 'random';
  services: {
    uuid: string;
    characteristics: {
      uuid: string;
      role: 'read' | 'write' | 'write-without-response' | 'notify' | 'indicate';
    }[];
  }[];
  connectionTimeout?: number;   // ms，默认 10000
}

// ─── TCP / UDP ────────────────────────────────────────────────
export interface TcpConfig {
  type:       'tcp' | 'udp';
  host:       string;
  port:       number;
  keepAlive?: boolean;
  heartbeat?: {
    interval: number;           // ms
    payload:  string;           // HEX 字符串，如 "FF"
    timeout:  number;           // ms
  };
}

// ─── USB Native (libusb) ──────────────────────────────────────
export interface UsbNativeConfig {
  type:                 'usb-native';
  vendorId:              number;
  productId:             number;
  configurationValue?:   number; // 默认 1
  interfaces: {
    number:    number;
    endpoints: {
      address:       number;     // 端点地址（含方向位）
      transferType:  'bulk' | 'interrupt' | 'control';
      maxPacketSize?: number;
    }[];
  }[];
}

// ─── FFI（DLL / 共享库）──────────────────────────────────────
export interface FfiConfig {
  type:  'ffi';
  dlls: {
    id:        string;          // 本地标识（manifest 内唯一）
    path:      string;          // DLL 绝对路径
    stability: 'stable' | 'unstable'; // 影响 Child Process 分组
  }[];
  functions: {
    name:       string;
    returnType: string;         // 'int' | 'void' | 'pointer' | 'string' | ...
    argTypes:   string[];
  }[];
  callbacks?: {
    name:       string;
    returnType: string;
    argTypes:   string[];
  }[];
  pollIntervalMs?: number;      // 心跳轮询间隔（无原生热插拔时），默认 2000
}
```

---

## 2. 六种 Transport 能力对比

| 属性 | USB HID | Serial | BLE | TCP/UDP | USB Native | FFI |
|------|:-------:|:------:|:---:|:-------:|:----------:|:---:|
| Node.js 库 | `node-hid` + `usb` | `serialport` | `@abandonware/noble` | `net` / `dgram` | `usb` (libusb) | `node-ffi-napi` |
| `canSubscribe` | ✅ IN Report | ✅ 数据流 | ✅ Notify | ✅ stream | ✅ IN Endpt | ⚠️ SDK 决定 |
| `canRequest` | ✅ | ✅ | ✅ Write+Notify | ✅ | ✅ | ✅ |
| `canBroadcast` | ❌ | ❌ | ❌ | ✅ UDP | ❌ | ❌ |
| `maxPacketSize` | 64 B | 无限制 | 512 B (BLE 5) | 65535 B | 65536 B | SDK 决定 |
| `isWireless` | ❌ | ❌ | ✅ | ⚠️ | ❌ | ❌ |
| `requiresIsolation` | ❌ | ❌ | ⚠️ 建议 | ❌ | ⚠️ 建议 | ✅ **强制** |
| 热插拔机制 | 原生事件 | 轮询 500ms | RSSI 超时 | 心跳超时 | 原生事件 | SDK/轮询 |
| 热插拔延迟 | < 100ms | ≤ 1s | 5–10s | 1–30s | < 100ms | 依赖 SDK |
| 实现目录 | `transport/usb-hid/` | `transport/serial/` | `transport/ble/` | `transport/network/` | `transport/usb-native/` | `transport/ffi/` |

---

## 3. BaseTransport 公共基类

```typescript
// packages/server/src/transport/base-transport.ts

import { EventEmitter } from 'events';

export abstract class BaseTransport extends EventEmitter implements ITransport {
  protected _connected    = false;
  protected subscriptions = new Set<string>();

  // ring buffer —— 防背压，最多缓 256 帧
  private readonly EVENT_BUFFER_MAX = 256;
  private _pendingEvents:  Array<{ buffer: Buffer; endpointId: string }> = [];

  abstract readonly transportType: TransportType;
  abstract readonly deviceId:      string;
  abstract connect(config: TransportConfig): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract send(buffer: Buffer): Promise<void>;
  abstract getCapabilities(): TransportCapabilities;
  abstract getEndpoints(): EndpointInfo[];

  isConnected(): boolean { return this._connected; }

  async request(buffer: Buffer, timeoutMs = 5000): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('data', handler);
        reject(Object.assign(
          new Error(`TRANSPORT_REQUEST_TIMEOUT: ${this.deviceId}`),
          { errorCode: 'TRANSPORT_REQUEST_TIMEOUT', deviceId: this.deviceId }
        ));
      }, timeoutMs);

      const handler = (data: Buffer) => {
        clearTimeout(timer);
        resolve(data);
      };

      this.once('data', handler);
      this.send(buffer).catch(err => {
        clearTimeout(timer);
        this.off('data', handler);
        reject(err);
      });
    });
  }

  async subscribe(endpointId: string): Promise<void> {
    this.subscriptions.add(endpointId);
  }

  async unsubscribe(endpointId: string): Promise<void> {
    this.subscriptions.delete(endpointId);
  }

  async subscribeAll(): Promise<void> {
    for (const ep of this.getEndpoints()) {
      if (ep.direction !== 'out') await this.subscribe(ep.id);
    }
  }

  protected emitData(buffer: Buffer, endpointId: string): void {
    this.emit('data', buffer, endpointId);
  }

  protected emitEvent(buffer: Buffer, endpointId: string): void {
    if (this._pendingEvents.length >= this.EVENT_BUFFER_MAX) {
      this._pendingEvents.shift(); // 背压保护：丢弃最旧帧
    }
    this._pendingEvents.push({ buffer, endpointId });
    this.emit('event', buffer, endpointId);
  }

  protected setConnected(val: boolean, reason?: string): void {
    this._connected = val;
    this.emit(val ? 'open' : 'close', reason);
  }
}
```

---

## 4. TransportFactory

```typescript
// packages/server/src/transport/transport-factory.ts

export class TransportFactory {
  private static registry = new Map<TransportType, new () => ITransport>();

  static register(type: TransportType, ctor: new () => ITransport): void {
    this.registry.set(type, ctor);
  }

  static create(type: TransportType): ITransport {
    const Ctor = this.registry.get(type);
    if (!Ctor) {
      throw Object.assign(
        new Error(`TRANSPORT_NOT_SUPPORTED: ${type}`),
        { errorCode: 'TRANSPORT_NOT_SUPPORTED' }
      );
    }
    return new Ctor();
  }
}

// packages/server/src/transport/index.ts — 注册所有 Transport
import { UsbHidTransport }    from './usb-hid/usb-hid-transport';
import { SerialTransport }    from './serial/serial-transport';
import { BleTransport }       from './ble/ble-transport';
import { TcpTransport }       from './network/tcp-transport';
import { UsbNativeTransport } from './usb-native/usb-native-transport';
import { FfiTransport }       from './ffi/ffi-transport';   // Child Process 专属

TransportFactory.register('usb-hid',    UsbHidTransport);
TransportFactory.register('serial',     SerialTransport);
TransportFactory.register('ble',        BleTransport);
TransportFactory.register('tcp',        TcpTransport);
TransportFactory.register('usb-native', UsbNativeTransport);
TransportFactory.register('ffi',        FfiTransport);
```

> **FFI 约束**：`FfiTransport` 内部的 `require('node-ffi-napi')` 必须在 Child Process 中执行。  
> `TransportFactory.create('ffi')` 只可在 PluginLoader 已 `fork()` 的 Child Process 内调用。

---

## 5. IDeviceScanner 接口

```typescript
// packages/server/src/transport/scanner.ts

export interface RawDeviceInfo {
  transportType:  TransportType;
  address:        string;       // 唯一地址标识（路径/MAC/IP:port）
  name?:          string;
  vendorId?:      number;
  productId?:     number;
  serialNumber?:  string;
  raw:            unknown;      // 各 Transport 原始信息对象
}

export interface IDeviceScanner extends NodeJS.EventEmitter {
  readonly transportType: TransportType;
  scan(): Promise<RawDeviceInfo[]>;      // 一次性扫描
  startWatching(): void;                 // 持续热插拔监听
  stopWatching():  void;
  // 'attached' (device: RawDeviceInfo)
  // 'detached' (address: string)
}
```

**各 Transport 扫描实现要点：**

| Transport | `scan()` 实现 | 热插拔机制 |
|-----------|-------------|-----------|
| USB HID | `HID.devices()` 过滤 | `usb.on('attach')` → 重新枚举 HID 差异 |
| Serial | `SerialPort.list()` | `setInterval(500ms)` 差异比对 |
| BLE | `noble.startScanningAsync()` | `noble.on('discover')` + RSSI 超时 10s |
| TCP | mDNS `mdns.createBrowser()` | `browser.on('serviceUp/Down')` + 心跳超时 |
| USB Native | `usb.getDeviceList()` | `usb.on('attach/detach')` |
| FFI | 静态配置（无扫描） | SDK 回调 或 `isConnected()` 轮询 |

---

## 6. FfiTransport Child Process 特殊规则

```typescript
// packages/server/src/transport/ffi/ffi-transport.ts
// ⚠️ 此文件只能在 child_process.fork() 创建的 Child Process 内 require

class FfiTransport extends BaseTransport {
  readonly transportType = 'ffi' as const;

  private libs        = new Map<string, unknown>();
  private pollTimer?: ReturnType<typeof setInterval>;
  _callbackRef?: unknown; // 持久化 FFI Callback，防 GC 回收

  async connect(config: FfiConfig): Promise<void> {
    const ffi = require('node-ffi-napi'); // 仅在 Child Process 执行
    const ref = require('ref-napi');

    for (const dll of config.dlls) {
      const libDef: Record<string, [string, string[]]> = {};
      for (const fn of config.functions) {
        libDef[fn.name] = [fn.returnType, fn.argTypes];
      }
      this.libs.set(dll.id, ffi.Library(dll.path, libDef));
    }

    if (config.callbacks?.length) {
      this.registerCallbacks(config.callbacks, ffi);
    } else {
      this.startPoll(config.pollIntervalMs ?? 2000);
    }
    this.setConnected(true);
  }

  private registerCallbacks(
    defs: FfiConfig['callbacks'],
    ffi:  unknown
  ): void {
    const cb = (ffi as typeof import('node-ffi-napi')).Callback(
      'void', ['int', 'pointer', 'int'],
      (eventType: number, dataPtr: Buffer, dataLen: number) => {
        const data = dataPtr.slice(0, dataLen);
        this.emitEvent(data, `ffi-callback-${eventType}`);
      }
    );
    this._callbackRef = cb; // 必须持久化，防 GC 回收后崩溃
    const lib = this.libs.get('core')! as Record<string, (...a: unknown[]) => void>;
    lib['SDK_RegisterCallback']?.(cb);
  }

  private startPoll(intervalMs: number): void {
    this.pollTimer = setInterval(() => {
      try {
        const lib = this.libs.get('core')! as Record<string, () => number>;
        const ok  = lib['SDK_IsConnected']?.() ?? 1;
        if (!ok) this.setConnected(false, 'FFI_POLL_DISCONNECTED');
      } catch {
        this.setConnected(false, 'FFI_POLL_ERROR');
      }
    }, intervalMs);
  }
}
```

**DLL 隔离分组策略（由 PluginLoader 执行）：**

| `stability` 值 | 分组策略 | 说明 |
|----------------|---------|------|
| `"stable"` | 共享 Child Process | 多个 stable DLL 可合并到同一进程 |
| `"unstable"` | **独占** Child Process | DLL 崩溃只终止该进程，不影响其他设备 |

---

## 7. Mock Transport（测试专用）

```typescript
// packages/server/src/transport/mock/mock-transport.ts

export class MockTransport extends BaseTransport {
  readonly transportType: TransportType;
  readonly deviceId:      string;

  private responseQueue: Buffer[] = [];

  constructor(type: TransportType, deviceId: string) {
    super();
    this.transportType = type;
    this.deviceId      = deviceId;
  }

  async connect(_config: TransportConfig): Promise<void> {
    this.setConnected(true);
  }
  async disconnect(): Promise<void> {
    this.setConnected(false);
  }
  async send(_buffer: Buffer): Promise<void> { /* no-op */ }
  getCapabilities(): TransportCapabilities {
    return { canSubscribe: true, canRequest: true, canBroadcast: false,
             maxPacketSize: 65535, isWireless: false, requiresIsolation: false };
  }
  getEndpoints(): EndpointInfo[] { return []; }
  getInfo(): DeviceInfo { return {} as DeviceInfo; }

  // 测试辅助：注入一条响应数据
  injectData(buffer: Buffer, endpointId = 'mock'): void {
    this.emitData(buffer, endpointId);
  }
  injectEvent(buffer: Buffer, endpointId = 'mock'): void {
    this.emitEvent(buffer, endpointId);
  }
  simulateDisconnect(reason = 'mock-disconnect'): void {
    this.setConnected(false, reason);
  }
}
```

---

## 8. 错误码全集 — TRANSPORT_*

| 错误码 | 触发场景 | HTTP 状态码 |
|--------|---------|-----------|
| `TRANSPORT_NOT_SUPPORTED` | TransportFactory.create() 未注册该类型 | 400 |
| `TRANSPORT_CONNECT_FAILED` | connect() 底层库抛错 | 500 |
| `TRANSPORT_SEND_FAILED` | send() 设备无响应或驱动报错 | 500 |
| `TRANSPORT_REQUEST_TIMEOUT` | request() 超过 timeoutMs | 504 |
| `TRANSPORT_DISCONNECTED` | 意外断开触发 'close' 事件 | 503 |
| `TRANSPORT_PERMISSION_DENIED` | HID/USB 无权限（Linux udev 缺规则）| 403 |
| `TRANSPORT_DEVICE_BUSY` | 设备被其他进程占用 | 409 |
| `TRANSPORT_FFI_LOAD_FAILED` | DLL/so 不存在或 ABI 不兼容 | 500 |
| `TRANSPORT_FFI_CALLBACK_LOST` | FFI Callback 被 GC 回收后调用崩溃 | 500 |

---

## 9. 测试要点

- **Mock 覆盖全部 Transport**：每种 Transport 的单元测试使用 `MockTransport`，不连接真实硬件
- **`request()` 超时**：Mock 在 `timeoutMs + 100ms` 后才 `injectData()`，断言 reject `TRANSPORT_REQUEST_TIMEOUT`
- **背压保护**：连续调用 `emitEvent()` 300 次，断言 `_pendingEvents.length ≤ 256`（丢弃最旧 44 帧）
- **FFI 隔离**：grep 全仓库，断言 `require('node-ffi-napi')` 只出现在 `transport/ffi/ffi-transport.ts`
- **`subscribeAll()`**：Mock 返回 3 个 Endpoint（2 in + 1 out），断言只订阅了 2 个
- **断开重连**：`simulateDisconnect()` → 断言 'close' 事件触发 → DeviceManager 调起重连
