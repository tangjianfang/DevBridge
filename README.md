# DevBridge

> **Universal Hardware Interface Platform** — 基于 Node.js + React 的通用硬件外设通信平台

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20%20LTS-green)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

---

## 简介

DevBridge 是一套面向 PC 桌面应用场景的 **外设通信中间件平台**。它以 Node.js 作为后台服务，React 运行在浏览器中作为前端控制面板，通过 WebSocket/REST 桥接，实现对多种外设通信方式的统一管理与控制。

### 核心痛点

- 不同厂商的外设通信协议千差万别（USB HID、串口、蓝牙、网络、USB 原生）
- 同一通信方式的外设，应用层协议也可能完全不同（如串口上的 Modbus RTU、私有二进制帧、ASCII 文本）
- 传统桌面应用（如 Electron）将通信逻辑与 UI 深度耦合，复用和维护成本高
- 缺乏统一的设备生命周期管理（热插拔、自动重连、状态监控）

### 核心特色

| 特色 | 描述 |
|------|------|
| 🔌 **六种通信方式** | USB HID、Serial（RS-232/RS-485）、Bluetooth Classic/BLE、TCP/UDP、USB Native、FFI（DLL/共享库）|
| 🧩 **插件化架构** | 每个设备驱动是独立插件，零代码即可接入简单设备 |
| 📋 **声明式协议 DSL** | JSON/YAML 描述协议帧结构，Protocol Runtime Engine 自动生成 encode/decode |
| ⚡ **高性能低延迟** | < 5ms 内并行广播命令到所有外设，SharedArrayBuffer 零拷贝数据传递 |
| 🏗️ **微服务化设计** | 各模块独立进程/线程隔离，一个设备崩溃不影响整体服务 |
| 🔄 **协议热加载** | 运行时新增/修改设备协议 Schema，无需重启服务 |
| 🪝 **Endpoint Hook** | 持续监听 HID IN Report、BLE Notification，被动接收设备主动上报数据 |
| 📡 **双通道数据流** | Command Channel（请求-响应）+ Event Channel（被动监听）并行运作 |
| 🔍 **可观测性** | 结构化日志、Sentry 错误上报、性能 Metrics、通信抓包调试 |
| 🌐 **灵活部署** | 本地模式（localhost）+ 局域网远程控制模式 |

---

## 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                   Browser / React UI                    │
│  设备列表 │ 控制面板 │ 日志查看器 │ DevTools │ Metrics   │
└─────────────────────┬───────────────────────────────────┘
                      │ WebSocket / REST API
┌─────────────────────▼───────────────────────────────────┐
│                  Gateway Service                        │
│              (Fastify + ws, HTTP/WS 网关)                │
└──────┬──────────────┬──────────────┬────────────────────┘
       │              │              │
┌──────▼──────┐ ┌─────▼─────┐ ┌────▼──────────────────┐
│   Device    │ │ Command   │ │    Observability      │
│   Manager   │ │Dispatcher │ │ (Log/Sentry/Metrics)  │
└──────┬──────┘ └─────┬─────┘ └───────────────────────┘
       │              │
┌──────▼──────────────▼──────────────────────────────────┐
│              Plugin System + Protocol Layer             │
│   manifest.json + protocol.schema.json + handler.ts    │
└──────┬────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────┐
│                  Transport Layer                        │
│  UsbHid │ Serial │ BLE │ TCP/UDP │ UsbNative           │
└──────────────────────────────────────────────────────────┘
       │
    物理外设（扫码枪、称重仪、传感器、POS 终端...）
```

---

## 文档索引

| 文档 | 说明 |
|------|------|
| [需求文档](docs/prompt-requirements.md) | 完整需求、架构设计、技术选型、性能指标 |
| [全局开发指令](.ai/instructions.md) | 编码规范、架构约定、禁止事项 |
| [架构总览 Skill](.ai/skills/architecture-overview.md) | 整体三层架构详细设计 |
| [微服务设计 Skill](.ai/skills/microservice-design.md) | 服务拆分、进程隔离、IPC 协议 |
| [高性能低延迟 Skill](.ai/skills/performance-realtime.md) | 命令广播、SharedArrayBuffer、Buffer Pool |
| [设备生命周期 Skill](.ai/skills/device-lifecycle.md) | 枚举、热插拔、状态机、自动重连 |
| [双通道数据流 Skill](.ai/skills/data-flow-model.md) | Command + Event 双通道模型 |
| [Transport 抽象层 Skill](.ai/skills/transport-layer.md) | ITransport 接口、订阅模式 |
| [USB HID Transport Skill](.ai/skills/usb-hid-transport.md) | Endpoint Hook、Report Descriptor 解析 |
| [BLE GATT 订阅 Skill](.ai/skills/ble-gatt-subscription.md) | GATT 服务发现、跨 Service 多特征订阅 |
| [串口通信 Skill](.ai/skills/serial-port.md) | SerialPort、Parser 链、热插拔 |
| [网络设备 Skill](.ai/skills/network-device.md) | TCP/UDP、心跳、mDNS 发现 |
| [USB Native Skill](.ai/skills/usb-native.md) | libusb、Transfer 类型、Interface Claim |
| [FFI Transport Skill](.ai/skills/ffi-transport.md) | node-ffi-napi DLL 接入、进程隔离、Callback 注册 |
| [协议 DSL Skill](.ai/skills/protocol-dsl.md) | Schema 设计、字段类型、校验算法 |
| [协议热加载 Skill](.ai/skills/protocol-hot-reload.md) | chokidar 监听、沙箱验证、无停机更新 |
| [插件系统 Skill](.ai/skills/plugin-system.md) | IDevicePlugin、manifest、零代码接入 |
| [可观测性 Skill](.ai/skills/observability.md) | pino 日志、Sentry、Metrics、通信历史 |
| [诊断与通知 Skill](.ai/skills/diagnostics-notification.md) | 环境诊断、系统通知、异常告警 |
| [开发工具与维护 Skill](.ai/skills/devtools-maintenance.md) | 抓包调试、自动更新、配置导入导出、i18n |
| [前端开发 Skill](.ai/skills/frontend-react.md) | React、WebSocket、Zustand、Shadcn/UI |
| [后端服务 Skill](.ai/skills/backend-nodejs.md) | Fastify、服务编排、API 设计 |

---

## 技术栈

### 后端
- **Runtime**: Node.js ≥ 20 LTS + TypeScript 5.x（严格模式）
- **HTTP/WS**: Fastify + `ws`
- **设备通信**: `node-hid` / `serialport` / `@abandonware/noble` / `usb` / Node.js `net`
- **进程管理**: `worker_threads` + `child_process`
- **日志**: `pino` + `pino-roll`
- **错误监控**: `@sentry/node`

### 前端
- **Framework**: React 18+ + TypeScript
- **状态管理**: Zustand
- **UI 组件**: Shadcn/UI + Tailwind CSS
- **图表**: Recharts
- **国际化**: react-i18next

### 工程化
- **Monorepo**: pnpm workspace
- **构建**: Vite（前端）+ tsc（后端）
- **测试**: Vitest + Playwright
- **进程守护**: PM2 / Windows Service

---

## 目录结构

```
DevBridge/
├── packages/
│   ├── server/           # Node.js 后端服务
│   ├── client/           # React 前端应用
│   ├── shared/           # 共享类型定义、工具函数
│   ├── plugin-sdk/       # 插件开发 SDK（@devbridge/plugin-sdk）
│   └── plugins/          # 内置设备驱动插件
├── protocols/            # 协议 Schema 文件目录（支持热加载）
├── plugins/              # 第三方插件目录（支持热加载）
├── data/                 # 运行时数据（devices.json、配置等）
├── logs/                 # 日志文件目录
├── docs/                 # 需求文档
└── .ai/                  # AI 开发辅助 Skills
    ├── instructions.md
    └── skills/
```

---

## 快速开始

```bash
# 安装依赖
pnpm install

# 开发模式（前后端并行启动）
pnpm dev

# 构建
pnpm build

# 生产模式启动
pnpm start

# 运行测试
pnpm test
```

访问 `http://localhost:3000` 打开控制面板。

---

## 许可证

MIT License — 详见 [LICENSE](LICENSE)
