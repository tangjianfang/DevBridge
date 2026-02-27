# 优雅关闭流程与设备状态机全貌

## 一、优雅关闭流程（Graceful Shutdown）

> 收到 SIGTERM / SIGINT 后，按逆序停止各 Worker Thread，确保所有设备配置已持久化再退出。  
> **SLA 目标：强制 SIGKILL 前等待 5s 完成所有清理**

```mermaid
flowchart TD
    A([接收 SIGTERM 或 SIGINT]) --> B[GatewayService\n停止接受新 WebSocket 连接\n关闭前端 WS]
    B --> C[向所有 Worker Thread\n发送 shutdown IPC 消息\n逆依赖顺序]
    C --> D1[ObservabilityService\nflush 所有 pino 日志\nflush Sentry 队列]
    C --> D2[CommandDispatcher\n等待当前命令队列清空\n< 100ms 超时]
    C --> D3[ProtocolEngine\n保存 Schema 快照]
    D1 --> E[DeviceManager\n逐个 DeviceChannel.close\nTransport.disconnect]
    D2 --> E
    D3 --> E
    E --> F[持久化 devices.json\n保存所有设备状态]
    F --> G[所有 Worker Thread 退出\nworker.terminate]
    G --> H{5s 内完成?}
    H -- 是 --> I[process.exit 0\n正常退出]
    H -- 否 --> J[Watchdog / OS\nSIGKILL 强制终止]
    J --> K[下次启动时\n从 devices.json 恢复]

    style A fill:#607D8B,color:#fff
    style I fill:#4CAF50,color:#fff
    style J fill:#f44336,color:#fff
```

## 二、设备状态机全貌

```mermaid
stateDiagram-v2
    [*] --> unknown : 系统启动/设备被发现

    unknown --> connecting : Transport.connect() 调用

    connecting --> connected : 连接成功
    connecting --> error : 连接失败 (maxRetries=0)
    connecting --> reconnecting : 连接失败 (maxRetries>0)

    connected --> disconnected : 通信超时 / I/O 错误
    connected --> detached : 物理拔出 (USB/Serial)

    disconnected --> reconnecting : ReconnectConfig 允许
    disconnected --> error : maxRetries=0

    reconnecting --> connected : 重连成功
    reconnecting --> error : 重连耗尽 maxRetries

    detached --> [*] : 设备从列表移除

    error --> connecting : 用户手动重试
    error --> [*] : 用户手动删除设备

    connected --> [*] : 优雅关闭 / 用户主动断开
```

## 状态说明

| 状态 | 含义 | UI 展示 |
|------|------|---------|
| `unknown` | 已发现设备，尚未建立连接 | ⚪ 灰色 |
| `connecting` | 正在建立连接 | 🔵 蓝色旋转 |
| `connected` | 通信正常 | 🟢 绿色 |
| `disconnected` | 通信中断，等待重连判断 | 🟡 黄色 |
| `reconnecting` | 指数退避中，主动重连 | 🟠 橙色旋转 |
| `detached` | 物理移除，临时状态 | — |
| `error` | 最终失败，需人工干预 | 🔴 红色 |

## 关闭顺序（逆依赖）

```
1. GatewayService（停止对外服务，最先关闭）
2. ObservabilityService（flush 日志，避免丢失）
3. CommandDispatcher（清空命令队列）
4. ProtocolEngine（保存 Schema 快照）
5. DeviceManager（关闭所有 DeviceChannel 和 Transport，最后关闭）
```
