# Skill: USB Native — USB 原生通信 (libusb)

## Preconditions

当以下情况发生时激活本 skill：
- 用户需要 libusb 级别的低层 USB 访问（非 HID 设备）
- 涉及 Bulk Transfer、Interrupt Transfer、Control Transfer、Isochronous Transfer
- 用户需要 Claim/Release Interface
- 涉及 USB Descriptor 读取（Device/Configuration/Interface/Endpoint）
- 处理需要自定义 USB 驱动的复杂设备

---

## Instructions

### Transfer 类型选择指南

| Transfer 类型 | 用途 | 特点 | 典型设备 |
|--------------|------|------|---------|
| **Control** | 配置和控制命令 | 有确认机制，低速，优先级最高 | 设备初始化、获取 Descriptor |
| **Interrupt** | 小量周期性数据 | 低延迟（< 1ms 轮询间隔），有限带宽 | HID 设备、键鼠 |
| **Bulk** | 大量数据传输 | 高带宽，无时序保证，有错误重传 | 打印机、存储设备、数据采集 |
| **Isochronous** | 实时流数据 | 固定带宽，无重传（丢包可接受）| 音视频设备（DevBridge 通常不需要）|

### UsbNativeTransport 实现

```typescript
class UsbNativeTransport extends BaseTransport {
  readonly transportType = 'usb-native' as const;
  private device?: usb.Device;
  private claimedInterfaces: usb.Interface[] = [];
  private inEndpoints: usb.InEndpoint[] = [];
  private outEndpoints: usb.OutEndpoint[] = [];

  async connect(config: UsbNativeConfig): Promise<void> {
    // 1. 查找设备
    this.device = usb.findByIds(config.vendorId, config.productId);
    if (!this.device) throw new Error(`USB_DEVICE_NOT_FOUND: VID=${config.vendorId} PID=${config.productId}`);

    // 2. 打开设备
    this.device.open();

    // 3. 读取 Device Descriptor（可选）
    const descriptor = this.device.deviceDescriptor;
    logger.debug({ vendorId: descriptor.idVendor, productId: descriptor.idProduct,
                   manufacturer: await this.getStringDescriptor(descriptor.iManufacturer),
                   product: await this.getStringDescriptor(descriptor.iProduct) },
                  'usb_device_opened');

    // 4. 激活配置（通常是配置 1）
    if (this.device.configDescriptor?.bConfigurationValue !== 1) {
      await promisify(this.device.setConfiguration.bind(this.device))(1);
    }

    // 5. Claim 需要的 Interface
    for (const ifaceConfig of config.interfaces) {
      await this.claimInterface(ifaceConfig);
    }

    this._connected = true;
    this.emit('open');
  }

  private async claimInterface(ifaceConfig: InterfaceConfig): Promise<void> {
    const iface = this.device!.interface(ifaceConfig.index);

    // Linux: 先剥离内核驱动
    if (process.platform !== 'win32' && iface.isKernelDriverActive()) {
      iface.detachKernelDriver();
    }

    iface.claim();
    this.claimedInterfaces.push(iface);

    // 6. 枚举并初始化 Endpoint
    for (const endpoint of iface.endpoints) {
      if (endpoint.direction === 'in') {
        const inEp = endpoint as usb.InEndpoint;
        this.inEndpoints.push(inEp);

        if (ifaceConfig.transferType === 'interrupt' || inEp.transferType === usb.LIBUSB_TRANSFER_TYPE_INTERRUPT) {
          // Interrupt IN: startPoll 持续接收
          inEp.startPoll(ifaceConfig.numTransfers ?? 4, ifaceConfig.packetSize ?? 64);
          inEp.on('data', (buffer: Buffer) => {
            this.emitEvent(buffer, `interface${ifaceConfig.index}:ep${inEp.address}`);
          });
          inEp.on('error', (err) => this.emit('error', err));
        }
        // Bulk IN: 按需 transfer
      } else {
        this.outEndpoints.push(endpoint as usb.OutEndpoint);
      }
    }
  }

  // Control Transfer（设备初始化、获取状态）
  async controlTransfer(
    requestType: number,
    request: number,
    value: number,
    index: number,
    data: Buffer | number
  ): Promise<Buffer | undefined> {
    return new Promise((resolve, reject) => {
      this.device!.controlTransfer(requestType, request, value, index, data,
        (err, result) => err ? reject(err) : resolve(result as Buffer | undefined));
    });
  }

  // Bulk OUT / Interrupt OUT（命令发送）
  async send(buffer: Buffer): Promise<void> {
    const outEp = this.outEndpoints[0];
    if (!outEp) throw new Error('USB_NO_OUT_ENDPOINT');

    return new Promise((resolve, reject) => {
      outEp.transfer(buffer, (err) => err ? reject(err) : resolve());
    });
  }

  // Bulk IN（按需读取，非轮询模式）
  async bulkRead(endpointAddress: number, length: number): Promise<Buffer> {
    const ep = this.inEndpoints.find(e => e.address === endpointAddress);
    if (!ep) throw new Error(`USB_ENDPOINT_NOT_FOUND: 0x${endpointAddress.toString(16)}`);

    return new Promise((resolve, reject) => {
      ep.transfer(length, (err, data) => err ? reject(err) : resolve(data!));
    });
  }

  async disconnect(): Promise<void> {
    // 停止所有 Interrupt IN Poll
    for (const ep of this.inEndpoints) {
      try { ep.stopPoll(); } catch { /* ignore */ }
    }
    // Release 所有 Interface
    for (const iface of this.claimedInterfaces) {
      try {
        await promisify(iface.release.bind(iface))();
      } catch { /* ignore */ }
    }
    this.device?.close();
    this._connected = false;
  }

  private async getStringDescriptor(index: number): Promise<string> {
    return new Promise((resolve) => {
      this.device!.getStringDescriptor(index, (err, str) => resolve(err ? '' : (str ?? '')));
    });
  }
}
```

### Plugin Manifest USB Native 配置

```json
{
  "name": "custom-data-acquisition",
  "transportType": "usb-native",
  "isolation": "child-process",
  "usbNativeConfig": {
    "vendorId": 4292,
    "productId": 60000,
    "interfaces": [
      {
        "index": 0,
        "transferType": "bulk",
        "packetSize": 512,
        "numTransfers": 8
      },
      {
        "index": 1,
        "transferType": "interrupt",
        "packetSize": 64,
        "numTransfers": 4
      }
    ]
  }
}
```

---

## Constraints

- **必须**在 `disconnect()` 中停止所有 Interrupt IN Poll 和 Release 所有 Claimed Interface，防止资源泄漏
- Windows 下若设备使用 Microsoft Generic HID 驱动，无法用 libusb 访问；需用 Zadig 替换驱动（在诊断中提示）
- `device.open()` 前**禁止**调用任何 Interface 操作（会导致 libusb 崩溃）
- Isochronous Transfer 在 DevBridge 中通常不需要；如需实现，必须使用 `node-usb` 的 `createIsochronousTransfer` API
- 与 USB HID Transport 同一设备**禁止**同时打开（libusb 和系统 HID 驱动冲突），通过 `isolation: 'child-process'` 隔离崩溃风险
- libusb 在 Node.js 主进程使用时可能影响 Event Loop，**建议**在 Child Process 中运行 USB Native 驱动

---

## Examples

### 读取 USB 设备的 Vendor-Specific Control Transfer

```typescript
// 发送 Vendor 请求（requestType 0x40 = Vendor OUT, bmRequestType）
await transport.controlTransfer(
  0x40,  // bmRequestType: Vendor | Host-to-Device | Device
  0x01,  // bRequest: 自定义命令 ID
  0x0001, // wValue
  0x0000, // wIndex
  Buffer.from([0xAA, 0x55]) // data
);

// 读取响应（requestType 0xC0 = Vendor IN）
const response = await transport.controlTransfer(
  0xC0, 0x02, 0x0000, 0x0000,
  16  // 期望读取 16 字节
);
```
