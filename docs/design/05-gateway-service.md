# 设计文档 05 — GatewayService

> **所属模块**: `packages/server/src/gateway/`  
> **线程模型**: **Main Thread 专属**（Fastify + ws 必须在 Main Thread 运行）  
> **类型定义**: `packages/shared/src/types/gateway.d.ts`

---

## 1. 架构约束

- GatewayService **只在 Main Thread 运行**，禁止移入 Worker Thread
- 与其他 Worker 的通信**只通过 `MessagePort` 转发**，不直接操作设备/协议逻辑
- 所有跨 Worker 调用以 IPC 消息完成，等待回调通过 `correlationId` 路由

```
Browser                Main Thread (GatewayService)             Workers
  │                           │                                    │
  │── REST / WS ─────────────►│                                    │
  │                           │── IPC MessagePort ────────────────►│
  │                           │◄─ IPC MessagePort ─────────────────│
  │◄── Response / WS push ────│                                    │
```

---

## 2. Auth 模式

| 模式 | 监听地址 | 认证方式 | 适用场景 |
|------|---------|---------|---------|
| `local` | `127.0.0.1` | 无需 Token | 开发机本地 UI |
| `lan` | `0.0.0.0` | `X-DevBridge-Key` 请求头 | 局域网多客户端 |

```typescript
export interface Settings {
  mode:       'local' | 'lan';
  port:       number;                  // 默认 7070
  apiKey?:    string;                  // mode='lan' 必填；mode='local' 忽略
  cors: {
    enabled:   boolean;
    origins:   string[];               // 允许的 Origin，支持通配符 '*'
  };
  rateLimit: {
    max:       number;                 // 每个 IP 每分钟最大请求数
    timeWindow: string;                // '1 minute' 等 Fastify 时间字符串
  };
}
```

---

## 3. REST API 全集

> 所有接口统一前缀：`/api/v1`  
> 响应格式：成功 `{ "data": T }`，失败 `{ "error": { "code": string, "message": string, "details"?: unknown } }`

### 3.1 设备管理

| Method | Path | 说明 | 请求体 / 参数 | 响应 data |
|--------|------|------|-------------|----------|
| GET | `/devices` | 列出所有设备 | — | `DeviceInfo[]` |
| GET | `/devices/:id` | 获取单台设备详情 | — | `DeviceInfo` |
| POST | `/devices/:id/connect` | 手动连接 | — | `{ deviceId, status }` |
| POST | `/devices/:id/disconnect` | 手动断开 | — | `{ deviceId, status }` |
| POST | `/devices/:id/command` | 发送命令（同步等待响应） | `{ commandId, params, timeoutMs? }` | `CommandResult` |
| POST | `/devices/broadcast` | 广播命令到多台设备 | `{ commandId, params, deviceIds }` | `BroadcastResult` |
| GET | `/devices/:id/history` | 获取事件历史（最近 200 条） | `?limit=&offset=` | `DeviceEvent[]` |

### 3.2 插件管理

| Method | Path | 说明 | 请求体 / 参数 | 响应 data |
|--------|------|------|-------------|----------|
| GET | `/plugins` | 列出所有已加载插件 | — | `PluginInfo[]` |
| POST | `/plugins` | 从 manifest 路径加载插件 | `{ manifestPath: string }` | `PluginInfo` |
| DELETE | `/plugins/:id` | 卸载插件 | — | `{ pluginId }` |
| POST | `/plugins/upload` | 上传插件 zip 包 | `multipart/form-data` | `PluginInfo` |
| POST | `/plugins/:id/source` | 动态更新插件源码（热重载） | `{ source: string }` | `PluginInfo` |
| POST | `/plugins/:id/restart` | 重启插件进程 | — | `PluginInfo` |
| POST | `/devices/:id/plugin` | 手动为设备指定插件 | `{ pluginId: string }` | `DeviceInfo` |

### 3.3 协议管理

| Method | Path | 说明 | 请求体 / 参数 | 响应 data |
|--------|------|------|-------------|----------|
| GET | `/protocols` | 列出所有已注册协议 | — | `string[]` |
| POST | `/protocols` | 上传并加载新协议 | `{ name, schema: ProtocolSchema }` | `{ name, version }` |
| PUT | `/protocols/:name` | 更新协议（触发热重载） | `{ schema: ProtocolSchema }` | `{ name, version }` |
| DELETE | `/protocols/:name` | 删除协议 | — | `{ name }` |

### 3.4 系统

| Method | Path | 说明 | 请求体 / 参数 | 响应 data |
|--------|------|------|-------------|----------|
| GET | `/system/health` | 汇总各 Worker 健康状态 | — | `Record<string, ServiceHealth>` |
| GET | `/system/metrics` | 当前系统指标快照 | — | `MetricsSnapshot` |
| GET | `/system/diagnostics` | 获取最近诊断结果 | `?limit=` | `DiagnosticResult[]` |
| POST | `/system/diagnostics/run` | 立即运行一次全量诊断 | — | `DiagnosticResult` |
| GET | `/system/settings` | 读取当前 Settings | — | `Settings` |
| PUT | `/system/settings` | 更新 Settings（部分字段） | `Partial<Settings>` | `Settings` |
| POST | `/system/config/export` | 导出全量配置 JSON | — | `string`（JSON 文件内容） |
| POST | `/system/config/import` | 导入配置（暂存，待确认） | `{ config: string }` | `{ previewId: string }` |
| POST | `/system/config/confirm` | 确认应用导入的配置 | `{ previewId: string }` | `{ applied: true }` |
| GET | `/system/update` | 检查更新 | — | `{ current, latest, hasUpdate }` |
| POST | `/system/update` | 开始下载并安装更新 | — | `{ jobId }` |

---

## 4. WebSocket 事件全集

> WS 连接地址：`ws://host:port/ws`  
> 鉴权（lan 模式）：WS URL query 参数 `?key=<apiKey>` 或首帧发送 `{ type: "auth", key: "..." }`

### 4.1 Server → Client（S→C）

| type | 触发时机 | payload 关键字段 |
|------|---------|-----------------|
| `device:connected` | 设备首次进入 connected 状态 | `{ device: DeviceInfo }` |
| `device:disconnected` | 设备进入 disconnected 状态 | `{ deviceId, reason? }` |
| `device:reconnecting` | 开始重连 | `{ deviceId, attempt, nextRetryMs }` |
| `device:removed` | 设备被移除 | `{ deviceId }` |
| `device:status` | 任意状态变更（非上述专用类型） | `{ deviceId, status, ...extra }` |
| `device:event` | 设备主动上报事件（Text Frame） | `{ deviceId, eventId, fields, timestamp }` |
| `device:response` | 命令响应（异步 WS 模式） | `CommandResult`（含 correlationId） |
| `notification` | 系统通知（警告/信息/错误） | `{ id, severity, message, timestamp }` |
| `metrics:update` | 每 5s 广播一次指标 | `MetricsSnapshot` |
| `diagnostics:result` | 诊断完成 | `DiagnosticResult` |
| `plugin:status` | 插件状态变更 | `{ pluginId, status, deviceId? }` |
| `update:progress` | OTA 更新进度 | `{ jobId, percent, stage }` |
| `protocol:updated` | 协议热重载成功 | `{ name, version }` |

### 4.2 Client → Server（C→S）

| type | 说明 | payload |
|------|------|---------|
| `device:command` | 发送命令（WS 异步模式，不等 HTTP 响应）| `{ deviceId, commandId, params, correlationId }` |
| `device:subscribe` | 订阅指定设备事件 | `{ deviceId, endpointIds?: string[] }` |
| `device:unsubscribe` | 取消订阅 | `{ deviceId }` |
| `packettap:subscribe` | 订阅 Binary Frame（PacketTap）| `{ deviceId }` |
| `packettap:unsubscribe` | 取消 Binary Frame 订阅 | `{ deviceId }` |

---

## 5. Binary Frame 格式

```
Offset  Size  Field
──────  ────  ─────────────────────────────
0       4     Magic = 0x44 0x42 0x52 0x47  ("DBRG")
4       4     Frame type (uint32-le)
              0x0001 = packet-tap (原始抓包)
              0x0002 = metrics
              0x0003 = diagnostics-raw
8       16    Device ID (UTF-8, 16 bytes, 不足补 0x00)
24      8     Timestamp (uint64-le, Unix ms)
32      N     Payload (原始字节，依 Frame type 解析)
```

> 总头部固定 32 字节，Payload 长度由 WS 消息总长度减 32 得出。

---

## 6. WS 连接生命周期

```typescript
// packages/server/src/gateway/gateway-service.ts（核心片段）

export class GatewayService implements IService {
  private fastify!: FastifyInstance;
  private wsClients = new Map<string, WsConnection>();
  private packetTapSubscriptions = new Map<string, Set<string>>(); // deviceId → Set<clientId>

  async start(settings: Settings): Promise<void> {
    this.fastify = Fastify({ logger: false });
    await this.fastify.register(fastifyWebsocket);
    await this.fastify.register(fastifyCors, settings.cors);
    await this.fastify.register(fastifyRateLimit, settings.rateLimit);

    this.registerRoutes();

    this.fastify.get('/ws', { websocket: true }, (socket, _req) => {
      const clientId = crypto.randomUUID();
      const conn: WsConnection = { socket, clientId, subscriptions: new Set() };
      this.wsClients.set(clientId, conn);

      socket.on('message', (raw) => this.onWsMessage(conn, raw));
      socket.on('close',   ()    => this.wsClients.delete(clientId));
      socket.on('error',   (err) => log.warn('WS client error', { clientId, err }));
    });

    const addr = settings.mode === 'lan' ? '0.0.0.0' : '127.0.0.1';
    await this.fastify.listen({ port: settings.port, host: addr });
  }

  async stop(): Promise<void> {   // 幂等
    for (const [, c] of this.wsClients) c.socket.close();
    await this.fastify?.close();
  }

  async health(): Promise<ServiceHealth> {
    return { status: 'ok', details: { wsClients: this.wsClients.size } };
  }

  broadcast(type: string, payload: unknown): void {
    const msg = JSON.stringify({ type, payload });
    for (const [, c] of this.wsClients) {
      if (c.socket.readyState === WebSocket.OPEN) c.socket.send(msg);
    }
  }

  broadcastBinaryFrame(frame: ArrayBuffer): void {
    for (const [, c] of this.wsClients) {
      if (c.socket.readyState === WebSocket.OPEN) c.socket.send(frame);
    }
  }

  private onWsMessage(conn: WsConnection, raw: Buffer | string): void {
    try {
      const msg = JSON.parse(raw.toString()) as { type: string; payload: unknown };
      switch (msg.type) {
        case 'device:command':
          workerPort.postMessage({ type: 'COMMAND_SEND', payload: msg.payload });
          break;
        case 'device:subscribe':
          conn.subscriptions.add((msg.payload as { deviceId: string }).deviceId);
          workerPort.postMessage({ type: 'SUBSCRIBE_EVENTS', payload: msg.payload });
          break;
        case 'device:unsubscribe':
          conn.subscriptions.delete((msg.payload as { deviceId: string }).deviceId);
          break;
        case 'packettap:subscribe':
          this.addPacketTapSub(conn.clientId, (msg.payload as { deviceId: string }).deviceId);
          break;
        case 'packettap:unsubscribe':
          this.removePacketTapSub(conn.clientId, (msg.payload as { deviceId: string }).deviceId);
          break;
      }
    } catch { /* 忽略非法 JSON */ }
  }

  private addPacketTapSub(clientId: string, deviceId: string): void {
    const set = this.packetTapSubscriptions.get(deviceId) ?? new Set<string>();
    set.add(clientId);
    this.packetTapSubscriptions.set(deviceId, set);
  }

  private removePacketTapSub(clientId: string, deviceId: string): void {
    this.packetTapSubscriptions.get(deviceId)?.delete(clientId);
  }
}

interface WsConnection {
  socket:        WebSocket;
  clientId:      string;
  subscriptions: Set<string>;  // 订阅的 deviceId 集合
}
```

---

## 7. HTTP 状态码约定

| 场景 | HTTP 状态码 |
|------|-----------|
| 成功（有返回体） | 200 OK |
| 成功（无返回体，如 DELETE） | 204 No Content |
| 参数校验失败 | 400 Bad Request |
| 未鉴权或 API Key 无效 | 401 Unauthorized |
| 权限不足 | 403 Forbidden |
| 资源不存在 | 404 Not Found |
| 资源状态冲突 | 409 Conflict |
| 无法处理（业务逻辑错误）| 422 Unprocessable Entity |
| 请求过于频繁（rate limit）| 429 Too Many Requests |
| 服务内部错误 | 500 Internal Server Error |
| 服务暂不可用（重连中）| 503 Service Unavailable |
| 命令超时 | 504 Gateway Timeout |

---

## 8. 错误码全集 — GATEWAY_*

| 错误码 | 触发场景 | HTTP 状态码 |
|--------|---------|-----------|
| `GATEWAY_AUTH_FAILED` | lan 模式 API Key 无效 | 401 |
| `GATEWAY_RATE_LIMIT` | 请求频率超限 | 429 |
| `GATEWAY_INVALID_REQUEST` | 请求体 JSON Schema 校验失败 | 400 |
| `GATEWAY_WORKER_TIMEOUT` | Worker IPC 响应超过 10s | 504 |

---

## 9. 测试要点

- **auth local**：不带 Key 访问 `127.0.0.1`，断言 200
- **auth lan 缺 key**：访问 `0.0.0.0` 不带 `X-DevBridge-Key`，断言 401
- **rate limit**：60s 内超过 max 次请求，断言第 max+1 次返回 429
- **WS device:command**：发送后等待 `device:response` 含相同 correlationId
- **packettap:subscribe**：订阅后 Worker 发 BINARY_FRAME，断言客户端收到 ArrayBuffer，前 4 字节 = DBRG
- **broadcast()**：连接 3 个 WS 客户端，调用 broadcast()，断言 3 个均收到相同消息
- **stop() 幂等**：调用两次 stop()，不抛错
