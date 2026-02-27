# Skill: USB HID Transport — USB HID 通信与 Endpoint Hook

## Preconditions

当以下情况发生时激活本 skill：
- 用户实现 USB HID 设备连接、读写
- 涉及 HID Report Descriptor 解析
- 区分标准 HID 和自定义 HID 协议
- 用户需要 Hook Interrupt IN Endpoint 持续监听
- 涉及 Input/Output/Feature Report 操作
- 用户使用 `node-hid` 或 `usb` (libusb) 库

---

## Instructions

### 库选择策略

| 场景 | 使用库 | 理由 |
|------|--------|------|
| 标准 HID（单 Interface）| `node-hid` | 走系统 HID 驱动，Windows 无需额外驱动 |
| 自定义 HID（多 Interface/Endpoint）| `usb` (libusb) | 低层访问，可 Claim 指定 Interface |
| 两者都需要（复合设备）| `usb` 优先 + `node-hid` 枚举 | `usb` 控制 Interface，`node-hid` 读写 HID 报告 |

### HID Report Descriptor 解析与设备分类

```typescript
// packages/shared/src/hid-parser/report-descriptor-parser.ts
export class HidReportDescriptorParser {

  static async getDescriptor(vendorId: number, productId: number): Promise<Buffer | null> {
    try {
      // 方法 1: node-hid（推荐，走系统驱动）
      const hid = new HID.HID(vendorId, productId);
      return hid.getDeviceInfo().reportDescriptor ?? null;
    } catch {
      // 方法 2: usb libusb（fallback）
      return this.getDescriptorViaLibusb(vendorId, productId);
    }
  }

  static parse(descriptorBuffer: Buffer): HidDescriptorInfo {
    const fields: HidField[] = [];
    let usagePage = 0;
    let usage = 0;
    let reportId: number | undefined;

    // 解析 HID Report Descriptor（短 item 格式: 1字节 tag/type/size + data）
    let i = 0;
    while (i < descriptorBuffer.length) {
      const byte = descriptorBuffer[i]!;
      const tag = (byte >> 4) & 0x0F;
      const type = (byte >> 2) & 0x03;
      const size = byte & 0x03;
      const dataSize = size === 3 ? 4 : size;
      const data = descriptorBuffer.readUIntLE(i + 1, dataSize || 1);
      i += 1 + (dataSize || 0);

      if (type === 1) { // Global item
        if (tag === 0x00) usagePage = data; // Usage Page
        if (tag === 0x08) reportId = data;  // Report ID
      } else if (type === 0) { // Local item
        if (tag === 0x00) usage = data;     // Usage
      } else if (type === 2) { // Main item
        if (tag === 0x08 || tag === 0x09 || tag === 0x0B) { // Input/Output/Feature
          fields.push({ usagePage, usage, reportId, itemType: ['input','output','feature'][tag - 8]! });
        }
      }
    }
    return { fields, primaryUsagePage: fields[0]?.usagePage ?? 0, primaryUsage: fields[0]?.usage ?? 0 };
  }

  static classify(info: HidDescriptorInfo): HidDeviceType {
    const { primaryUsagePage, primaryUsage } = info;
    if (primaryUsagePage >= 0xFF00)          return 'custom';    // Vendor Defined
    if (primaryUsagePage === 0x01) {
      const map: Record<number, HidDeviceType> = {
        0x06: 'keyboard', 0x02: 'mouse', 0x04: 'joystick',
        0x05: 'gamepad', 0x01: 'pointer'
      };
      return map[primaryUsage] ?? 'generic-desktop';
    }
    if (primaryUsagePage === 0x8C) return 'barcode-scanner';
    if (primaryUsagePage === 0x0C) return 'consumer';
    return 'unknown';
  }
}
```

### UsbHidTransport — 三步识别 + Endpoint Hook

```typescript
class UsbHidTransport extends BaseTransport {
  readonly transportType = 'usb-hid' as const;
  private hidDevice?: HID.HID;
  private usbDevice?: usb.Device;            // libusb，复杂设备用
  private hidType: HidDeviceType = 'unknown';

  async connect(config: UsbHidConfig): Promise<void> {
    // Step 1: 尝试解析 Report Descriptor
    const descriptor = await HidReportDescriptorParser.getDescriptor(config.vendorId, config.productId);
    if (descriptor) {
      const info = HidReportDescriptorParser.parse(descriptor);
      this.hidType = HidReportDescriptorParser.classify(info);
    }

    // Step 2: Fallback 到 Plugin 配置声明
    if (this.hidType === 'unknown' && config.hidConfig?.type) {
      this.hidType = config.hidConfig.type;
    }

    // Step 3: 默认当 custom
    if (this.hidType === 'unknown') this.hidType = 'custom';

    logger.info({ deviceId: this.deviceId, hidType: this.hidType }, 'hid_device_classified');

    if (this.hidType === 'custom' && config.interface != null) {
      // 自定义 HID：使用 libusb 精确控制 Interface
      await this.connectViaLibusb(config);
    } else {
      // 标准 HID：node-hid
      await this.connectViaNodeHid(config);
    }
  }

  private async connectViaNodeHid(config: UsbHidConfig): Promise<void> {
    this.hidDevice = new HID.HID(config.vendorId, config.productId);

    // ── Endpoint Hook：持续监听 IN Report ──
    this.hidDevice.on('data', (buffer: Buffer) => {
      // 提取 Report ID（首字节，如果设备使用 Report ID）
      const reportId = buffer[0];
      // 路由到 Event Channel
      this.emitEvent(buffer, `report-${reportId ?? 'default'}`);
    });

    this.hidDevice.on('error', (err) => this.emit('error', err));
    this._connected = true;
    this.emit('open');
  }

  private async connectViaLibusb(config: UsbHidConfig): Promise<void> {
    const device = usb.findByIds(config.vendorId, config.productId);
    if (!device) throw new Error(`DEVICE_NOT_FOUND: VID=${config.vendorId} PID=${config.productId}`);

    device.open();
    this.usbDevice = device;
    const iface = device.interface(config.interface ?? 0);

    // Linux: detach kernel driver
    if (iface.isKernelDriverActive()) iface.detachKernelDriver();
    iface.claim();

    // 找到 Interrupt IN Endpoint
    const inEndpoint = iface.endpoints.find(
      (e) => e.direction === 'in' && (e as usb.InEndpoint).transferType === usb.LIBUSB_TRANSFER_TYPE_INTERRUPT
    ) as usb.InEndpoint | undefined;

    if (!inEndpoint) throw new Error('USB_NO_IN_ENDPOINT');

    // ── Endpoint Hook：持续 Poll ──
    inEndpoint.startPoll(4, 64); // numTransfers=4, transferSize=64
    inEndpoint.on('data', (buffer: Buffer) => {
      this.emitEvent(buffer, `endpoint-${inEndpoint.address}`);
    });
    inEndpoint.on('error', (err) => this.emit('error', err));

    this._connected = true;
    this.emit('open');
  }

  // ── Output Report（Command Channel）──
  async send(buffer: Buffer): Promise<void> {
    if (!this._connected) throw new Error('TRANSPORT_NOT_CONNECTED');
    if (this.hidDevice) {
      // node-hid: buffer[0] 是 Report ID（0 表示无 Report ID）
      this.hidDevice.write(Array.from(buffer));
    } else if (this.usbDevice) {
      // libusb: 找 OUT endpoint 发送
      await this.sendViaLibusbOut(buffer);
    }
  }

  // ── Feature Report（配置/状态，双向）──
  async getFeatureReport(reportId: number, length: number): Promise<Buffer> {
    if (!this.hidDevice) throw new Error('FEATURE_REPORT_REQUIRES_NODE_HID');
    return Buffer.from(this.hidDevice.getFeatureReport(reportId, length));
  }

  async setFeatureReport(buffer: Buffer): Promise<void> {
    if (!this.hidDevice) throw new Error('FEATURE_REPORT_REQUIRES_NODE_HID');
    this.hidDevice.sendFeatureReport(Array.from(buffer));
  }

  async disconnect(): Promise<void> {
    this.hidDevice?.close();
    this.usbDevice?.close();
    this._connected = false;
  }
}
```

### Plugin Manifest HID 配置示例

```json
{
  "hidConfig": {
    "type": "custom",
    "interface": 1,
    "reportRouting": {
      "0x01": "status_report",
      "0x02": "sensor_data",
      "0x03": "error_report"
    }
  }
}
```

---

## Constraints

- Windows 下标准 HID 设备被系统 HID 驱动独占，**必须**用 `node-hid`（走 HidD API），不能用 libusb
- 自定义 HID 若需要 libusb 访问，Windows 下需用 Zadig 将驱动替换为 WinUSB / libusb-win32（在诊断文档中提示用户）
- `HidReportDescriptorParser` 的结果必须缓存，每个设备只解析一次（`Map<string, HidDescriptorInfo>`）
- `inEndpoint.startPoll()` 必须在 `disconnect()` 时调用 `inEndpoint.stopPoll()` 清理
- 复合 HID 设备（多 Interface）需在 Plugin Manifest 中显式声明需要的 Interface ID，不能自动猜测
- `iface.claim()` 前必须检查 `isKernelDriverActive()` 并先 `detachKernelDriver()`（Linux 需要）

---

## Examples

### HID Report ID 路由示例

设备有两种上报格式：
```
Report ID 0x01: 状态上报 [01] [status:uint8] [battery:uint8]
Report ID 0x02: 传感器数据 [02] [value:uint16le] [flags:uint8]
```

Protocol Schema 配置：
```json
{
  "channels": {
    "event": {
      "routing": "reportId",
      "reports": {
        "1": {
          "messageType": "STATUS_UPDATE",
          "fields": [
            { "name": "reportId", "type": "uint8" },
            { "name": "status",   "type": "uint8", "enum": {"0": "IDLE", "1": "ACTIVE"} },
            { "name": "battery",  "type": "uint8", "unit": "percent" }
          ]
        },
        "2": {
          "messageType": "SENSOR_DATA",
          "fields": [
            { "name": "reportId", "type": "uint8" },
            { "name": "value",    "type": "uint16le" },
            { "name": "flags",    "type": "uint8" }
          ]
        }
      }
    }
  }
}
```
