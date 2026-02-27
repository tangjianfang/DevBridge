# Skill: Plugin System — 插件系统

## Preconditions

当以下情况发生时激活本 skill：
- 用户需要为新外设添加支持（zero-code 接入 vs 代码插件）
- 涉及 `IDevicePlugin` 接口的实现
- 用户讨论 Plugin Manifest 结构（match 规则 / reconnect / hidConfig / bleConfig）
- 涉及插件动态加载、卸载、更新
- 需要在不修改核心代码的情况下扩展协议行为

---

## Instructions

### Child Process 生命周期管理原则

**`PluginLoader`（Worker Thread）是所有 Child Process 的唯一创建和销毁入口。**  
`child_process.fork()` 只能在 `PluginLoader` 内部调用，任何其他模块禁止直接 fork。

#### 两条启动路径

```
路径 A：系统级启动（主进程自动）
  Node.js 冷启动
    → DeviceManager 扫描 plugins/ + 读取 devices.json 已配置设备
    → PluginLoader.loadAll()
    → child_process.fork(driverWorker)

路径 B：用户级启动（浏览器命令间接触发）
  浏览器 UI
    → WebSocket / REST
    → GatewayService（主线程，仅转发）
    → MessagePort IPC
    → PluginLoader（Worker Thread）
    → child_process.fork(driverWorker)
```

> fork() 永远由主进程发起，浏览器命令只是触发信号，不直接创建进程。

#### Child Process 操作对应 API

| 操作 | 触发来源 | REST / WS |
|------|---------|-----------|
| 冷启动加载已配置插件 | 主进程自身 | 无（内部调用）|
| 手动绑定设备插件 | 浏览器 | `POST /api/v1/devices/{id}/plugin` |
| 上传插件包并启动 | 浏览器 | `POST /api/v1/plugins/upload` |
| 上传动态 TS 代码热更新 | 浏览器 | `POST /api/v1/plugins/dynamic/{id}/source` |
| 手动重启某个子进程 | 浏览器 | `POST /api/v1/plugins/{id}/restart` |
| 停止并卸载插件 | 浏览器 | `DELETE /api/v1/plugins/{id}` |
| Watchdog 崩溃重启 | 主进程自身 | 无（自动恢复）|

#### PluginLoader 作为统一入口的实现

```typescript
// server/src/plugins/plugin-loader.ts（Worker Thread）

class PluginLoader {
  // 所有存活的 Child Process，按 pluginId 索引
  private processes = new Map<string, ManagedProcess>();

  // ── 路径 A：系统启动时批量加载 ──────────────────────────
  async loadAll(): Promise<void> {
    const dirs = await fs.readdir('plugins', { withFileTypes: true });
    await Promise.allSettled(
      dirs.filter(d => d.isDirectory())
          .map(d => this.startProcess(d.name))
    );
  }

  // ── 路径 B：浏览器命令触发 ───────────────────────────────
  // GatewayService 收到 WS/REST 后通过 MessagePort 转发到此处
  async handleBrowserCommand(cmd: PluginCommand): Promise<void> {
    switch (cmd.type) {
      case 'START':   await this.startProcess(cmd.pluginId); break;
      case 'RESTART': await this.restartProcess(cmd.pluginId); break;
      case 'STOP':    await this.stopProcess(cmd.pluginId); break;
      case 'HOT_UPDATE': await this.hotUpdate(cmd.pluginId, cmd.tsSource); break;
    }
  }

  // ── 核心：唯一的 fork 调用点 ─────────────────────────────
  private async startProcess(pluginId: string): Promise<void> {
    const manifest = await this.loadManifest(pluginId);
    const child = child_process.fork(
      path.join('plugins', pluginId, 'handler.js'),
      [],
      {
        execArgv: ['--disallow-code-generation', '--max-old-space-size=128'],
        env: { PLUGIN_ID: pluginId },  // 不继承父进程 env
      }
    );
    this.processes.set(pluginId, { child, manifest, startedAt: Date.now() });

    // 崩溃自动重启（Watchdog 策略）
    child.on('exit', (code) => this.onProcessExit(pluginId, code));

    // 通知前端进程状态
    this.broadcastStatus(pluginId, 'running', child.pid);
  }
}
```

---

### Plugin 两层接入策略

```
┌─────────────────────────────────────────────────────┐
│  接入方式 1：零代码 (manifest.json + schema)          │
│  适合：协议已有标准规律，Transport 用通用实现          │
├─────────────────────────────────────────────────────┤
│  接入方式 2：代码插件 (IDevicePlugin 实现 + manifest)│
│  适合：需要自定义握手、特殊初始化、状态机扩展          │
└─────────────────────────────────────────────────────┘
```

### IDevicePlugin — 插件接口

```typescript
interface IDevicePlugin {
  readonly name: string;         // 唯一名称，与 manifest.name 一致
  readonly version: string;      // semver

  /**
   * 插件级初始化（首次加载时调用一次）
   * 可在此注册自定义 Parser、校验算法等扩展
   */
  init(registry: IPluginRegistry): Promise<void>;

  /**
   * 设备连接阶段：Transport 建立后调用
   * 可在此执行握手、能力协商、固件版本读取等
   */
  onConnect(device: IConnectedDevice): Promise<void>;

  /**
   * 设备断开前调用：执行优雅关闭（保存状态、发送关闭命令等）
   */
  onBeforeDisconnect(device: IConnectedDevice): Promise<void>;

  /**
   * 设备完全断开后调用：清理内存、关闭文件句柄等
   */
  onDisconnect(device: IConnectedDevice): void;

  /**
   * 插件卸载前调用（热更新或系统关闭时）
   */
  destroy(): Promise<void>;
}

interface IConnectedDevice {
  info: DeviceInfo;
  transport: ITransport;
  protocol: IProtocol;
  sendRaw(data: Buffer): Promise<void>;
  sendCommand(commandId: string, payload?: object): Promise<DeviceResponse>;
}

interface IPluginRegistry {
  registerParser(name: string, factory: ParserFactory): void;
  registerChecksumAlgorithm(name: string, fn: ChecksumFn): void;
  registerCustomField(name: string, codec: FieldCodec): void;
}
```

### Plugin Manifest 完整结构

```json
{
  "name": "acme-sensor-v2",
  "version": "1.2.0",
  "description": "ACME Sensor v2 系列驱动",
  "entrypoint": "handler.js",        // 可选，省略则零代码接入
  "schemaFile": "protocol.schema.json",
  "isolation": "child-process",       // 'worker-thread' | 'child-process'，默认 worker-thread

  "match": {
    "any": [
      { "transport": "usb-hid", "vid": "0x1234", "pid": "0x5678" },
      { "transport": "usb-hid", "vid": "0x1234", "pid": "0x5679" },
      { "transport": "serial", "usbVid": "0x1234" }
    ]
  },

  "reconnect": {
    "maxRetries": 5,
    "retryInterval": 500,
    "backoffMultiplier": 2,
    "maxRetryInterval": 30000
  },

  "hidConfig": {
    "preferLibusb": false,
    "reportIds": {
      "input": [1, 2, 3],
      "output": [4],
      "feature": [5, 6]
    }
  },

  "bleConfig": {
    "services": [
      {
        "uuid": "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
        "characteristics": [
          { "uuid": "6e400002-b5a3-f393-e0a9-e50e24dcca9e", "role": "write" },
          { "uuid": "6e400003-b5a3-f393-e0a9-e50e24dcca9e", "role": "notify" }
        ]
      }
    ]
  },

  "serialConfig": {
    "baudRate": 115200,
    "dataBits": 8,
    "stopBits": 1,
    "parity": "none",
    "parser": "delimiter",
    "parserOptions": { "delimiter": "\r\n" }
  },

  "metadata": {
    "author": "ACME Corp",
    "homepage": "https://acme.example.com/driver",
    "license": "MIT",
    "tags": ["sensor", "usb-hid", "serial"]
  }
}
```

### Match 规则引擎

```typescript
class PluginMatcher {
  /**
   * 找到第一个匹配的 Plugin
   * 匹配优先级：精确 VID+PID > 宽泛 VID only > 仅 transport 类型
   */
  findBestMatch(deviceInfo: DeviceInfo): PluginManifest | undefined {
    const candidates = this.computeMatchScores(deviceInfo);
    if (candidates.length === 0) return undefined;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].manifest;
  }

  private computeMatchScores(
    deviceInfo: DeviceInfo
  ): Array<{ manifest: PluginManifest; score: number }> {
    return [...this.manifests.values()].flatMap(manifest => {
      const rules = manifest.match.any ?? [manifest.match];
      for (const rule of rules) {
        const score = this.scoreRule(rule, deviceInfo);
        if (score > 0) return [{ manifest, score }];
      }
      return [];
    });
  }

  private scoreRule(rule: MatchRule, device: DeviceInfo): number {
    if (rule.transport !== device.transport) return 0;
    let score = 10;
    if (rule.vid && rule.vid !== device.vendorId)  return 0; score += 100;
    if (rule.pid && rule.pid !== device.productId) return 0; score += 200;
    return score;
  }
}
```

### 动态代码热更新（浏览器端上传 TS）

业务逻辑代码可从浏览器上传 TypeScript 源码，服务端即时编译后热替换 Child Process，实现**零停机热更新**。

#### 完整流程

```
浏览器上传 TS 源码
  → REST POST /api/v1/plugins/dynamic/{id}/source
  → PluginLoader (Worker Thread)
      ├─ 1. esbuild 编译 TS → JS（< 50ms）
      ├─ 2. manifest 自动生成（isolation: "child-process" 强制）
      ├─ 3. 写入 plugins/dynamic/{id}/handler.js
      ├─ 4. 排水：等待旧 Child Process 命令队列清空（≤ 2s）
      ├─ 5. SIGTERM 旧进程 → 2s 超时 → SIGKILL
      └─ 6. fork 新 Child Process（加载新 handler.js）
```

#### PluginLoader.hotUpdate() 实现

```typescript
async hotUpdate(id: string, tsSource: string): Promise<void> {
  // Step 1: esbuild 编译 TS → JS
  const outPath = path.join('plugins/dynamic', id, 'handler.js');
  const FORBIDDEN_MODULES = [
    'node-hid', 'serialport', '@abandonware/noble',
    'child_process', 'worker_threads', 'cluster',
  ];

  await esbuild.build({
    stdin: { contents: tsSource, loader: 'ts', resolveDir: process.cwd() },
    outfile: outPath,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    // 禁止模块：esbuild plugin 注入 throw 桩，使其在编译阶段被替换
    // （external 只会推迟到运行时 require，不会阻止加载）
    plugins: [
      {
        name: 'sandbox',
        setup(build) {
          for (const mod of FORBIDDEN_MODULES) {
            build.onResolve(
              { filter: new RegExp(`^${mod.replace('/', '\\/')}$`) },
              () => ({ path: mod, namespace: 'sandbox-stub' })
            );
          }
          build.onLoad({ filter: /.*/, namespace: 'sandbox-stub' }, ({ path }) => ({
            contents: `throw new Error('Module not allowed in plugin sandbox: ${path}');`,
            loader: 'js',
          }));
        },
      },
    ],
  });

  // Step 2: 排水 — 等待旧进程命令队列为空（最多 2s）
  const old = this.childProcesses.get(id);
  if (old) {
    await this.drainCommandQueue(id, 2_000);
    // Step 3: 优雅关闭旧进程（SIGTERM → 2s 超时 → SIGKILL）
    await this.terminateProcess(old, 2_000);
  }

  // Step 4: fork 新进程（不继承父进程 env）
  const child = child_process.fork(outPath, [], {
    execArgv: [
      '--disallow-code-generation',   // 禁止 eval / new Function
      '--max-old-space-size=128',      // 内存上限 128MB
    ],
    env: {
      PLUGIN_ID: id,                   // 只传必要字段，不继承父进程 env
    },
  });
  this.childProcesses.set(id, child);

  // Step 5: 通知前端热更新完成
  gatewayPort.postMessage({ event: 'plugin:hot-updated',
    data: { pluginId: id, status: 'running', pid: child.pid } });

  logger.info({ id, outPath }, 'plugin_hot_updated');
}

private async terminateProcess(proc: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(); }, timeoutMs);
    proc.once('exit', () => { clearTimeout(timer); resolve(); });
    proc.kill('SIGTERM');
  });
}
```

#### handler.ts 模板（用户编写的业务代码）

```typescript
import { createPluginContext } from '@devbridge/plugin-sdk';

const ctx = createPluginContext(process.env.PLUGIN_ID!);

// 接收来自 PluginLoader 的命令
process.on('message', async (msg: PluginMessage) => {
  if (msg.type === 'COMMAND') {
    const result = await handleCommand(ctx, msg.payload);
    process.send!({ type: 'RESULT', correlationId: msg.correlationId, result });
  }
});

// 热更新时：父进程发 SIGTERM，完成当前任务后干净退出
process.on('SIGTERM', async () => {
  await ctx.flush();   // 等待最后一条命令执行完
  process.exit(0);
});

async function handleCommand(ctx: PluginContext, payload: unknown) {
  // 用户自定义业务逻辑
}
```

#### 白名单 SDK（@devbridge/plugin-sdk）

插件代码只能通过官方 SDK 访问设备，禁止直接引用底层模块：

```typescript
// ✅ 允许
import { createPluginContext } from '@devbridge/plugin-sdk';
const ctx = createPluginContext(pluginId);
await ctx.sendCommand('setLed', { color: 0x01 });
const data = await ctx.readReport(0x01);

// ❌ 禁止（esbuild sandbox plugin 将其替换为 throw 桩，编译后直接抛错）
import HID from 'node-hid';            // 直接访问底层硬件
import { exec } from 'child_process';  // 执行系统命令
import fs from 'fs';                    // 直接文件 I/O
import net from 'net';                  // 直接网络访问
```

---

### PluginLoader — 动态加载

```typescript
class PluginLoader {
  private loadedPlugins = new Map<string, { plugin: IDevicePlugin; manifest: PluginManifest }>();

  async loadAll(pluginsDir: string): Promise<void> {
    const entries = await fs.readdir(pluginsDir, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => path.join(pluginsDir, e.name));

    await Promise.all(dirs.map(dir => this.loadFromDir(dir).catch(err =>
      logger.error({ dir, err }, 'plugin_load_failed')
    )));
  }

  async loadFromDir(pluginDir: string): Promise<void> {
    const manifestPath = path.join(pluginDir, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as PluginManifest;

    // 验证 manifest 结构
    const parsed = PluginManifestZod.safeParse(manifest);
    if (!parsed.success) {
      throw new Error(`Plugin manifest invalid: ${JSON.stringify(parsed.error.flatten())}`);
    }

    // 加载 Protocol Schema
    if (manifest.schemaFile) {
      const schemaPath = path.join(pluginDir, manifest.schemaFile);
      await protocolHotLoader.loadFile(schemaPath);
    }

    // 加载代码插件（可选）
    let plugin: IDevicePlugin | undefined;
    if (manifest.entrypoint) {
      const entryPath = path.join(pluginDir, manifest.entrypoint);
      const mod = await import(entryPath);
      plugin = new mod.default() as IDevicePlugin;
      await plugin.init(pluginRegistryApi);
    }

    this.loadedPlugins.set(manifest.name, { plugin: plugin!, manifest });
    pluginMatcher.registerManifest(manifest);

    logger.info({ name: manifest.name, version: manifest.version,
                  hasCode: !!manifest.entrypoint }, 'plugin_loaded');
  }

  async updatePlugin(manifest: PluginManifest): Promise<void> {
    const existing = this.loadedPlugins.get(manifest.name);

    // 先销毁旧插件
    if (existing?.plugin) {
      await existing.plugin.destroy().catch(err =>
        logger.warn({ name: manifest.name, err }, 'plugin_destroy_error')
      );
    }

    // 重新加载
    await this.loadFromDir(path.dirname(/* pluginDir preserved */manifest.name));
  }
}
```

### 零代码接入示例

对于遵循标准协议的设备（如 CRLF 分隔的称重仪），只需提供两个文件：

```
plugins/
  acme-scale/
    manifest.json             ← 声明 match + serialConfig
    protocol.schema.json      ← 声明 frames, fields, commands
```

不需要任何 TypeScript/JavaScript 代码，系统会自动：
1. 用 `SerialTransport` + `SerialScanner` 发现并连接设备
2. 用 `ProtocolRuntimeEngine.compile(schema)` 生成 encode/decode
3. 通过 `DeviceChannel` 暴露标准 REST + WebSocket API

---

## Constraints

- Plugin `match` 规则**必须**至少包含一个 `transport` 字段，禁止完全通配（避免意外劫持所有设备）
- `IDevicePlugin.onConnect()` 超时上限 10s，超时视为连接失败，Transport 自动断开
- `IDevicePlugin.destroy()` 超时上限 5s，超时强制终止
- 代码插件运行在与设备对应的 Worker Thread / Child Process 中，**禁止**直接访问主进程内存
- manifest 中的 `name` 字段**必须**全局唯一，与 Protocol Schema 的 `name` 命名空间共享冲突检测
- Plugin 目录结构**必须**扁平：`plugins/<plugin-name>/manifest.json`，不允许嵌套目录作为 Plugin 根
- 零代码插件（无 `entrypoint`）**禁止**在 manifest 或 schema 中引用外部文件路径（安全沙箱）

---

## Examples

### 代码插件 onConnect 示例（自定义握手）

```typescript
class AcmeSensorPlugin implements IDevicePlugin {
  readonly name = 'acme-sensor-v2';
  readonly version = '1.2.0';

  async init(registry: IPluginRegistry): Promise<void> {
    // 注册自定义 XOR-16 校验算法
    registry.registerChecksumAlgorithm('acme-xor16', (buf) => {
      let sum = 0;
      for (const b of buf) sum ^= (b << 8) | b;
      return Buffer.from([sum >> 8, sum & 0xFF]);
    });
  }

  async onConnect(device: IConnectedDevice): Promise<void> {
    // 发送握手包，获取固件版本
    const resp = await device.sendCommand('get_version');
    logger.info({ deviceId: device.info.id, fwVersion: resp.payload }, 'acme_firmware_version');

    // 激活数据上报
    await device.sendCommand('set_report_rate', { hz: 100 });
  }

  async onBeforeDisconnect(device: IConnectedDevice): Promise<void> {
    await device.sendCommand('set_report_rate', { hz: 0 }).catch(() => {});
  }

  onDisconnect(_device: IConnectedDevice): void {}

  async destroy(): Promise<void> {}
}
export default AcmeSensorPlugin;
```
