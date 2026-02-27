# 设计文档 06 — PluginLoader

> **所属模块**: `packages/server/src/plugin-loader/`  
> **线程模型**: Worker Thread（PluginLoaderWorker）负责编译/验证；Child Process（PluginHandlerProcess）负责运行插件代码  
> **类型定义**: `packages/shared/src/types/plugin.d.ts`

---

## 1. PluginManifest 完整接口

```typescript
// packages/shared/src/types/plugin.d.ts

export interface PluginManifest {
  id:          string;              // 全局唯一，推荐 '@vendor/plugin-name'
  version:     string;              // semver
  name:        string;              // 显示名称
  description?: string;
  author?:     string;

  // 传输层匹配规则（第一个 match 决定使用该 manifest 的传输类型）
  match: MatchRule[];

  // 各传输类型专属配置（按 transportType 选用其中一个）
  hidConfig?: {
    vendorId:   number;
    productId:  number;
    usagePage?: number;
    usage?:     number;
  };
  serialConfig?: {
    baudRate:  number;
    dataBits?: 5 | 6 | 7 | 8;
    parity?:   string;
    parser?:   string;
    parserOptions?: Record<string, unknown>;
  };
  bleConfig?: {
    serviceUUIDPrefix: string;
    requiredCharacteristics?: string[];
  };
  tcpConfig?: {
    defaultPort: number;
    heartbeatPayloadHex?: string;
  };
  usbConfig?: {
    vendorId:    number;
    productId:   number;
    configurationValue?: number;
    interfaces:  number[];
  };
  ffiConfig?: {
    dlls: { id: string; path: string; stability: 'stable' | 'unstable' }[];
    functions: { name: string; returnType: string; argTypes: string[] }[];
    callbacks?: { name: string; returnType: string; argTypes: string[] }[];
    pollIntervalMs?: number;
  };

  // 关联协议名称
  protocol?: string;

  // 插件入口文件（相对 manifest 目录）
  entry:      string;               // 如 'index.ts' 或 'dist/index.js'
  isolation?: boolean;              // 默认 true；true = 独占 Child Process；false 可仅允许连接同一 stable-group
}

export type MatchRule =
  | { transport: 'usb-hid';    vendorId: number; productId?: number }
  | { transport: 'serial';     pathPattern: string }                    // glob
  | { transport: 'ble';        namePrefix?: string; serviceUUID?: string }
  | { transport: 'tcp';        portRange?: [number, number] }
  | { transport: 'usb-native'; vendorId: number; productId?: number }
  | { transport: 'ffi';        dllPattern: string };                    // glob
```

---

## 2. IDevicePlugin 生命周期

```typescript
// packages/plugin-sdk/src/index.ts

export interface PluginContext {
  readonly deviceId: string;
  readonly manifest: PluginManifest;

  sendCommand(commandId: string, params: Record<string, unknown>): Promise<CommandResult>;
  readReport(reportId?: number): Promise<Buffer>;
  writeReport(reportId: number, data: Buffer): Promise<void>;
  onEvent(callback: (event: DeviceEvent) => void): () => void;  // 返回 unsubscribe
  logger: {
    info(msg: string, meta?: Record<string, unknown>): void;
    warn(msg: string, meta?: Record<string, unknown>): void;
    error(msg: string, meta?: Record<string, unknown>): void;
  };
  flush(): Promise<void>;  // 等待所有 pending 命令完成，graceful-stop 用
}

export interface IDevicePlugin {
  // 插件初始化（Child Process 启动后调用一次）
  init(ctx: PluginContext): Promise<void>;

  // 设备进入 connected 状态时调用
  onConnect(ctx: PluginContext, info: DeviceInfo): Promise<void>;

  // 设备准备断开前调用（graceful stop）
  onBeforeDisconnect(ctx: PluginContext): Promise<void>;

  // 设备完成断开后调用
  onDisconnect(ctx: PluginContext, reason: string): Promise<void>;

  // Child Process 退出前调用（资源清理）
  destroy(ctx: PluginContext): Promise<void>;
}

// 插件暴露的工厂函数（每个插件入口文件必须默认导出）
export type PluginFactory = (ctx: PluginContext) => IDevicePlugin;
```

### 2.1 生命周期时序

```
PluginLoader Worker          Child Process (PluginHandler)
      │                               │
      │  fork()  ─────────────────►  │
      │                               │  require(entry) → 加载插件代码
      │  IPC: PLUGIN_INIT ──────────► │  plugin.init(ctx)
      │◄── IPC: PLUGIN_READY ─────── │
      │
      │  [设备进入 connected]
      │  IPC: PLUGIN_CONNECT ───────► │  plugin.onConnect(ctx, info)
      │◄── IPC: PLUGIN_CONNECT_DONE ──│
      │
      │  [热更新触发]
      │  IPC: PLUGIN_HOT_UPDATE ────► │  esbuild 重新编译
      │                               │  plugin.onBeforeDisconnect(ctx)
      │                               │  → 替换模块引用
      │                               │  → plugin.onConnect(ctx, info)  ← 新版本
      │◄── IPC: PLUGIN_HOT_UPDATED ───│
      │
      │  [插件卸载 / 服务停止]
      │  IPC: PLUGIN_STOP ─────────► │  plugin.onBeforeDisconnect(ctx)
      │                               │  plugin.onDisconnect(ctx, reason)
      │                               │  plugin.destroy(ctx)
      │◄── IPC: PLUGIN_STOPPED ────── │
      │  process.kill(child.pid)      │
```

---

## 3. PluginLoader 状态机

```
                    加载 manifest
  idle ──────────────────────────────► loading
   ▲                                      │
   │  卸载成功                            │ 编译成功 + 往返测试通过
   │                                      ▼
stopping ◄────────── running ◄────── (fork Child Process)
   ▲          卸载请求    │
   │                      │ 意外崩溃 (exit code != 0)
   │                      ▼
   │  重启成功         crashed
   │                      │  重启次数 < maxRestarts
   │                      ▼
   └────────────────  restarting
                           │ 重启次数达到 maxRestarts
                           ▼
                         error（需人工干预）

[停止中过渡态]
running → draining（等待 flush()）→ stopping → idle
```

### 3.1 PluginInfo 运行时类型

```typescript
export interface PluginInfo {
  pluginId:     string;
  version:      string;
  status:       'idle' | 'loading' | 'running' | 'draining' | 'stopping'
                | 'crashed' | 'restarting' | 'error';
  manifestPath: string;
  pid?:         number;              // Child Process PID
  assignedDevices: string[];         // 正在管理的 deviceId 列表
  restartCount:    number;
  lastError?:      string;
  loadedAt?:       number;
}
```

---

## 4. hotUpdate() 实现

```typescript
// packages/server/src/plugin-loader/plugin-loader.ts（核心片段）

const FORBIDDEN_MODULES = [
  'node-hid', 'serialport', '@abandonware/noble',
  'child_process', 'worker_threads', 'cluster'
] as const;

export class PluginLoader implements IService {
  private plugins = new Map<string, ChildProcess>();
  private infos   = new Map<string, PluginInfo>();

  async hotUpdate(pluginId: string, newSource: string): Promise<PluginInfo> {
    const info = this.getInfo(pluginId);
    info.status = 'loading';

    try {
      // 1. esbuild 编译（带 sandboxPlugin）
      const compiled = await build({
        stdin:    { contents: newSource, loader: 'ts' },
        bundle:   true,
        format:   'cjs',
        platform: 'node',
        write:    false,
        plugins:  [sandboxPlugin(FORBIDDEN_MODULES)],
      });

      // 2. 往返测试（在独立 vm 沙箱中验证插件导出）
      await this.validatePluginExports(compiled.outputFiles[0].text);

      // 3. 将新代码写入临时文件
      const tmpPath = path.join(os.tmpdir(), `devbridge-plugin-${pluginId}-${Date.now()}.cjs`);
      await fs.promises.writeFile(tmpPath, compiled.outputFiles[0].text, 'utf-8');

      // 4. 通知 Child Process 热替换（不 kill 进程）
      const child = this.plugins.get(pluginId)!;
      child.send({ type: 'PLUGIN_HOT_UPDATE', payload: { tmpPath } } satisfies IPCMessage);

      // 5. 等待 Child Process 确认
      await this.waitForIPC(child, 'PLUGIN_HOT_UPDATED', 10000);

      info.status  = 'running';
      info.version = /* 从新 manifest 读取 */ info.version;
      this.sendStatusIPC(info);
      return info;

    } catch (err) {
      info.status    = 'error';
      info.lastError = (err as Error).message;
      this.sendStatusIPC(info);
      throw err;
    }
  }

  private async validatePluginExports(cjsCode: string): Promise<void> {
    const { Script } = await import('vm');
    const mod = { exports: {} as Record<string, unknown> };

    // 运行时禁用模块拦截：补充 esbuild AST 拦截的盲区（动态 require(variable) 等运行时行为）
    const RUNTIME_FORBIDDEN = [
      'child_process', 'worker_threads', 'cluster',
      'node-hid', 'serialport', '@abandonware/noble',
    ];
    const sandboxRequire = (mod: string): never => {
      if (RUNTIME_FORBIDDEN.some(f => mod === f || mod.startsWith(f + '/'))) {
        throw new Error(`[DevBridge] Plugin is not allowed to use '${mod}'.`);
      }
      throw new Error(`[DevBridge] require() is not available in sandbox validation context.`);
    };

    const fn = new Script(`(function(module,exports,require){${cjsCode}\n})`);
    // timeout: 3000ms 防止使用曠循环或 CPU-spin 导致 Worker 挂起（DoS）
    fn.runInNewContext({}, { timeout: 3000 })(                         // ← 修复：无超时设置
      { exports: mod.exports, module: mod }, mod.exports, sandboxRequire
    );
    if (typeof mod.exports['default'] !== 'function') {
      throw new Error('Plugin must default-export a PluginFactory function');
    }
  }

  private waitForIPC(child: ChildProcess, type: string, timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`IPC timeout waiting for ${type}`)), timeout
      );
      const handler = (msg: IPCMessage) => {
        if (msg.type === type) { clearTimeout(timer); child.off('message', handler); resolve(); }
      };
      child.on('message', handler);
    });
  }
}
```

### 4.1 sandboxPlugin()

```typescript
// packages/server/src/plugin-loader/sandbox-plugin.ts

import type { Plugin } from 'esbuild';

export function sandboxPlugin(forbidden: readonly string[]): Plugin {
  return {
    name: 'devbridge-sandbox',
    setup(build) {
      for (const mod of forbidden) {
        build.onResolve({ filter: new RegExp(`^${mod.replace('/', '\\/')}$`) }, () => ({
          path:      mod,
          namespace: 'devbridge-sandbox-stub',
        }));
      }
      build.onLoad({ filter: /.*/, namespace: 'devbridge-sandbox-stub' }, (args) => ({
        contents: `module.exports = new Proxy({}, {
  get(_t, prop) {
    throw new Error('[DevBridge] Plugin is not allowed to use \\'${args.path}\\'. ' +
      'Use PluginContext API (sendCommand / readReport / writeReport / onEvent) instead.');
  }
});`,
        loader: 'js',
      }));
    },
  };
}
```

---

## 5. @devbridge/plugin-sdk API

```typescript
// packages/plugin-sdk/src/index.ts（公开导出）

export { PluginContext, IDevicePlugin, PluginFactory } from './types';

export function createPluginContext(pluginId: string): PluginContext {
  // 在 Child Process 内通过 IPC 代理调用实际能力
  return {
    deviceId: process.env['DEVBRIDGE_DEVICE_ID']!,
    manifest: JSON.parse(process.env['DEVBRIDGE_MANIFEST']!),

    async sendCommand(commandId, params) {
      return ipcRpc({ type: 'COMMAND_SEND', payload: { commandId, params } });
    },
    async readReport(reportId) {
      const res = await ipcRpc({ type: 'READ_REPORT', payload: { reportId } });
      return Buffer.from(res.buffer);
    },
    async writeReport(reportId, data) {
      await ipcRpc({ type: 'WRITE_REPORT', payload: { reportId, data } });
    },
    onEvent(callback) {
      const handler = (msg: IPCMessage) => {
        if (msg.type === 'DEVICE_EVENT') callback(msg.payload as DeviceEvent);
      };
      process.on('message', handler as NodeJS.MessageListener);
      return () => process.off('message', handler as NodeJS.MessageListener);
    },
    logger: {
      info:  (msg, meta) => process.send!({ type: 'LOG_ENTRY', payload: { level: 'info',  msg, meta } }),
      warn:  (msg, meta) => process.send!({ type: 'LOG_ENTRY', payload: { level: 'warn',  msg, meta } }),
      error: (msg, meta) => process.send!({ type: 'LOG_ENTRY', payload: { level: 'error', msg, meta } }),
    },
    async flush() {
      await ipcRpc({ type: 'FLUSH_PENDING', payload: {} }, 30000);
    },
  };
}
```

---

## 6. PluginMatcher 评分算法

```typescript
// packages/server/src/plugin-loader/plugin-matcher.ts

export class PluginMatcher {
  /**
   * 为 rawDevice 从 manifests 中找出最佳匹配插件。
   * 评分规则：
   *   transport 类型匹配  : +10 pts
   *   vendorId  精确匹配  : +100 pts
   *   productId 精确匹配  : +200 pts
   *   其余字段（serviceUUID 等）: +50 pts 各
   * 返回评分最高的 PluginManifest；若无匹配则返回 null。
   */
  static match(raw: RawDeviceInfo, manifests: PluginManifest[]): PluginManifest | null {
    let best: { manifest: PluginManifest; score: number } | null = null;

    for (const manifest of manifests) {
      let score = 0;
      for (const rule of manifest.match) {
        if (rule.transport !== raw.transportType) continue;
        score += 10;

        if ('vendorId'  in rule && rule.vendorId  === raw.vendorId)  score += 100;
        if ('productId' in rule && rule.productId === raw.productId) score += 200;
        if ('serviceUUID' in rule &&
            raw.raw && (raw.raw as { serviceUUIDs?: string[] }).serviceUUIDs?.includes(rule.serviceUUID ?? ''))
          score += 50;
        // 其余 rule 字段类推...
      }

      if (score > 0 && (!best || score > best.score)) {
        best = { manifest, score };
      }
    }

    return best?.manifest ?? null;
  }
}
```

---

## 7. IPC 消息表

### PluginLoader 接收（从 Main Thread）

| type | payload | 处理动作 |
|------|---------|---------|
| `PLUGIN_LOAD` | `{ manifestPath: string }` | fork Child Process，加载插件 |
| `PLUGIN_UNLOAD` | `{ pluginId: string }` | graceful drain → stop → kill |
| `PLUGIN_HOT_UPDATE_SOURCE` | `{ pluginId, source }` | hotUpdate() |
| `PLUGIN_RESTART` | `{ pluginId }` | kill + fork 重启 |

### PluginLoader 发送（到 Main Thread）

| type | payload | 触发时机 |
|------|---------|---------|
| `PLUGIN_LOADED` | `PluginInfo` | init 完成，状态进入 running |
| `PLUGIN_STATUS` | `PluginInfo` | 任何状态变更 |
| `PLUGIN_HOT_UPDATED` | `{ pluginId, version }` | 热更新成功 |
| `PLUGIN_CRASHED` | `{ pluginId, exitCode, signal }` | Child Process 意外退出 |
| `LOG_ENTRY` | `{ level, msg, pluginId }` | 插件日志透传 |

---

## 8. FFI 插件的 Child Process 分组

```
PluginManifest(ffiConfig.dlls[].stability)
        │
        ├─ ALL "stable"  ──► 多个 stable 插件可共享同一 Child Process（按 stability group 分组，且 manifest.isolation !== false 方可合并）
        │
        └─ ANY "unstable" ──► 该插件独占一个 Child Process（isolation=true 强制触发）
```

> ℹ️ `isolation` 默认为 `true`。若插件 manifest 明确设置 `isolation: false`，则允许合并到 stable-group。FFI `unstable` DLL 始终强制独占。

---

## 9. 错误码全集 — PLUGIN_*

| 错误码 | 触发场景 | HTTP 状态码 |
|--------|---------|-----------|
| `PLUGIN_NOT_FOUND` | pluginId 未注册 | 404 |
| `PLUGIN_LOAD_FAILED` | esbuild 编译错误或 manifest 校验失败 | 400 |
| `PLUGIN_INIT_FAILED` | plugin.init() 抛错 | 500 |
| `PLUGIN_FORBIDDEN_MODULE` | sandboxPlugin 拦截禁用模块 | 400 |
| `PLUGIN_EXAMPLE_FAILED` | hotUpdate 往返测试不通过 | 422 |
| `PLUGIN_CRASH` | Child Process 意外退出（exit code != 0）| 500 |
| `PLUGIN_RESTART_EXHAUSTED` | 超过 maxRestarts（默认 3）| 500 |
| `PLUGIN_HOT_UPDATE_TIMEOUT` | Child Process 未在 10s 内确认热更新 | 504 |

---

## 10. 测试要点

- **sandboxPlugin 阻断**：插件源码中 `require('child_process')`，断言 esbuild 输出的代码运行时抛 `Plugin is not allowed to use 'child_process'`
- **运行时要求拦截**：插件通过动态 `eval('require')("child_process")` 尝试绕过，断言 `sandboxRequire` 抛错
- **vm 超时防护**：插件源码包含死循环 `while(true){}`，断言 `validatePluginExports` 在 3000ms 内抛 `Script execution timed out`
- **PluginMatcher 评分**：3 个 manifest，分别命中 transport+VID、transport+VID+PID、只 transport，断言返回最高分（+310pts）
- **hotUpdate 成功**：注入新 source → 断言 Child Process 收到 PLUGIN_HOT_UPDATE IPC → 返回 PLUGIN_HOT_UPDATED → info.status = 'running'
- **hotUpdate 回滚**：新 source 缺少 default export, 断言 info.status = 'error', 旧插件仍在运行
- **crash 重启**：模拟 Child Process exit(1)，断言触发重启，restartCount++，超过 maxRestarts 后 status = 'error'
- **graceful stop**：调用 PLUGIN_UNLOAD，断言先发 PLUGIN_STOP IPC，等待 PLUGIN_STOPPED 后才 kill PID
