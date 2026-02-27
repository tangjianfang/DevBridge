# Skill: Device Lifecycle — 设备生命周期管理

## Preconditions

当以下情况发生时激活本 skill：
- 用户实现设备枚举（列出可用设备）
- 用户涉及热插拔检测（插入/拔出/连接/断开事件）
- 用户实现自动重连逻辑
- 用户使用 `DeviceManager` 或 `IDeviceScanner`
- 用户设计设备状态机或持久化设备配置

---

## Instructions

### DeviceInfo — 统一设备信息格式

```typescript
type TransportType = 'usb-hid' | 'serial' | 'ble' | 'tcp' | 'usb-native' | 'ffi';

type DeviceStatus =
  | 'unknown'         // 未知（新发现尚未处理）
  | 'attached'        // 已检测到（物理上可达）
  | 'connecting'      // 正在建立连接
  | 'connected'       // 连接成功，通信正常
  | 'disconnected'    // 通信意外断开（物理设备仍在）
  | 'reconnecting'    // 自动重连进行中
  | 'detached'        // 物理设备已移除
  | 'error';          // 严重错误，需人工介入

interface DeviceInfo {
  deviceId: string;             // '{transportType}:{fingerprintHash}'
  transportType: TransportType;
  status: DeviceStatus;
  name: string;
  address: string;              // COM3 | usb:1-2.3 | BLE:AA:BB:CC:DD:EE:FF | 192.168.1.100:9100
  vendorId?: number;            // USB 设备
  productId?: number;           // USB 设备
  serialNumber?: string;        // 设备序列号（指纹的一部分）
  matchedPlugin?: string;       // 匹配到的 Plugin 名称
  lastSeen: bigint;             // process.hrtime.bigint()
  connectedAt?: bigint;
  reconnectAttempts: number;    // 当前重连次数
  metadata?: Record<string, unknown>;
}
```

### 设备状态机（完整转换规则）

```
                        ┌──────────────────────────────────────────┐
                        │              物理拔出（任意状态）          │
                        │    → detached → [从列表移除]              │
                        └──────────────────────────────────────────┘

unknown ──scan发现──► attached ──matchPlugin──► connecting ──成功──► connected
                          │                         │                    │
                     无匹配Plugin              连接失败               通信中断
                          │                         │                    │
                     (仅列出不连接)              error ◄─────────── disconnected
                                                                         │
                                                                  reconnect策略检查
                                                                         │
                                                             maxRetries未耗尽 ──► reconnecting
                                                             maxRetries耗尽   ──► error
                                                                         │
                                                             重连成功 ──► connected
```

### DeviceManager — 设备生命周期管理核心

```typescript
class DeviceManager implements IService {
  readonly serviceId = 'device-manager';
  private devices = new Map<string, DeviceInfo>();
  private channels = new Map<string, DeviceChannel>();
  private reconnectControllers = new Map<string, ReconnectController>();
  private scanners: IDeviceScanner[] = [];

  async start(): Promise<void> {
    // 注册所有 Transport Scanner
    this.scanners = [
      new UsbHidScanner(),
      new SerialScanner(),
      new BleScanner(),
      new TcpScanner(),
      new UsbNativeScanner(),
    ];
    // 启动热插拔监听
    for (const scanner of this.scanners) {
      scanner.on('attached', (raw) => this.handleAttached(raw));
      scanner.on('detached', (raw) => this.handleDetached(raw));
      scanner.startWatching();
    }
    // 全量扫描
    await this.scanAll();
  }

  private async scanAll(): Promise<void> {
    const allDevices = await Promise.all(this.scanners.map(s => s.scan()));
    for (const rawDevice of allDevices.flat()) {
      await this.handleAttached(rawDevice);
    }
  }

  private async handleAttached(raw: RawDeviceInfo): Promise<void> {
    const deviceId = generateDeviceId(raw);
    if (this.devices.has(deviceId)) return; // 已知设备跳过

    const matched = await pluginLoader.matchPlugin(raw);
    const info: DeviceInfo = {
      deviceId,
      transportType: raw.transportType,
      status: 'attached',
      name: raw.name ?? 'Unknown Device',
      address: raw.address,
      vendorId: raw.vendorId,
      productId: raw.productId,
      serialNumber: raw.serialNumber,
      matchedPlugin: matched?.name,
      lastSeen: process.hrtime.bigint(),
      reconnectAttempts: 0,
    };
    this.devices.set(deviceId, info);
    this.emitEvent('device:attached', info);

    if (matched) {
      await this.connect(deviceId, matched);
    }
  }

  private async connect(deviceId: string, plugin: PluginManifest): Promise<void> {
    this.updateStatus(deviceId, 'connecting');
    try {
      const channel = await DeviceChannel.create(deviceId, plugin);
      this.channels.set(deviceId, channel);
      channel.on('disconnect', () => this.handleDisconnect(deviceId));
      this.updateStatus(deviceId, 'connected');
    } catch (err) {
      this.updateStatus(deviceId, 'error');
      logger.error({ deviceId, err }, 'device_connect_failed');
    }
  }

  private handleDisconnect(deviceId: string): void {
    this.updateStatus(deviceId, 'disconnected');
    const device = this.devices.get(deviceId);
    if (!device?.matchedPlugin) return;

    const plugin = pluginLoader.getPlugin(device.matchedPlugin);
    if (plugin?.reconnect) {
      const controller = new ReconnectController(deviceId, plugin.reconnect);
      this.reconnectControllers.set(deviceId, controller);
      controller.start(() => this.connect(deviceId, plugin));
    }
  }
}
```

### IDeviceScanner — 各 Transport 扫描器接口

```typescript
interface RawDeviceInfo {
  transportType: TransportType;
  name?: string;
  address: string;
  vendorId?: number;
  productId?: number;
  serialNumber?: string;
  metadata?: Record<string, unknown>;
}

interface IDeviceScanner extends EventEmitter {
  scan(): Promise<RawDeviceInfo[]>;
  startWatching(): void;
  stopWatching(): void;
  // 事件: 'attached' | 'detached'
}
```

**各 Transport 扫描器实现要点：**

| Scanner | 扫描 API | 热插拔 API |
|---------|---------|-----------|
| `UsbHidScanner` | `HID.devices()` | `usb.on('attach/detach')` |
| `SerialScanner` | `SerialPort.list()` 轮询（1s 间隔）+ diff 比对 | 发现差异时触发 |
| `BleScanner` | `noble.startScanning()` 配合 filter | RSSI 超时 + debounce 3s |
| `TcpScanner` | 读取静态配置 + `bonjour.find()` mDNS 发现 | mDNS 服务消失 + 心跳超时 |
| `UsbNativeScanner` | `usb.getDeviceList()` | `usb.on('attach/detach')` |

### ReconnectController — 自动重连

```typescript
interface ReconnectConfig {
  maxRetries: number;         // -1=无限, 0=不重连, 默认 5
  retryInterval: number;      // ms，默认 1000
  backoffMultiplier: number;  // 默认 2（指数退避）
  maxRetryInterval: number;   // ms，默认 30_000
  reconnectOn: ('detach' | 'disconnect' | 'error')[];
}

class ReconnectController {
  private attempts = 0;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  start(connectFn: () => Promise<void>): void {
    const attempt = async () => {
      if (this.stopped) return;
      const { maxRetries, retryInterval, backoffMultiplier, maxRetryInterval } = this.config;
      if (maxRetries !== -1 && this.attempts >= maxRetries) {
        deviceManager.updateStatus(this.deviceId, 'error');
        return;
      }
      deviceManager.updateStatus(this.deviceId, 'reconnecting');
      try {
        await connectFn();
        this.attempts = 0; // 重连成功，重置计数
      } catch {
        this.attempts++;
        const delay = Math.min(retryInterval * Math.pow(backoffMultiplier, this.attempts), maxRetryInterval);
        this.timer = setTimeout(attempt, delay);
      }
    };
    attempt();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
```

### 设备 ID 生成（稳定指纹）

```typescript
function generateDeviceId(raw: RawDeviceInfo): string {
  const fingerprint = createHash('sha1')
    .update(raw.transportType)
    .update(raw.serialNumber ?? raw.address)
    .update(String(raw.vendorId ?? ''))
    .update(String(raw.productId ?? ''))
    .digest('hex')
    .slice(0, 12);
  return `${raw.transportType}:${fingerprint}`;
}
// 生成结果示例: 'usb-hid:a3f8c92d1b4e'
// 同一物理设备无论插哪个端口，deviceId 保持不变（基于 serialNumber）
```

### REST API 端点

```
GET    /api/v1/devices              获取设备列表（含状态）
GET    /api/v1/devices/:id          获取单设备详情
POST   /api/v1/devices/scan         触发全量扫描
POST   /api/v1/devices/:id/connect  手动连接设备
POST   /api/v1/devices/:id/disconnect 手动断开设备
GET    /api/v1/devices/:id/history  获取通信历史
```

---

## Constraints

- 设备状态机的每次状态迁移必须发出对应的 `device:status-changed` 事件，**禁止**跳过中间状态
- Serial Scanner 的轮询必须做 diff 比对（新增/消失），**禁止**每次将全部设备当作新设备发出
- 自动连接只对有匹配 Plugin 的设备生效，未知设备只列出不自动连接（免安全风险）
- BLE 的 `attached`/`detached` 基于 RSSI 阈值和超时判定，必须 debounce（3s），避免信号波动误判
- 重连过程中设备再次 `detached` 必须立即 `ReconnectController.stop()`，**禁止**继续重试
- `deviceId` 必须跨次连接稳定不变（基于 serialNumber 或唯一地址，不能用 USB path）

---

## Examples

### 设备完整生命周期时序

```
t=0s:   服务启动 → DeviceManager.start() → 全量扫描
t=0.5s: USB HID 设备被发现 → 'attached' → pluginLoader 匹配插件
t=0.6s: 创建 DeviceChannel → 状态 'connecting'
t=0.8s: 连接成功 → 状态 'connected' → WS 推送 device:attached
t=5s:   用户拔出设备 → usb 'detach' 事件 → 状态 'detached'
t=5s:   WS 推送 device:detached → 前端设备列表更新
t=5s:   ReconnectController.start() → 状态 'reconnecting'
t=6s:   重连尝试 1 (失败，设备未插回)
t=8s:   重连尝试 2
t=10s:  用户插回设备 → 重连尝试 3 成功 → 状态 'connected'
```
