# 协议热重载流程

> 运行时动态更新 Protocol DSL Schema，无需重启服务，不中断已连接设备通信。  
> **SLA 目标：文件变更到生效 < 200ms；切换期间丢包 = 0**

```mermaid
flowchart TD
    A([Protocol YAML 文件变更\n或前端手动上传]) --> B[chokidar FileWatcher\n检测到 change 事件]
    B --> C[读取新 Schema 文件\nfs.readFile Buffer]
    C --> D[Zod Schema 合法性校验\n结构 / 类型 / 约束检查]
    D --> E{合法?}
    E -- 否 --> F[触发 onError 回调\n保留旧 Schema 继续运行]
    F --> G[NotificationManager\nerror: Schema 语法错误\n含行号]
    E -- 是 --> H[examples 自检\n用 Schema 编解码 example packets]
    H --> I{全部通过?}
    I -- 否 --> J[触发 onValidationFail\n保留旧 Schema 继续运行]
    J --> K[NotificationManager\nerror: examples 验证失败]
    I -- 是 --> L[暂停新消息路由\nDeviceChannel 命令队列 freeze]
    L --> M[原子替换 Schema 引用\nprotocolEngine.schema = newSchema]
    M --> N[恢复命令队列\n继续处理冻结期间排队的消息]
    N --> O[广播 protocol:reloaded 事件\n到所有前端 WebSocket]
    O --> P[前端刷新协议视图\n不刷新页面]
    P --> Q[NotificationManager\nsuccess: 协议已热重载]

    style A fill:#9C27B0,color:#fff
    style F fill:#f44336,color:#fff
    style J fill:#f44336,color:#fff
    style Q fill:#4CAF50,color:#fff
```

## 热重载安全保障

```
1. 校验 → examples 自检 → 原子替换  （三道关卡，任一失败回滚）
2. Schema 替换期间冻结命令队列（< 1ms），解冻后队列自动回放
3. 新旧 Schema 引用切换为原子操作（单赋值，无中间态）
4. 异常路径：保留旧 Schema，不影响正在运行的设备通信
```

## 支持的热重载触发方式

| 触发方式 | 场景 |
|---------|-----|
| chokidar 文件监听 | 开发时本地编辑 YAML 立即生效 |
| 前端上传新 Schema | 生产环境远程升级 |
| REST `POST /api/protocol/reload` | CI/CD 自动化触发 |

## Protocol DSL Schema 简例

```yaml
protocol: MyDevice v1.0
commands:
  - id: 0x01
    name: setLed
    fields:
      - name: color
        type: uint8
        range: [0, 7]
  - id: 0x02
    name: getStatus
    response: DeviceStatus
```
