# Skill: FFI Transport — DLL/共享库接入层

## Preconditions

当以下情况发生时激活本 skill：
- 用户接入仅提供 Windows DLL / Linux .so（C 接口）的设备 SDK
- 涉及 `node-ffi-napi`、`ref-napi`、`ref-array-di` 的使用
- 用户讨论 FFI Child Process 隔离策略（单进程多 DLL vs 独占隔离）
- Plugin Manifest 中出现 `"transport": "ffi"` 或 `ffiConfig` 字段
- 用户讨论 DLL 回调函数、设备心跳轮询、崩溃恢复机制

---

## Instructions

### 强制约束：DLL 只能在 Child Process 运行

`node-ffi-napi` 调用原生 DLL 时，若 DLL 崩溃或内存越界，**会直接终止整个 Node.js 进程**。  
因此 FFI Transport 有且仅有一种合法运行方式：

```
PluginLoader（Worker Thread）
  └─ child_process.fork('ffi-driver-worker.js')
       └─ require('node-ffi-napi')   ← 唯一合法加载位置
            └─ DLL / .so 原生代码
```

**禁止在主进程或 Worker Thread 中 `require('node-ffi-napi')`。**  
Plugin Manifest 必须声明 `"isolation": "child-process"`。

---

### IFFITransport 接口

```typescript
// server/src/transport/ffi/ffi-transport.ts（运行在 Child Process 内）

export interface FFIFunctionDef {
  name: string;
  returnType: string;          // 'int' | 'void' | 'pointer' | 'string' | ...
  argTypes: string[];
}

export interface FFIDllConfig {
  id: string;                  // 本地标识（manifest 内唯一）
  path: string;                // DLL 绝对路径
  stability: 'stable' | 'unstable';  // 影响隔离分组策略
}

export interface FFIConfig {
  dlls: FFIDllConfig[];
  functions: FFIFunctionDef[];
  callbacks?: FFIFunctionDef[];
}

class FFITransport implements ITransport {
  readonly transportType = 'ffi';

  private libs = new Map<string, unknown>();   // dllId → FFI library
  private pollTimer?: ReturnType<typeof setInterval>;

  async connect(config: TransportConfig & { ffiConfig: FFIConfig }): Promise<void> {
    const ffi  = require('node-ffi-napi');
    const ref  = require('ref-napi');

    for (const dll of config.ffiConfig.dlls) {
      const funcDefs: Record<string, [string, string[]]> = {};
      for (const fn of config.ffiConfig.functions) {
        funcDefs[fn.name] = [fn.returnType, fn.argTypes];
      }
      const lib = ffi.Library(dll.path, funcDefs);
      this.libs.set(dll.id, lib);
    }

    // 执行 SDK 初始化
    await this.callInit();

    // 注册 DLL 原生回调（若 SDK 支持）
    this.registerCallbacks(config.ffiConfig.callbacks ?? []);

    // 启动心跳轮询（SDK 无事件接口时）
    this.startPoll();

    this.emit('open');
  }

  async disconnect(): Promise<void> {
    this.stopPoll();
    await this.callDisconnect();
    this.libs.clear();
    this.emit('close');
  }

  async send(buffer: Buffer): Promise<void> {
    // 调用 SDK 发送函数
    const lib = this.libs.get('core')!;
    const fn = (lib as Record<string, (...args: unknown[]) => number>)['SDK_SendCommand'];
    const result = fn(this.handle, buffer, buffer.length);
    if (result !== 0) throw new Error(`FFI_SEND_FAILED: code=${result}`);
  }

  // ── 私有方法 ─────────────────────────────────────────────

  private startPoll(intervalMs = 2000): void {
    this.pollTimer = setInterval(() => this.checkConnection(), intervalMs);
  }

  private stopPoll(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  private checkConnection(): void {
    try {
      const result = this.callIsConnected();
      if (!result) this.emit('close', 'FFI_POLL_DISCONNECTED');
    } catch {
      this.emit('close', 'FFI_POLL_ERROR');
    }
  }
}
```

---

### DLL 隔离分组策略

根据 `ffiConfig.dlls[].stability` 字段，PluginLoader 决定 Child Process 分组：

```
stability: "stable"（默认）
  → 同一 Child Process 可加载多个 stable DLL（共享进程，节省资源）
  → 单 DLL 崩溃会影响同组其他 DLL（可接受的权衡）

stability: "unstable"
  → 每个 unstable DLL 独占一个 Child Process
  → DLL 崩溃只终止该进程，PluginLoader Watchdog 自动重启
```

**PluginLoader 分组逻辑：**

```typescript
// server/src/plugins/plugin-loader.ts

private groupFFIPlugins(plugins: PluginManifest[]): Map<string, PluginManifest[]> {
  const groups = new Map<string, PluginManifest[]>();

  for (const plugin of plugins) {
    if (plugin.transport !== 'ffi') continue;

    const hasUnstable = plugin.ffiConfig?.dlls.some(d => d.stability === 'unstable');

    if (hasUnstable) {
      // 独占：每个插件单独一组
      groups.set(`exclusive-${plugin.name}`, [plugin]);
    } else {
      // 共享：所有 stable 插件合并到 shared 组
      const shared = groups.get('shared-ffi') ?? [];
      shared.push(plugin);
      groups.set('shared-ffi', shared);
    }
  }

  return groups;
}
```

---

### FFI Callback 注册（原生事件推送）

部分 SDK 支持注册 C 回调函数，实现真正的事件驱动（优于轮询）：

```typescript
import ffi  from 'node-ffi-napi';
import ref  from 'ref-napi';

// 定义回调类型
const OnDeviceEventCallback = ffi.Callback(
  'void',
  ['int', 'pointer', 'int'],
  (eventType: number, dataPtr: Buffer, dataLen: number) => {
    const data = dataPtr.slice(0, dataLen);
    transport.emit('event', data, 'ffi-callback');
  }
);

// 防止 GC 回收回调（必须保持引用）
transport._callbackRef = OnDeviceEventCallback;

// 注册到 SDK
lib.SDK_RegisterCallback(OnDeviceEventCallback);
```

> **⚠️ 重要**：FFI Callback 对象必须保存在长期变量中，防止被 GC 回收导致崩溃。

---

### Plugin Manifest 完整 FFI 示例

```json
{
  "name": "acme-payment-terminal",
  "version": "2.1.0",
  "description": "ACME 支付终端（仅 DLL 接入）",
  "transport": "ffi",
  "isolation": "child-process",

  "ffiConfig": {
    "dlls": [
      { "id": "core",   "path": "C:/ACME/AcmeSDK.dll",    "stability": "stable"   },
      { "id": "crypto", "path": "C:/ACME/AcmeCrypto.dll", "stability": "stable"   }
    ],
    "functions": [
      { "name": "SDK_Init",        "returnType": "int",  "argTypes": []                          },
      { "name": "SDK_Connect",     "returnType": "int",  "argTypes": ["int"]                     },
      { "name": "SDK_SendCommand", "returnType": "int",  "argTypes": ["int", "pointer", "int"]   },
      { "name": "SDK_IsConnected", "returnType": "int",  "argTypes": ["int"]                     },
      { "name": "SDK_Disconnect",  "returnType": "void", "argTypes": ["int"]                     }
    ],
    "callbacks": [
      { "name": "OnDeviceEvent", "returnType": "void", "argTypes": ["int", "pointer", "int"] }
    ]
  },

  "reconnect": {
    "maxRetries": 3,
    "retryInterval": 2000,
    "backoffMultiplier": 2,
    "maxRetryInterval": 30000
  }
}
```

---

### DiagnosticEngine 检查项

```typescript
// FFI 环境诊断（DiagnosticEngine 注册）
{
  id: 'ffi-napi-available',
  name: 'node-ffi-napi 可用性',
  check: async () => {
    try {
      // 仅在 Child Process 中测试 require
      require('node-ffi-napi');
      return { status: 'ok' };
    } catch (e) {
      return {
        status: 'error',
        message: 'node-ffi-napi 未安装或 ABI 不兼容',
        fix: 'pnpm add node-ffi-napi ref-napi ref-array-di'
      };
    }
  }
},
{
  id: 'ffi-dll-exists',
  name: 'DLL 文件存在性',
  check: async (config: FFIConfig) => {
    const missing = config.dlls.filter(d => !fs.existsSync(d.path));
    if (missing.length > 0) {
      return { status: 'error', message: `DLL 不存在: ${missing.map(d => d.path).join(', ')}` };
    }
    return { status: 'ok' };
  }
}
```

---

## Constraints

- **禁止** 在主进程或 Worker Thread 中 `require('node-ffi-napi')` — 必须在 Child Process
- **禁止** Plugin Manifest 中声明 `"transport": "ffi"` 但 `"isolation"` 不为 `"child-process"`
- **禁止** FFI Callback 对象被 GC 回收（必须用变量持有引用，如 `transport._callbackRef`）
- **必须** 在 Child Process 退出前调用 SDK 的断连 / 反初始化函数，防止 DLL 资源泄漏
- **必须** 为所有 FFI Transport 插件注册 DiagnosticEngine 检查（DLL 路径 + napi 可用性）
- `unstable` DLL 必须独占 Child Process，不得与其他插件共享进程
- FFI Transport 无法使用 Protocol DSL（DLL 内部已处理协议），Plugin 必须实现完整 `IDevicePlugin` 接口

## Examples

### 调用 DLL 函数发送命令

```typescript
// handler.ts（运行在 Child Process 内）
import { createPluginContext } from '@devbridge/plugin-sdk';

const ctx = createPluginContext(process.env.PLUGIN_ID!);

// 通过 SDK 接口发送命令（由 FFITransport.send() 封装底层 DLL 调用）
const result = await ctx.sendCommand('setLED', { color: 0x01 });
```

### 崩溃自动恢复

```
Child Process 中 DLL 崩溃
  → process 退出（exit code 非零）
  → PluginLoader.onProcessExit() 检测到
  → Watchdog 重启策略：退避重试（最多 5 次）
  → 通知前端：plugin:status = 'crashed' → 'restarting' → 'running'
```
