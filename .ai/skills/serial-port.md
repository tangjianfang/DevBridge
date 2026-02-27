# Skill: Serial Port — 串口通信 (RS-232 / RS-485)

## Preconditions

当以下情况发生时激活本 skill：
- 用户实现串口设备连接、读写
- 涉及 COM 端口枚举和热插拔检测
- 用户配置波特率、数据位、停止位、奇偶校验
- 用户使用 `serialport` 库及其 Parser 体系
- 处理串口特有的帧同步问题（缓冲区、粘包、断帧）

---

## Instructions

### SerialTransport 实现

```typescript
class SerialTransport extends BaseTransport {
  readonly transportType = 'serial' as const;
  private port?: SerialPort;
  private parser?: Transform;

  async connect(config: SerialConfig): Promise<void> {
    this.port = new SerialPort({
      path: config.path,
      baudRate: config.baudRate,
      dataBits: config.dataBits ?? 8,
      stopBits: config.stopBits ?? 1,
      parity: config.parity ?? 'none',
      autoOpen: false,
    });

    await promisify(this.port.open.bind(this.port))();

    // 挂载 Parser（帧边界识别，由 Protocol Schema 的 framing 配置决定）
    this.parser = this.createParser(config.parserConfig);
    this.port.pipe(this.parser);

    this.parser.on('data', (frame: Buffer) => {
      // 所有串口数据先视为 Event Channel（设备主动上报）
      // Protocol Layer 会根据内容路由到正确 channel
      this.emitEvent(frame, 'serial-frame');
    });

    this.port.on('close', () => {
      this._connected = false;
      this.emit('close', 'port_closed');
    });
    this.port.on('error', (err) => this.emit('error', err));

    this._connected = true;
    this.emit('open');
  }

  private createParser(config?: ParserConfig): Transform {
    if (!config) return new ReadlineParser({ delimiter: '\r\n' });

    switch (config.mode) {
      case 'delimiter':
        return new DelimiterParser({ delimiter: Buffer.from(config.delimiter, 'hex') });
      case 'readline':
        return new ReadlineParser({ delimiter: config.delimiter ?? '\r\n' });
      case 'byteLength':
        return new ByteLengthParser({ length: config.length! });
      case 'lengthPrefix':
        return new LengthPrefixParser({
          lengthField: { offset: config.lengthOffset!, size: config.lengthSize ?? 1 },
          lengthIncludes: config.lengthIncludes ?? 'payload'
        });
      case 'regex':
        return new RegexParser({ regex: new RegExp(config.pattern!) });
      default:
        return new InterByteTimeoutParser({ interval: 30 }); // 最通用：30ms 间隔分帧
    }
  }

  async send(buffer: Buffer): Promise<void> {
    if (!this.port?.isOpen) throw new Error('TRANSPORT_NOT_CONNECTED');
    await promisify(this.port.write.bind(this.port))(buffer);
    await promisify(this.port.drain.bind(this.port))(); // 等待数据写入硬件缓冲
  }

  async disconnect(): Promise<void> {
    if (this.port?.isOpen) {
      await promisify(this.port.close.bind(this.port))();
    }
    this._connected = false;
  }

  getCapabilities() {
    return { canSubscribe: true, canRequest: true, canBroadcast: false,
             maxPacketSize: 4096, isWireless: false };
  }
}
```

### SerialScanner — 枚举与热插拔

```typescript
class SerialScanner extends EventEmitter implements IDeviceScanner {
  private knownPorts = new Map<string, PortInfo>();
  private pollTimer?: NodeJS.Timeout;
  private readonly POLL_INTERVAL = 1000; // ms

  async scan(): Promise<RawDeviceInfo[]> {
    const ports = await SerialPort.list();
    for (const port of ports) {
      this.knownPorts.set(port.path, port);
    }
    return ports.map(this.toRawDeviceInfo);
  }

  startWatching(): void {
    this.pollTimer = setInterval(async () => {
      const currentPorts = await SerialPort.list();
      const currentPaths = new Set(currentPorts.map(p => p.path));
      const knownPaths = new Set(this.knownPorts.keys());

      // 新增端口
      for (const port of currentPorts) {
        if (!knownPaths.has(port.path)) {
          this.knownPorts.set(port.path, port);
          this.emit('attached', this.toRawDeviceInfo(port));
        }
      }

      // 消失端口
      for (const path of knownPaths) {
        if (!currentPaths.has(path)) {
          this.knownPorts.delete(path);
          this.emit('detached', { transportType: 'serial', address: path });
        }
      }
    }, this.POLL_INTERVAL);
  }

  stopWatching(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }
}
```

### Parser 选择指南

| 协议类型 | 推荐 Parser | 配置示例 |
|---------|-----------|---------|
| ASCII 文本行（`\r\n` 结尾）| `ReadlineParser` | `{ delimiter: '\r\n' }` |
| 固定分隔符（如 `0x0D 0x0A`）| `DelimiterParser` | `{ delimiter: Buffer.from([0x0D, 0x0A]) }` |
| 固定长度帧 | `ByteLengthParser` | `{ length: 16 }` |
| 长度前缀（帧头含长度字段）| `LengthPrefixParser` | `{ lengthOffset: 2, lengthSize: 2 }` |
| 时间间隔分帧（不规则协议）| `InterByteTimeoutParser` | `{ interval: 30 }` |
| 魔术字节帧头 | 自定义 Transform | 继承 `Transform` 实现状态机 |

### RS-485 多点通信注意事项

- RS-485 总线上可能有多个设备（多点），需要 **地址帧** 区分（通常 Modbus 规范）
- 发送前先 assert RTS（`port.set({ rts: true })`），发送完成后 deassert
- 部分 USB-485 转换器自动处理 RTS，无需手动控制
- Modbus RTU：帧间隔至少 3.5 个字符时间，使用 `InterByteTimeoutParser` 配合帧头检测

---

## Constraints

- Parser 配置**必须**来自 Protocol Schema 的 `framing` 字段，**禁止**在 Transport 中硬编码
- `port.drain()` 必须在 `port.write()` 之后调用，确保缓冲数据写入硬件（特别是高波特率场景）
- Serial 不支持 `subscribe(endpointId)` 接口（串口是单一数据流），`subscribeAll()` 启动后自动接收所有数据
- 串口枚举轮询间隔默认 1s，**禁止**设置低于 500ms（避免频繁系统调用影响性能）
- 多台串口设备时，每台各自独享一个 `SerialPort` 实例，**禁止**多台设备共用一个串口

---

## Examples

### 接入称重仪（ASCII 协议，CRLF 分帧）

Protocol Schema `framing` 配置：
```json
{
  "framing": {
    "mode": "readline",
    "delimiter": "\r\n"
  },
  "channels": {
    "event": {
      "weight_report": {
        "frameRegex": "^([+-]?\\d+\\.?\\d*)([KGkgLlPp]{2})$",
        "fields": [
          { "name": "weight", "type": "ascii", "extract": "group[1]", "toFloat": true },
          { "name": "unit",   "type": "ascii", "extract": "group[2]" }
        ]
      }
    }
  }
}
```

### 接入 Modbus RTU 设备（PLC）

Protocol Schema `framing` 配置：
```json
{
  "framing": {
    "mode": "interByteTimeout",
    "interval": 5
  },
  "checksum": {
    "algorithm": "crc16-modbus",
    "position": "trailer",
    "size": 2
  },
  "channels": {
    "command": {
      "request": {
        "fields": [
          { "name": "address",      "type": "uint8" },
          { "name": "functionCode", "type": "uint8" },
          { "name": "registerAddr", "type": "uint16be" },
          { "name": "quantity",     "type": "uint16be" },
          { "name": "crc",          "type": "uint16le", "algorithm": "crc16-modbus" }
        ]
      }
    }
  }
}
```
