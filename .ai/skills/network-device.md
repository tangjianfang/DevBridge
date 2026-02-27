# Skill: Network Device — 网络设备通信 (TCP/UDP)

## Preconditions

当以下情况发生时激活本 skill：
- 用户实现 TCP/UDP 网络连接的外设（POS 终端、网络打印机、工控网关）
- 涉及 mDNS / SSDP 设备发现
- 用户实现心跳保活、连接池管理
- 处理 TCP 粘包/断包问题
- 涉及 UDP 广播/单播设备通信

---

## Instructions

### TcpTransport 完整实现

```typescript
class TcpTransport extends BaseTransport {
  readonly transportType = 'tcp' as const;
  private socket?: net.Socket;
  private heartbeatTimer?: NodeJS.Timeout;
  private receiveBuffer = Buffer.alloc(0); // 粘包处理缓冲

  async connect(config: TcpConfig): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();

      const timeout = setTimeout(() => {
        this.socket?.destroy();
        reject(new Error(`TCP_CONNECT_TIMEOUT: ${config.host}:${config.port}`));
      }, config.connectTimeout ?? 5000);

      this.socket.connect(config.port, config.host, () => {
        clearTimeout(timeout);
        this.onConnected(config);
        resolve();
      });

      this.socket.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private onConnected(config: TcpConfig): void {
    this._connected = true;

    this.socket!.on('data', (chunk: Buffer) => {
      // TCP 是流协议，需要粘包处理
      this.receiveBuffer = Buffer.concat([this.receiveBuffer, chunk]);
      this.processReceiveBuffer();
    });

    this.socket!.on('close', () => {
      this._connected = false;
      this.emit('close', 'socket_closed');
    });

    this.socket!.on('error', (err) => {
      this.emit('error', err);
    });

    if (config.keepAlive !== false) {
      this.socket!.setKeepAlive(true, config.keepAliveInterval ?? 30_000);
      this.startHeartbeat(config.heartbeatConfig);
    }

    this.emit('open');
  }

  // Protocol 的 framing 配置决定如何从 receiveBuffer 中提取完整帧
  private processReceiveBuffer(): void {
    // 具体的帧边界识别逻辑由 Protocol Layer 注入的 framingExtractor 处理
    // Transport 只负责把字节流传递给 Protocol
    // 这里简化处理：直接 emit（实际项目中用 Protocol 注入的 Parser Transform）
    this.emit('data', this.receiveBuffer);
    this.receiveBuffer = Buffer.alloc(0);
  }

  private startHeartbeat(config?: HeartbeatConfig): void {
    const interval = config?.interval ?? 10_000;
    const timeout = config?.timeout ?? 5_000;

    this.heartbeatTimer = setInterval(async () => {
      if (!config?.payload) return;
      try {
        await Promise.race([
          this.send(Buffer.from(config.payload, 'hex')),
          sleep(timeout).then(() => { throw new Error('HEARTBEAT_TIMEOUT'); })
        ]);
      } catch {
        this.socket?.destroy();
        this.emit('close', 'heartbeat_timeout');
      }
    }, interval);
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
}
```

### UdpTransport 实现

```typescript
class UdpTransport extends BaseTransport {
  readonly transportType = 'tcp' as const; // 共用 'tcp' 类型，通过 config.protocol 区分
  private socket?: dgram.Socket;

  async connect(config: UdpConfig): Promise<void> {
    this.socket = dgram.createSocket('udp4');

    this.socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      this.emitEvent(msg, `udp:${rinfo.address}:${rinfo.port}`);
    });

    this.socket.on('error', (err) => this.emit('error', err));

    // UDP 无连接，bind 本地端口准备接收
    await promisify(this.socket.bind.bind(this.socket))(config.localPort ?? 0);
    this._connected = true;
    this.emit('open');
  }

  async send(buffer: Buffer): Promise<void> {
    await promisify(this.socket!.send.bind(this.socket!))(
      buffer, 0, buffer.length, this.config!.port, this.config!.host
    );
  }
}
```

### TcpScanner — mDNS 设备发现

```typescript
class TcpScanner extends EventEmitter implements IDeviceScanner {
  private bonjour?: Bonjour;
  private staticDevices: RawDeviceInfo[] = [];

  async scan(): Promise<RawDeviceInfo[]> {
    // 1. 加载静态配置的网络设备
    this.staticDevices = await configService.getStaticNetworkDevices();
    return this.staticDevices;
  }

  startWatching(): void {
    this.bonjour = new Bonjour();

    // 监听 DevBridge 自定义 mDNS 服务
    const browser = this.bonjour.find({ type: 'DevBridge' });
    browser.on('up', (service) => {
      this.emit('attached', {
        transportType: 'tcp',
        name: service.name,
        address: `${service.addresses[0]}:${service.port}`,
        metadata: { txtRecord: service.txt }
      });
    });
    browser.on('down', (service) => {
      this.emit('detached', {
        transportType: 'tcp',
        address: `${service.addresses[0]}:${service.port}`
      });
    });

    // 同时监听常见打印机 mDNS 服务
    this.bonjour.find({ type: 'printer' }, (service) => {
      this.emit('attached', this.mdnsToRawDevice(service));
    });
  }

  stopWatching(): void {
    this.bonjour?.destroy();
  }
}
```

### Plugin Manifest TCP 配置示例

```json
{
  "name": "pos-terminal",
  "transportType": "tcp",
  "tcpConfig": {
    "host": "192.168.1.100",
    "port": 9100,
    "connectTimeout": 5000,
    "keepAlive": true,
    "heartbeatConfig": {
      "interval": 10000,
      "timeout": 3000,
      "payload": "00"
    }
  }
}
```

---

## Constraints

- TCP 是流式协议，**必须**在 Protocol Layer 实现帧边界识别（不能直接 emit chunk）；Transport 层只负责原始字节流
- 心跳超时判定为连接断开，**必须**触发 `close` 事件并清理 socket
- 静态 IP 设备重连时**禁止**无限同步阻塞（必须异步重连，不阻塞主进程）
- UDP 无 CONNECT 概念，`isConnected()` 对 UDP 返回 `socket.bound` 状态
- mDNS 发现的设备地址可能有多个（多网卡），按优先级（局域网 IPv4 优先）选择

---

## Examples

### ESC/POS 网络打印机配置

```json
{
  "framing": { "mode": "stateless" },
  "channels": {
    "command": {
      "request": {
        "fields": [{ "name": "raw", "type": "bytes" }]
      }
    }
  },
  "commands": {
    "CUT_PAPER":   { "payload": "1d5601" },
    "FEED_LINE":   { "payload": "0a" },
    "RESET":       { "payload": "1b40" }
  }
}
```
