# 环境诊断流程（12 项并发检查）

> 应用启动时并发执行 12 项环境检查，超时或失败的检查项可视情况阻断 Transport 启动。

```mermaid
flowchart TD
    A([应用启动 / 用户触发诊断]) --> B[DiagnosticsService\n并发启动 12 项检查\nPromise.allSettled]

    B --> C1[01 Node.js 版本\n≥ 20 LTS]
    B --> C2[02 pnpm workspace\n依赖完整性]
    B --> C3[03 USB 驱动\nnode-hid libusb]
    B --> C4[04 串口权限\n/dev/ttyUSB 读写]
    B --> C5[05 BLE 适配器\n蓝牙是否可用]
    B --> C6[06 TCP 端口\n默认端口未占用]
    B --> C7[07 磁盘空间\n剩余 > 100MB]
    B --> C8[08 文件系统\nlogs/ config/ writable]
    B --> C9[09 Plugin 完整性\n所有 manifest.json hash 合法]
    B --> C10[10 Protocol Schema\n所有 YAML 可解析]
    B --> C11[11 WebSocket 握手\n本地自测可连通]
    B --> C12[12 进程权限\n管理员 or udev 规则]

    C1 --> D[每项独立 5s 超时\n超时 = fail]
    C2 --> D
    C3 --> D
    C4 --> D
    C5 --> D
    C6 --> D
    C7 --> D
    C8 --> D
    C9 --> D
    C10 --> D
    C11 --> D
    C12 --> D

    D --> E[汇总 DiagnosticsReport]
    E --> F{全部通过?}
    F -- 是 --> G[正常启动\n所有 Transport 开启]
    F -- 否 --> H{失败项是否为阻断级别?}
    H -- 非阻断\n如 BLE 不可用 --> I[警告提示\n仅禁用对应 Transport\n其余正常工作]
    H -- 阻断\n如磁盘满/无写权限 --> J[ERROR 级别告警\n禁止启动 Transport]
    I --> K[前端诊断面板\n展示 check 列表 + 状态]
    J --> K
    G --> K

    style A fill:#607D8B,color:#fff
    style G fill:#4CAF50,color:#fff
    style I fill:#FF9800,color:#fff
    style J fill:#f44336,color:#fff
```

## 12 项检查详情

| # | 检查项 | 阻断级别 | Transport 影响 |
|---|--------|---------|--------------|
| 01 | Node.js 版本 ≥ 20 | 🔴 阻断所有 | 全部 |
| 02 | pnpm 依赖完整性 | 🔴 阻断所有 | 全部 |
| 03 | USB 驱动 (libusb) | 🟡 仅禁用 USB | USB HID / USB Native |
| 04 | 串口权限 | 🟡 仅禁用串口 | Serial |
| 05 | BLE 适配器 | 🟡 仅禁用 BLE | BLE |
| 06 | TCP 端口可用 | 🟠 禁用 TCP/UDP | TCP / UDP |
| 07 | 磁盘空间 > 100MB | 🔴 阻断所有（无法写日志）| 全部 |
| 08 | 文件系统可写 | 🔴 阻断所有 | 全部 |
| 09 | Plugin 完整性 | 🟡 禁用损坏插件 | 对应设备 |
| 10 | Protocol Schema 可解析 | 🟡 禁用对应设备 | 对应设备 |
| 11 | WebSocket 自测 | 🟠 禁用前端推送 | GatewayService |
| 12 | 进程权限 | 🟡 禁用需权限的 Transport | USB / Serial |

## 诊断结果格式

```typescript
interface DiagnosticsReport {
  timestamp: string;
  elapsedMs: number;
  items: Array<{
    id: string;           // 如 "usb-driver"
    name: string;
    status: 'pass' | 'warn' | 'fail' | 'timeout';
    message?: string;
    blocking: boolean;    // true = 阻断对应 Transport
    affectedTransports: TransportType[];
  }>;
  canStart: boolean;      // true = 无阻断项
}
```
