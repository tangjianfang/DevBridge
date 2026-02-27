# 冷启动流程（Cold Start Sequence）

> 从 PM2/Windows Service 启动到服务就绪、前端首次连接的完整时序。  
> **SLA 目标：< 3s**

```mermaid
sequenceDiagram
    participant PM2 as PM2 / Windows Service
    participant Main as 主进程 Main Thread
    participant WD as Watchdog
    participant GW as GatewayService
    participant OB as ObservabilityService
    participant DE as DiagnosticEngine
    participant PE as ProtocolEngine
    participant PL as PluginLoader
    participant DM as DeviceManager
    participant CD as CommandDispatcher
    participant FE as Frontend Browser

    PM2->>Main: 启动进程
    Main->>OB: new Worker(observability) — 最优先启动
    OB-->>Main: ready
    Main->>PE: new Worker(protocol-engine)
    PE->>PE: 扫描 protocols/ 目录，加载所有 Schema
    PE-->>Main: ready
    Main->>PL: new Worker(plugin-loader)
    PL->>PL: 扫描 plugins/ 目录，加载 manifest
    PL-->>Main: ready
    Main->>DE: new Worker(diagnostic-engine)
    DE->>DE: 并发执行 12 项环境检查（5s timeout/项）
    DE-->>Main: diagnosticReport
    Main->>DM: new Worker(device-manager)
    DM->>DM: 全量扫描 5 种 Transport，枚举设备
    DM->>PL: matchPlugin(deviceInfo) × N
    PL-->>DM: matchedPlugin × N
    DM->>DM: 创建 DeviceChannel × N，建立连接
    DM-->>Main: ready (devicesCount: N)
    Main->>CD: new Worker(command-dispatcher)
    CD-->>Main: ready
    Main->>GW: Fastify.listen(:3000) — 主线程启动
    GW-->>Main: listening
    Main->>WD: 启动 Watchdog，开始 1s 轮询
    Note over Main: 冷启动完成 < 3s
    FE->>GW: WebSocket connect
    GW-->>FE: Text Frame {type: device:status, payload: deviceList}
    DE->>GW: 诊断有 warn/fail 项 → NotificationManager
    GW-->>FE: Text Frame {type: notification, level: warning}
```

## Worker 启动顺序（拓扑依赖顺序）

| 顺序 | Service | 原因 |
|------|---------|------|
| 1 | ObservabilityService | 所有其他 Service 的日志依赖它，最先启动 |
| 2 | ProtocolEngine | PluginLoader 和 DeviceManager 都需要它加载完成 |
| 3 | PluginLoader | DeviceManager 需要匹配插件 |
| 4 | DiagnosticEngine | 独立运行，不阻塞后续，但结果影响 Transport 启动 |
| 5 | DeviceManager | 核心，最耗时（全量设备扫描） |
| 6 | CommandDispatcher | 依赖 DeviceManager 已有设备列表 |
| 7 | GatewayService | 最后启动，所有后端就绪后才开放外部连接 |
| 8 | Watchdog | 所有 Service 就绪后开始监控 |

## 关闭顺序（逆序）

`GatewayService → CommandDispatcher → DeviceManager → PluginLoader → ProtocolEngine → ObservabilityService`
