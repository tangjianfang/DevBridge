# 设备发现与连接流程（热插拔 Attach）

> 从物理设备插入到出现在前端设备列表的完整流程。  
> **SLA 目标：USB 热插拔检测 < 100ms，Serial 轮询 ≤ 1s**

```mermaid
flowchart TD
    A([USB 设备插入]) --> B[usb.on attach 事件触发\n< 100ms]
    B --> C[DeviceManager 收到设备信息\nvendorId / productId / path]
    C --> D{本地已有\n持久化配置?}
    D -- 是 --> E[读取 devices.json 配置]
    D -- 否 --> F[PluginLoader.matchPlugin\n遍历所有 manifest match 规则]
    E --> G[加载对应 Plugin]
    F --> G
    G --> H{Plugin\n有 handler.ts?}
    H -- 否，零代码插件 --> I[Protocol DSL 引擎直接处理\nProtocolEngine.loadSchema]
    H -- 是 --> J[child_process.fork handler.ts\nIPC Channel 建立]
    I --> K[创建 Transport 实例\nUsbHidTransport / SerialTransport / ...]
    J --> K
    K --> L[创建 DeviceChannel\nbind Transport + Protocol]
    L --> M[状态机: unknown → connecting]
    M --> N[Transport.connect]
    N --> O{连接成功?}
    O -- 否 --> P[状态机: → error\nNotificationManager warning]
    O -- 是 --> Q[状态机: → connected]
    Q --> R[Endpoint Hook 开始监听\nIN Report / Notification / 串口读取]
    R --> S[DeviceManager → GatewayService\nIPC DEVICE_STATUS_CHANGED]
    S --> T[GatewayService → Frontend\nText Frame device:status connected]
    T --> U[NotificationManager\ninfo: 设备已连接 Toast 3s]

    style A fill:#4CAF50,color:#fff
    style P fill:#f44336,color:#fff
    style Q fill:#4CAF50,color:#fff
    style U fill:#2196F3,color:#fff
```

## 各 Transport 热插拔检测机制

| Transport | 检测机制 | 延迟 |
|-----------|---------|------|
| USB HID | `usb.on('attach/detach')` 原生事件 | **< 100ms** |
| USB Native | `usb.on('attach/detach')` 原生事件 | **< 100ms** |
| Serial | 轮询 `SerialPort.list()` 差异比对 | **≤ 1s**（轮询间隔可配置）|
| BLE | RSSI 超时 + `noble.on('discover')` 扫描 | **5-10s**（软性检测）|
| TCP/UDP | 心跳超时 + mDNS 消失 + socket `close/error` | **1-30s**（心跳间隔可配置）|

## Plugin 匹配规则（manifest.match 字段）

```jsonc
{
  "match": {
    "pnpId": "USB\\VID_1234&PID_5678",  // USB VID/PID 精确匹配
    "baudRate": 9600,                     // 串口波特率
    "deviceNameFilter": "MySensor"        // BLE 设备名前缀
  }
}
```

未匹配到任何 Plugin 时，设备以"未知设备"状态显示，可手动在前端绑定插件。
