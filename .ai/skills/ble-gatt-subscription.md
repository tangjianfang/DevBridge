# Skill: BLE GATT Subscription — 蓝牙 GATT 订阅模型

## Preconditions

当以下情况发生时激活本 skill：
- 用户实现 BLE 设备连接、扫描、配对
- 涉及 GATT Service/Characteristic 发现
- 用户实现 Notification/Indication 订阅
- 处理跨 Service 多 Characteristic 数据聚合
- 涉及 MTU 协商或 BLE 跨平台兼容问题
- 使用 `@abandonware/noble` 库

---

## Instructions

### BLE Transport 核心流程

```typescript
class BleTransport extends BaseTransport {
  readonly transportType = 'ble' as const;
  private peripheral?: noble.Peripheral;
  private characteristics = new Map<string, noble.Characteristic>();
  private writeChar?: noble.Characteristic;

  async connect(config: BleConfig): Promise<void> {
    this.peripheral = await this.findPeripheral(config.peripheralId);

    // 1. 建立连接
    await promisify(this.peripheral.connect.bind(this.peripheral))();

    // 2. MTU 协商
    const mtu = config.mtu ?? 512;
    // noble 在部分平台支持 requestMtu
    if ('requestMtu' in this.peripheral) {
      await (this.peripheral as any).requestMtu(mtu);
    }

    // 3. GATT Service Discovery
    await this.discoverServices();

    // 4. 批量订阅
    await this.subscribeAll();

    this._connected = true;
    this.peripheral.on('disconnect', () => {
      this._connected = false;
      this.emit('close', 'peripheral_disconnected');
    });
    this.emit('open');
  }

  private async discoverServices(): Promise<void> {
    const serviceUUIDs = this.config?.bleConfig?.subscriptions
      .map(s => normalizeUUID(s.serviceUUID)) ?? [];

    await promisify(this.peripheral!.discoverServices.bind(this.peripheral!))(serviceUUIDs);
    // 结果通过 peripheral.on('servicesDiscover', ...) 获取
  }

  async subscribeAll(): Promise<void> {
    const subscriptions = this.config?.bleConfig?.subscriptions ?? [];

    const results = await Promise.allSettled(
      subscriptions.map(async (sub) => {
        try {
          await this.subscribe(normalizeUUID(sub.characteristicUUID));
        } catch (err) {
          // 单个 Characteristic 订阅失败不影响其他
          logger.warn({ uuid: sub.characteristicUUID, err }, 'ble_subscribe_failed');
          notificationManager.notify('warning', 'ble-transport',
            `Characteristic ${sub.characteristicUUID} subscribe failed`);
        }
      })
    );

    // 绑定写入 Characteristic（Command Channel）
    const writeConfig = this.config?.bleConfig?.writeCharacteristic;
    if (writeConfig) {
      this.writeChar = await this.findCharacteristic(
        normalizeUUID(writeConfig.serviceUUID),
        normalizeUUID(writeConfig.characteristicUUID)
      );
    }
  }

  async subscribe(characteristicUUID: string): Promise<void> {
    const char = this.characteristics.get(characteristicUUID);
    if (!char) throw new Error(`CHARACTERISTIC_NOT_FOUND: ${characteristicUUID}`);

    // 检查是否支持 notify 或 indicate
    if (!char.properties.includes('notify') && !char.properties.includes('indicate')) {
      throw new Error(`CHARACTERISTIC_NO_NOTIFY: ${characteristicUUID}`);
    }

    await promisify(char.subscribe.bind(char))();

    char.on('data', (buffer: Buffer) => {
      // Event Channel 数据，带 Characteristic UUID 标识
      this.emitEvent(buffer, characteristicUUID);
      // 同时 emit 带 uuid 的特定事件，方便数据聚合
      this.emit(`event:${characteristicUUID}`, buffer);
    });

    this.subscriptions.add(characteristicUUID);
    logger.info({ deviceId: this.deviceId, characteristicUUID }, 'ble_subscribed');
  }

  // Command Channel：写入 Characteristic
  async send(buffer: Buffer): Promise<void> {
    if (!this.writeChar) throw new Error('BLE_NO_WRITE_CHARACTERISTIC');
    const writeType = this.config?.bleConfig?.writeCharacteristic?.writeType ?? 'withResponse';

    if (writeType === 'withResponse') {
      await promisify(this.writeChar.write.bind(this.writeChar))(buffer, false);
    } else {
      await promisify(this.writeChar.write.bind(this.writeChar))(buffer, true);
    }
  }

  async disconnect(): Promise<void> {
    // 取消所有订阅
    for (const [uuid, char] of this.characteristics) {
      try {
        await promisify(char.unsubscribe.bind(char))();
      } catch { /* ignore */ }
    }
    await promisify(this.peripheral!.disconnect.bind(this.peripheral!))();
    this._connected = false;
  }
}
```

### Plugin Manifest BLE 配置完整示例

```json
{
  "name": "nordic-uart-sensor",
  "version": "1.0.0",
  "transportType": "ble",
  "bleConfig": {
    "deviceNameFilter": "MySensor",
    "serviceUUIDs": ["6e400001-b5a3-f393-e0a9-e50e24dcca9e"],
    "mtu": 247,
    "subscriptions": [
      {
        "serviceUUID": "180f",
        "characteristicUUID": "2a19",
        "mode": "notification",
        "protocolRef": "battery_level"
      },
      {
        "serviceUUID": "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
        "characteristicUUID": "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
        "mode": "notification",
        "protocolRef": "uart_rx_stream"
      }
    ],
    "writeCharacteristic": {
      "serviceUUID": "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
      "characteristicUUID": "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
      "writeType": "withoutResponse"
    }
  }
}
```

### 多 Characteristic 数据聚合

当多个 Characteristic 的数据需要合并为一个事件时，在 Protocol Schema 中声明聚合规则：

```json
{
  "channels": {
    "event": {
      "aggregation": {
        "windowMs": 100,
        "mergeCharacteristics": ["2a6e", "2a6f"],
        "outputMessageType": "ENVIRONMENT_DATA",
        "outputFields": {
          "temperature": { "from": "2a6e", "field": "value" },
          "humidity":    { "from": "2a6f", "field": "value" }
        }
      }
    }
  }
}
```

### UUID 规范化工具

```typescript
function normalizeUUID(uuid: string): string {
  // 统一转为不含横线的小写（noble 格式）
  return uuid.replace(/-/g, '').toLowerCase();
}

function expandShortUUID(shortUUID: string): string {
  // 标准 16-bit UUID 扩展为完整 128-bit
  // 0x1800 → 00001800-0000-1000-8000-00805f9b34fb
  const base = '00001000-8000-00805f9b34fb';
  return `0000${shortUUID.padStart(4, '0')}-${base}`;
}
```

---

## Constraints

- UUID 在代码中统一用小写无横线格式（noble 格式），比较时**必须**先 `normalizeUUID()` 再对比
- 订阅失败（不支持 notify、Characteristic 不存在）**必须**单独记录 warn，**禁止**静默忽略，也**禁止**因单个失败中断整体连接
- 断连后重新连接时**必须**重新执行 Service Discovery + 重新订阅（BLE 协议要求，不能假设上次状态保留）
- BLE 扫描时间久，`BleScanner` 的 `attached`/`detached` 基于 RSSI 超时必须做 debounce（3s），防止信号抖动误判
- `noble` 在 Windows 只支持 Bluetooth 4.0+ 适配器，且 Node.js 进程全局只能有一个 noble 实例
- 超过 MTU 的数据（分包传输）必须在 Protocol Layer 负责重组，Transport 只传递原始分包

---

## Examples

### BLE 连接与订阅完整时序

```
t=0s:   BleScanner.startScanning({ serviceUUIDs: ['6e400001...'] })
t=2s:   发现目标设备 → DeviceManager.handleAttached()
t=2s:   BleTransport.connect() 开始
t=2.1s: peripheral.connect() 完成
t=2.2s: MTU 协商: 247 bytes
t=2.3s: Service Discovery: 找到 Battery Service + Nordic UART Service
t=2.5s: 订阅 Battery Level Characteristic (0x2A19) → OK
t=2.6s: 订阅 UART TX Characteristic → OK
t=2.6s: DeviceManager 状态 → 'connected'
t=3s:   设备主动上报 Battery Level = 85% → Event Channel → 前端收到 BATTERY_UPDATE 事件
t=5s:   传感器数据流开始 → 每 100ms 收到一次 UART 数据 → Protocol 解析为 SENSOR_DATA 事件
```
