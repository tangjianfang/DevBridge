# DevBridge 流程图文档索引

> 本目录收录 DevBridge 项目所有架构实现流程图与业务流程图，供项目评审使用。  
> 文档版本：v1.1.0 | 最后更新：2025

---

## 架构总览

| 序号 | 文件 | 图表类型 | 描述 | SLA 目标 |
|------|------|---------|------|---------|
| 01 | [01-architecture-overview.md](./01-architecture-overview.md) | 分层架构图 | 系统整体分层架构、Monorepo 结构与进程模型 | — |

---

## 系统启动与生命周期

| 序号 | 文件 | 图表类型 | 描述 | SLA 目标 |
|------|------|---------|------|---------|
| 02 | [02-cold-start.md](./02-cold-start.md) | 时序图 | 冷启动完整序列：主进程 → Worker Thread 启动顺序 | 首屏 WebSocket 就绪 < 2s |
| 14 | [14-shutdown-state-machine.md](./14-shutdown-state-machine.md) | 流程图 + 状态机 | 优雅关闭（5s 内完成）+ 设备状态机七状态全貌 | SIGKILL 前 5s 完成 |

---

## 通信通道

| 序号 | 文件 | 图表类型 | 描述 | SLA 目标 |
|------|------|---------|------|---------|
| 03 | [03-command-channel.md](./03-command-channel.md) | 时序图 | 命令通道（Request-Response）：前端→设备全链路 | 单命令往返 < 100ms |
| 04 | [04-event-channel.md](./04-event-channel.md) | 时序图 | 事件通道（被动推送）：PacketTap 订阅 + Binary Frame 16ms 批量 | rawBuffer 推送 < 16ms |
| 07 | [07-broadcast.md](./07-broadcast.md) | 流程图 | 命令广播：Promise.allSettled 并行多设备，独立降级 | ≤10 台设备 ≤ 5ms |

---

## 设备管理

| 序号 | 文件 | 图表类型 | 描述 | SLA 目标 |
|------|------|---------|------|---------|
| 05 | [05-device-attach.md](./05-device-attach.md) | 流程图 | 设备发现与连接（热插拔 Attach）：从物理插入到前端显示 | USB 检测 < 100ms |
| 06 | [06-device-reconnect.md](./06-device-reconnect.md) | 流程图 | 设备断开与自动重连：指数退避策略（1s→2s→4s→…→30s） | — |

---

## 协议与插件

| 序号 | 文件 | 图表类型 | 描述 | SLA 目标 |
|------|------|---------|------|---------|
| 08 | [08-protocol-hot-reload.md](./08-protocol-hot-reload.md) | 流程图 | Protocol DSL 热重载：三道校验关卡 + 原子替换，零丢包 | 文件变更到生效 < 200ms |

---

## 运维与系统功能

| 序号 | 文件 | 图表类型 | 描述 | SLA 目标 |
|------|------|---------|------|---------|
| 09 | [09-watchdog.md](./09-watchdog.md) | 流程图 | Watchdog 守护：1s 心跳 + 指数退避重启 + permanently_failed | 进程崩溃检测 < 3s |
| 10 | [10-notification.md](./10-notification.md) | 流程图 | 异常通知分发：4 级别 + 30s 去重 + 多渠道路由 | — |
| 11 | [11-auto-update.md](./11-auto-update.md) | 流程图 | 自动更新三层策略：主程序（需重启）/ 插件（零停机）/ 前端（刷新）| — |
| 12 | [12-config-import-export.md](./12-config-import-export.md) | 流程图 | 配置导入导出：SHA256 校验 + diff 预览 + 原子替换 | — |
| 13 | [13-diagnostics.md](./13-diagnostics.md) | 流程图 | 环境诊断：12 项并发检查，5s/项超时，阻断/降级策略 | 诊断完成 < 5s |

---

## 评审关注点

### 架构稳定性
- [ ] 线程隔离模型是否合理（Worker Thread vs Child Process）
- [ ] 热插拔检测延迟是否满足用户体验要求
- [ ] 指数退避上限（30s）是否合适

### 性能目标
- [ ] 命令往返 < 100ms：依赖 Transport 类型，USB HID 通常 < 5ms
- [ ] rawBuffer 推送 < 16ms：需 WebSocket 网络延迟 < 10ms
- [ ] 广播 ≤5ms（≤10 台）：Promise.allSettled 并行，需设备响应速度支持

### 容错与恢复
- [ ] 设备状态机覆盖所有异常路径（7 个状态）
- [ ] Plugin 更新的零停机切换
- [ ] 配置导入的原子替换防止中间态损坏

### 安全
- [ ] Plugin handler.ts 强制 Child Process 隔离（沙箱）
- [ ] 配置导入文件的 SHA256 完整性校验
- [ ] 自动更新包的 SHA256 验证 + 版本回滚

---

*文档通过 GitHub Copilot 生成，基于 `docs/prompt-requirements.md` v1.1.0 架构设计*
