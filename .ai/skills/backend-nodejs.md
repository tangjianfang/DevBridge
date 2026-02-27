# Skill: Backend Node.js — 服务端架构与 API 设计

## Preconditions

当以下情况发生时激活本 skill：
- 用户需要配置 Fastify 服务器（插件注册、路由挂载、WebSocket 升级）
- 涉及完整 REST API 端点列表（/api/v1/devices、/logs、/metrics、/diagnostics、/config）
- 用户讨论服务启动顺序（ServiceRegistry 拓扑排序依赖）
- 涉及 WebSocket 服务端消息路由和客户端管理
- 涉及 PM2 / Windows Service 部署配置
- 用户需要理解 Fastify 插件化封装 Transport 服务

---

## Instructions

### Fastify 服务器配置

```typescript
// packages/server/src/server.ts

import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyHelmet from '@fastify/helmet';

export async function createServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,    // 使用 pino 自有 logger，不用 fastify 内置
    trustProxy: true, // LAN 部署时信任代理
    bodyLimit: 1024 * 1024, // 1MB 请求体上限（抓包导入等）
  });

  // 安全头
  await app.register(fastifyHelmet, { contentSecurityPolicy: false });

  // 跨域（开发时允许 Vite dev server）
  await app.register(fastifyCors, {
    origin: process.env.NODE_ENV === 'development' ? true : false,
  });

  // WebSocket 支持
  await app.register(fastifyWebsocket, {
    options: { maxPayload: 1024 * 256 }, // 256KB
  });

  // 静态文件（生产构建）
  if (process.env.NODE_ENV === 'production') {
    await app.register(fastifyStatic, {
      root: path.join(__dirname, '../../client/dist'),
      prefix: '/',
    });
  }

  // 注册路由模块
  await app.register(deviceRoutes,      { prefix: '/api/v1' });
  await app.register(logRoutes,         { prefix: '/api/v1' });
  await app.register(metricsRoutes,     { prefix: '/api/v1' });
  await app.register(diagnosticsRoutes, { prefix: '/api/v1' });
  await app.register(configRoutes,      { prefix: '/api/v1' });
  await app.register(devtoolsRoutes,    { prefix: '/api/v1' });
  await app.register(wsRoutes);         // WebSocket 升级在独立路由

  return app;
}
```

### WebSocket 服务端 — 消息路由

```typescript
// packages/server/src/routes/ws.ts

class WsServer {
  private clients = new Map<string, WebSocket>(); // clientId → ws

  registerRoutes(app: FastifyInstance): void {
    app.get('/ws', { websocket: true }, (connection) => {
      const clientId = crypto.randomUUID();
      this.clients.set(clientId, connection.socket);
      logger.info({ clientId }, 'ws_client_connected');

      connection.socket.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as WsMessage<unknown>;
        this.handleMessage(clientId, msg).catch(err =>
          logger.error({ clientId, err }, 'ws_message_error')
        );
      });

      connection.socket.on('close', () => {
        this.clients.delete(clientId);
        // 清理该 client 的 tap session、device subscriptions
        packetTap.clearClientSessions(clientId);
        deviceSubscriptionManager.unsubscribeAll(clientId);
        logger.info({ clientId }, 'ws_client_disconnected');
      });

      // 初始化：发送当前设备列表快照
      this.send(clientId, {
        type: 'init:snapshot',
        payload: {
          devices: [...deviceManager.listDevices()],
          serverVersion: process.env.APP_VERSION,
        }
      });
    });
  }

  private async handleMessage(clientId: string, msg: WsMessage<unknown>): Promise<void> {
    switch (msg.type) {
      case 'device:command': {
        const { deviceId, commandId, params, correlationId } = msg.payload as CommandPayload;
        const resp = await deviceManager.sendCommand(deviceId, commandId, params);
        this.send(clientId, { type: 'device:response', payload: { ...resp, correlationId } });
        break;
      }
      case 'device:subscribe': {
        const { deviceId } = msg.payload as { deviceId: string };
        deviceSubscriptionManager.subscribe(clientId, deviceId);
        break;
      }
      case 'device:unsubscribe': {
        const { deviceId } = msg.payload as { deviceId: string };
        deviceSubscriptionManager.unsubscribe(clientId, deviceId);
        break;
      }
      default:
        logger.warn({ clientId, type: msg.type }, 'ws_unknown_message_type');
    }
  }

  /** 广播给所有在线客户端 */
  broadcast(msg: WsMessage<unknown>): void {
    const str = JSON.stringify(msg);
    for (const ws of this.clients.values()) {
      if (ws.readyState === WebSocket.OPEN) ws.send(str);
    }
  }

  send(clientId: string, msg: WsMessage<unknown>): void {
    const ws = this.clients.get(clientId);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }
}

export const wsServer = new WsServer();
```

### 完整 REST API 端点

```typescript
// packages/server/src/routes/devices.ts
async function deviceRoutes(app: FastifyInstance): Promise<void> {
  // 设备列表
  app.get('/devices', async () => deviceManager.listDevices());

  // 设备详情
  app.get('/devices/:id', async (req) =>
    deviceManager.getDevice((req.params as { id: string }).id));

  // 手动断开
  app.post('/devices/:id/disconnect', async (req) => {
    await deviceManager.disconnect((req.params as { id: string }).id);
    return { ok: true };
  });

  // 手动重连
  app.post('/devices/:id/reconnect', async (req) => {
    await deviceManager.reconnect((req.params as { id: string }).id);
    return { ok: true };
  });

  // 发送命令
  app.post('/devices/:id/commands', async (req) => {
    const { commandId, params } = req.body as { commandId: string; params?: object };
    return deviceManager.sendCommand((req.params as { id: string }).id, commandId, params);
  });

  // 设备通信历史
  app.get('/devices/:id/records', async (req) => {
    const { limit, direction, fromTs, toTs } = req.query as RecordQuery;
    return communicationRecorder.query({
      deviceId: (req.params as { id: string }).id,
      limit: Number(limit) || 100,
      direction: direction as 'in' | 'out' | undefined,
      fromTs: fromTs ? Number(fromTs) : undefined,
      toTs: toTs ? Number(toTs) : undefined,
    });
  });
}

// packages/server/src/routes/logs.ts
async function logRoutes(app: FastifyInstance): Promise<void> {
  app.get('/logs/recent',   async (req) => logManager.getRecent(req.query as LogQuery));
  app.get('/logs/download', async (req, reply) => {
    const stream = logManager.getFileStream(req.query as LogDownloadQuery);
    return reply.type('text/plain').send(stream);
  });
}

// packages/server/src/routes/metrics.ts
async function metricsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/metrics/latency',    async (req) =>
    metricsCollector.getLatencyPercentiles(Number((req.query as { window?: string }).window) || 60_000));
  app.get('/metrics/prometheus', async (_req, reply) =>
    reply.type('text/plain').send(metricsCollector.getPrometheusMetrics()));
  app.get('/metrics/system',     async () => ({
    cpu: process.cpuUsage(),
    memory: process.memoryUsage(),
    uptime: process.uptime(),
  }));
}

// packages/server/src/routes/diagnostics.ts
async function diagnosticsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/diagnostics',           async () => diagnosticEngine.runAll());
  app.get('/diagnostics/:transport',async (req) =>
    diagnosticEngine.runForTransport((req.params as { transport: TransportType }).transport));
}

// packages/server/src/routes/config.ts
async function configRoutes(app: FastifyInstance): Promise<void> {
  app.get('/config',         async () => configManager.getAll());
  app.patch('/config',       async (req) => configManager.update(req.body as ConfigPatch));
  app.get('/config/export',  async (_req, reply) => {
    const zipPath = await configManager.exportConfig(os.tmpdir());
    return reply.type('application/zip').sendFile(zipPath);
  });
  app.post('/config/import/preview', { /* multipart */ }, async (req) =>
    configManager.previewImport(await req.file()));
  app.post('/config/import/apply', async (req) => {
    const { zipPath, selectedPaths } = req.body as ImportApplyBody;
    await configManager.applyImport(zipPath, selectedPaths);
    return { ok: true };
  });
}
```

### 服务启动顺序（ServiceRegistry 拓扑排序）

```typescript
// packages/server/src/main.ts

async function main(): Promise<void> {
  // 1. 初始化日志（最先）
  await logManager.init(config.logsDir);
  const logger = createLogger('main');

  // 2. Sentry 初始化
  initSentry();

  // 3. 环境诊断（discovery phase）
  logger.info('Running startup diagnostics...');
  const report = await diagnosticEngine.runAll();
  if (report.results.some(r => r.status === 'fail' && r.severity === 'critical')) {
    logger.error({ failedChecks: report.results.filter(r => r.status === 'fail') },
      'Critical diagnostics failed, aborting startup');
    process.exit(1);
  }

  // 4. Protocol Registry + 热加载
  await protocolHotLoader.start([config.protocolsDir]);

  // 5. Plugin Loader
  await pluginLoader.loadAll(config.pluginsDir);
  pluginHotLoader.start(config.pluginsDir);

  // 6. DeviceManager（启动各 Transport Scanner）
  await deviceManager.start();

  // 7. 通信历史记录器（可选）
  if (config.enableRecording) {
    await communicationRecorder.init(path.join(config.dataDir, 'records.db'));
  }

  // 8. Fastify HTTP + WebSocket 服务器
  const app = await createServer();
  await app.listen({ port: config.httpPort, host: config.httpHost });
  logger.info({ url: `http://${config.httpHost}:${config.httpPort}` }, 'server_started');

  // 9. Graceful Shutdown
  process.on('SIGTERM', () => shutdown(app));
  process.on('SIGINT',  () => shutdown(app));
}

async function shutdown(app: FastifyInstance): Promise<void> {
  const logger = createLogger('shutdown');
  logger.info('Graceful shutdown initiated...');

  await app.close();                         // 停止接受新连接
  await deviceManager.stopAll();             // 断开所有设备
  await logManager.flush();                  // 刷新日志缓冲
  await communicationRecorder.close?.();     // 关闭 SQLite
  logger.info('Shutdown complete');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
```

### PM2 / Windows Service 部署

```yaml
# ecosystem.config.yml (PM2)
apps:
  - name: DevBridge-server
    script: packages/server/dist/main.js
    instances: 1          # 设备通信服务不能多实例
    autorestart: true
    watch: false
    max_memory_restart: 512M
    env:
      NODE_ENV: production
      LOG_LEVEL: info
      APP_PORT: 3000
    env_production:
      NODE_ENV: production
      SENTRY_DSN: 'https://...'
```

```powershell
# Windows Service (node-windows)
# scripts/install-service.js
const Service = require('node-windows').Service;
const svc = new Service({
  name: 'DevBridge Server',
  description: 'Universal Hardware Interface Platform',
  script: path.join(__dirname, '../packages/server/dist/main.js'),
  nodeOptions: ['--max-old-space-size=512'],
  env: [{ name: 'NODE_ENV', value: 'production' }],
});
svc.on('install', () => svc.start());
svc.install();
```

---

## Constraints

- Fastify 路由**必须**以 `async function` 的独立模块形式注册（`app.register()`），**禁止**在 `createServer()` 中写内联路由
- WebSocket `/ws` 端点的所有 `connection.socket` 引用**必须**在 `close` 事件中从 `clients` Map 中删除，防止内存泄漏
- REST API 的响应状态码：成功 200（查询/操作）、创建 201、参数错误 400、未找到 404、服务器错误 500
- 所有需要 `devtools: true` feature flag 的路由（`/api/v1/devtools/*`）**必须**检查环境变量，生产环境默认禁用
- 服务启动失败（`critical` 诊断失败）**必须**以非零退出码终止（`process.exit(1)`），不允许忽略继续启动
- Fastify 的 `logger: false` 是必须的，**禁止**同时启用 fastify 内置日志和 pino（双重日志问题）
- `instances: 1` 在 PM2 配置中是硬性约束，设备通信服务**禁止**多实例部署（设备独占访问冲突）

---

## Examples

### API 调用清单

```
# 设备管理
GET    /api/v1/devices                        → DeviceInfo[]
GET    /api/v1/devices/:id                    → DeviceInfo
POST   /api/v1/devices/:id/disconnect         → { ok: true }
POST   /api/v1/devices/:id/reconnect          → { ok: true }
POST   /api/v1/devices/:id/commands           → DeviceResponse
GET    /api/v1/devices/:id/records            → CommRecord[]

# 日志
GET    /api/v1/logs/recent?lines=200&level=warn
GET    /api/v1/logs/download?date=2025-01-15

# 指标
GET    /api/v1/metrics/latency?window=60000   → LatencyPercentiles
GET    /api/v1/metrics/prometheus             → Prometheus exposition
GET    /api/v1/metrics/system                 → CPU/Memory/Uptime

# 诊断
GET    /api/v1/diagnostics                    → DiagnosticReport
GET    /api/v1/diagnostics/usb-hid            → DiagnosticResult[]

# 配置
GET    /api/v1/config                         → ConfigSnapshot
PATCH  /api/v1/config                         → { ok: true }
GET    /api/v1/config/export                  → application/zip
POST   /api/v1/config/import/preview          → ConfigDiff[]
POST   /api/v1/config/import/apply            → { ok: true }

# DevTools（feature flag）
POST   /api/v1/devtools/tap/:deviceId         → TapSession
DELETE /api/v1/devtools/tap/:sessionId        → { ok: true }
POST   /api/v1/devtools/tap/:sessionId/record/start
POST   /api/v1/devtools/tap/:sessionId/record/stop → JSONL 下载
POST   /api/v1/devtools/replay/:deviceId      → { ok: true }
POST   /api/v1/devtools/send-raw              → { ok: true, responseHex? }
```
