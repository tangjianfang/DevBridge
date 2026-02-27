# DevBridge 系统整体架构图

> 展示三层架构、线程模型（主线程 / Worker Thread / Child Process）、Transport 层与物理设备的连接关系。

```mermaid
graph TB
    subgraph PL["Presentation Layer — 浏览器"]
        subgraph MW["MW 中间层（业务逻辑）"]
            MW_WS["WsClient\n连接管理 + 消息路由"]
            MW_ST["Zustand Stores\n设备状态 + 命令 + 通知"]
            MW_CMD["CommandService\n命令构建 + 发送"]
            MW_PT["PacketTap\nBinary Frame 解析"]
        end
        subgraph UI["UI 层（纯渲染）"]
            UI_DEV["DeviceList\n设备列表"]
            UI_CTRL["ControlPanel\n控制面板"]
            UI_LOG["LogViewer\n日志查看"]
            UI_MET["Metrics\n性能指标"]
            UI_DT["DevTools\n调试工具"]
        end
    end

    subgraph WS_CHANNEL["WebSocket 双通道"]
        TF["Text Frame\nJSON 控制消息"]
        BF["Binary Frame\nArrayBuffer rawBuffer"]
    end

    subgraph AL["Application Layer — Node.js 主进程 Main Thread"]
        GW["GatewayService\nFastify + ws\n🔒 独占主线程"]
        WD["Watchdog\n进程守护\n🔒 独占主线程"]
    end

    subgraph WT["Worker Thread Pool"]
        DM["DeviceManager\n设备生命周期\n拥有所有 DeviceChannel"]
        CD["CommandDispatcher\n命令路由广播"]
        PE["ProtocolEngine\nDSL 运行时"]
        PL2["PluginLoader\n插件动态加载"]
        OB["ObservabilityService\npino + Sentry + Metrics"]
        NM["NotificationManager\n通知分发"]
        DE["DiagnosticEngine\n环境诊断"]
        PC["PacketCapture\nDevTools 抓包"]
        UM["UpdateManager\n自动更新"]
    end

    subgraph CP["Child Process Pool"]
        DW1["DriverWorker-1\nUSB HID"]
        DW2["DriverWorker-2\nSerial"]
        DW3["DriverWorker-N\nBLE / libusb"]
        PH["PluginHandler\nhandler.ts\n强制 fork 隔离"]
    end

    subgraph TL["Transport Layer"]
        T1["UsbHidTransport\nnode-hid + hid-parser"]
        T2["SerialTransport\nserialport"]
        T3["BleTransport\n@abandonware/noble"]
        T4["NetworkTransport\nnet / dgram"]
        T5["UsbNativeTransport\nusb libusb"]
    end

    subgraph DEVICES["物理外设"]
        D1["扫码枪 USB HID"]
        D2["称重仪 RS-485"]
        D3["传感器 BLE"]
        D4["POS终端 TCP"]
        D5["复杂USB设备"]
    end

    UI_DEV & UI_CTRL & UI_LOG & UI_MET & UI_DT <-->|读状态 / 调 action| MW_ST
    MW_ST <--> MW_WS
    MW_ST <--> MW_CMD
    MW_PT --> MW_ST
    MW_WS <-->|WebSocket + REST| WS_CHANNEL
    WS_CHANNEL <--> GW
    GW <-->|MessagePort IPC| DM
    GW <-->|MessagePort IPC| CD
    CD <-->|COMMAND_SEND IPC| DM
    DM <-->|MessagePort IPC| PE
    DM <-->|MessagePort IPC| PL2
    WD -->|health ping IPC| DM
    WD -->|health ping IPC| CD
    WD -->|health ping IPC| PE
    DM <-->|IPC Channel| DW1
    DM <-->|IPC Channel| DW2
    DM <-->|IPC Channel| DW3
    PL2 <-->|IPC Channel| PH
    DW1 --- T1
    DW2 --- T2
    DW3 --- T3
    DM --- T4
    DW3 --- T5
    T1 <--> D1
    T2 <--> D2
    T3 <--> D3
    T4 <--> D4
    T5 <--> D5
    DM -->|单向上报| OB
    CD -->|单向上报| OB
    PE -->|单向上报| OB
    DM -->|单向通知| NM
    GW -->|Binary Frame| BF
```

## 关键设计决策

| 决策 | 说明 |
|------|------|
| GatewayService 独占主线程 | 保证 HTTP/WS I/O 响应不被设备扫描等耗时操作阻塞 |
| 浏览器端 UI / MW 双层分离 | UI 层只读 Zustand Store + 调 action；MW 层持有 WsClient、业务逻辑、Binary Frame 解析，无 JSX 依赖 |
| DeviceChannel 所有权归 DeviceManager | CommandDispatcher 通过 IPC 委托，消除跨 Worker 循环依赖 |
| handler.ts 强制 Child Process | 插件业务代码完全隔离，崩溃不影响主进程 |
| rawBuffer 走 Binary Frame | 零编码开销，前端 DevTools 直接操作 ArrayBuffer |
