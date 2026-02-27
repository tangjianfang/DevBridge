# Skill: Diagnostics & Notification — 环境诊断与异常通知

## Preconditions

当以下情况发生时激活本 skill：
- 用户需要检查运行环境是否支持特定 Transport（USB、BLE、串口、网络）
- 涉及 `DiagnosticEngine` 和 `IDiagnosticCheck` 接口
- 用户讨论异常状态通知（Toast、系统通知、WebSocket 推送）
- 涉及 native module 编译状态检查（node-hid / serialport / noble）
- 用户需要在前端展示诊断报告或引导用户解决依赖缺失

---

## Instructions

### IDiagnosticCheck — 诊断检查接口

```typescript
type CheckSeverity = 'info' | 'warning' | 'error' | 'critical';
type CheckStatus   = 'pass' | 'fail' | 'warn' | 'skip';

interface IDiagnosticCheck {
  readonly id: string;                  // 唯一 ID，如 'usb-driver-present'
  readonly name: string;                // 人类可读名称（支持 i18n key）
  readonly transport?: TransportType;   // 关联的 Transport 类型（可选）
  readonly severity: CheckSeverity;     // 失败时的严重程度

  /** 执行检查，返回结果。实现内部不得抛出异常（catch 内部错误） */
  run(): Promise<DiagnosticResult>;
}

interface DiagnosticResult {
  checkId: string;
  status: CheckStatus;
  message: string;          // 简短描述（中英文，取决于当前语言设置）
  detail?: string;          // 详细技术信息（可选）
  fixSuggestion?: string;   // 修复建议
  durationMs: number;
}
```

### DiagnosticEngine — 并发执行 + 超时隔离

```typescript
class DiagnosticEngine {
  private checks = new Map<string, IDiagnosticCheck>();

  register(check: IDiagnosticCheck): void {
    this.checks.set(check.id, check);
  }

  /** 运行所有检查（并发 + 5s 超时隔离） */
  async runAll(): Promise<DiagnosticReport> {
    const startTs = Date.now();
    const results = await Promise.all(
      [...this.checks.values()].map(check =>
        Promise.race([
          check.run(),
          sleep(5000).then((): DiagnosticResult => ({
            checkId: check.id,
            status: 'fail',
            message: `检查超时（> 5s）`,
            durationMs: 5000,
          }))
        ]).catch((err): DiagnosticResult => ({
          checkId: check.id,
          status: 'fail',
          message: `检查异常: ${(err as Error).message}`,
          durationMs: Date.now() - startTs,
        }))
      )
    );

    const report: DiagnosticReport = {
      ts: startTs,
      durationMs: Date.now() - startTs,
      results,
      summary: {
        total: results.length,
        passed: results.filter(r => r.status === 'pass').length,
        failed: results.filter(r => r.status === 'fail').length,
        warned: results.filter(r => r.status === 'warn').length,
      }
    };

    // 推送到前端
    wsServer.broadcast({ type: 'diagnostics:report', payload: report });
    return report;
  }

  /** 按 Transport 类型运行子集检查 */
  async runForTransport(transport: TransportType): Promise<DiagnosticResult[]> {
    const subset = [...this.checks.values()]
      .filter(c => !c.transport || c.transport === transport);
    return Promise.all(subset.map(c => c.run()));
  }
}
export const diagnosticEngine = new DiagnosticEngine();
```

### 各 Transport 内置检查项

```typescript
// USB HID 检查
diagnosticEngine.register({
  id: 'usb-driver-libusb',
  name: 'USB libusb 驱动可用',
  transport: 'usb-hid',
  severity: 'critical',
  async run() {
    try {
      const usb = await import('usb');
      const devices = usb.getDeviceList();
      return { checkId: this.id, status: 'pass',
               message: `libusb 可用，检测到 ${devices.length} 个 USB 设备`,
               durationMs: 0 };
    } catch (err) {
      return { checkId: this.id, status: 'fail',
               message: 'libusb 不可用',
               detail: (err as Error).message,
               fixSuggestion: 'Windows: 请使用 Zadig 安装 WinUSB 驱动；macOS: brew install libusb',
               durationMs: 0 };
    }
  }
});

// BLE 检查
diagnosticEngine.register({
  id: 'ble-adapter-ready',
  name: '蓝牙适配器就绪',
  transport: 'ble',
  severity: 'error',
  async run() {
    return new Promise(resolve => {
      const timeout = setTimeout(() => resolve({
        checkId: this.id, status: 'fail', message: '蓝牙状态查询超时',
        fixSuggestion: '请确认系统蓝牙已开启', durationMs: 3000
      }), 3000);

      noble.once('stateChange', state => {
        clearTimeout(timeout);
        resolve({
          checkId: this.id,
          status: state === 'poweredOn' ? 'pass' : 'fail',
          message: state === 'poweredOn' ? '蓝牙适配器就绪' : `蓝牙状态: ${state}`,
          fixSuggestion: state !== 'poweredOn' ? '请在系统设置中开启蓝牙' : undefined,
          durationMs: 0,
        });
      });
      noble.startScanning([], false); // 触发状态查询
      setTimeout(() => noble.stopScanning(), 100);
    });
  }
});

// Native Module 编译状态
diagnosticEngine.register({
  id: 'native-module-node-hid',
  name: 'node-hid native 模块',
  transport: 'usb-hid',
  severity: 'critical',
  async run() {
    try {
      const { HID } = await import('node-hid');
      HID.devices(); // 实际调用，确认 native 正常
      return { checkId: this.id, status: 'pass', message: 'node-hid 加载正常', durationMs: 0 };
    } catch (err) {
      return { checkId: this.id, status: 'fail',
               message: 'node-hid native 模块加载失败',
               detail: (err as Error).message,
               fixSuggestion: '请运行: pnpm rebuild node-hid',
               durationMs: 0 };
    }
  }
});

// 串口权限检查（Linux）
diagnosticEngine.register({
  id: 'serial-port-permission',
  name: '串口访问权限',
  transport: 'serial',
  severity: 'error',
  async run() {
    if (process.platform !== 'linux') {
      return { checkId: this.id, status: 'skip', message: '非 Linux 系统，跳过', durationMs: 0 };
    }
    try {
      const { SerialPort } = await import('serialport');
      await SerialPort.list();
      return { checkId: this.id, status: 'pass', message: '串口权限正常', durationMs: 0 };
    } catch (err) {
      return { checkId: this.id, status: 'fail',
               message: '串口权限不足',
               fixSuggestion: 'sudo usermod -a -G dialout $USER 后重新登录',
               durationMs: 0 };
    }
  }
});

// 端口占用检查
diagnosticEngine.register({
  id: 'server-port-available',
  name: `HTTP 端口可用 (${config.httpPort})`,
  severity: 'critical',
  async run() {
    const inUse = await isPortInUse(config.httpPort);
    return {
      checkId: this.id,
      status: inUse ? 'fail' : 'pass',
      message: inUse ? `端口 ${config.httpPort} 已被占用` : `端口 ${config.httpPort} 可用`,
      fixSuggestion: inUse ? `请修改配置文件中的 httpPort，或关闭占用进程` : undefined,
      durationMs: 0,
    };
  }
});
```

### NotificationManager — 多通道通知

```typescript
type NotificationChannel = 'websocket' | 'system' | 'both';
type NotificationLevel   = 'info' | 'success' | 'warning' | 'error';

class NotificationManager {
  // 防重：同一 source + message 在 30s 内不重复发送
  private recentMessages = new Map<string, number>();
  private readonly throttleMs = 30_000;

  notify(
    level: NotificationLevel,
    source: string,
    message: string,
    options?: {
      channel?: NotificationChannel;
      detail?: string;
      actions?: Array<{ label: string; action: string }>;
    }
  ): void {
    const key = `${source}:${message}`;
    const lastSent = this.recentMessages.get(key) ?? 0;
    if (Date.now() - lastSent < this.throttleMs && level !== 'error') {
      return; // 节流（error 总是发送）
    }
    this.recentMessages.set(key, Date.now());

    const channel = options?.channel ?? (level === 'error' ? 'both' : 'websocket');

    // 1. WebSocket 推送到前端
    if (channel === 'websocket' || channel === 'both') {
      wsServer.broadcast({
        type: 'notification',
        payload: { level, source, message, detail: options?.detail,
                   actions: options?.actions, ts: Date.now() }
      });
    }

    // 2. 系统原生通知（node-notifier）
    if (channel === 'system' || channel === 'both') {
      notifier.notify({
        title: `DevBridge — ${source}`,
        message,
        icon: level === 'error' ? errorIconPath : infoIconPath,
        sound: level === 'error',
      });
    }
  }
}

export const notificationManager = new NotificationManager();
```

---

## Constraints

- 每个 `IDiagnosticCheck.run()` 内部**必须** try/catch，**禁止**向外抛出异常
- `DiagnosticEngine.runAll()` 为每个检查设置独立 5s 超时，单个检查挂起**不影响**其他检查
- `severity: 'critical'` 的检查失败时，系统**必须**阻止对应 Transport 启动，并通过 `both` 通道通知
- `NotificationManager` 节流逻辑：`error` 级别**不节流**，其余级别同 source+message 组合 30s 内最多发送一次
- 系统通知（node-notifier）**仅**在 `level === 'error'` 或用户显式请求时触发，避免频繁系统弹窗
- 诊断报告中**禁止**包含 raw hex 数据、密码、token 等敏感信息

---

## Examples

### 启动时自动诊断流程

```
1. 服务启动 → diagnosticEngine.runAll() 并发执行所有检查
2. node-hid 检查失败（severity: critical）
   → 阻止 usb-hid Transport 服务启动
   → notificationManager.notify('error', 'diagnostics', 'node-hid 加载失败，请重新编译', { channel: 'both' })
3. BLE 检查 warn（蓝牙关闭）
   → 记录日志，WS 推送 warning，不阻止启动
4. 所有检查完成 → 推送 diagnostics:report 到前端
5. 前端展示诊断面板，高亮失败项 + 修复建议
```

### 前端 WebSocket 消息格式

```json
{
  "type": "notification",
  "payload": {
    "level": "error",
    "source": "diagnostics",
    "message": "node-hid native 模块加载失败",
    "detail": "Error: Cannot find module './build/Release/HID.node'",
    "actions": [
      { "label": "复制修复命令", "action": "copy:pnpm rebuild node-hid" },
      { "label": "查看文档",    "action": "open:https://docs.DevBridge.dev/troubleshoot" }
    ],
    "ts": 1700000000000
  }
}
```
