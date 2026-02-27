# 配置导入导出流程

> 支持将所有设备配置、插件配置、Protocol Schema 打包导出为 zip，并可在另一台机器上导入还原。

```mermaid
flowchart TD
    A([用户触发\n导出配置]) --> B[ConfigManager\n收集所有配置源]
    B --> C1[devices.json\n设备绑定关系]
    B --> C2[plugins/ 各 manifest.json\n插件配置]
    B --> C3[protocol/*.yaml\nProtocol DSL Schema]
    B --> C4[app-settings.json\n全局应用设置]
    C1 --> D[archiver 打包\nomni-config-{timestamp}.zip]
    C2 --> D
    C3 --> D
    C4 --> D
    D --> E[添加 checksum.json\n每个文件的 SHA256]
    E --> F[写入临时文件\n提供下载流]
    F --> G[前端下载对话框\n保存到本地磁盘]

    H([用户触发\n导入配置]) --> I[前端文件选择对话框\n拖拽 or 文件浏览器]
    I --> J[上传 zip 文件\nREST POST /api/config/import]
    J --> K[解压到临时目录\n/tmp/import_{uuid}/]
    K --> L[校验 checksum.json\n所有文件 SHA256 对比]
    L --> M{全部校验通过?}
    M -- 否 --> N[Fail: 文件损坏或篡改\n中止导入]
    M -- 是 --> O[版本兼容性检查\n当前版本能否读取该格式]
    O --> P{兼容?}
    P -- 否 --> Q[Fail: 版本不兼容\n提示需降级]
    P -- 是 --> R[前端展示 diff 预览\n新旧配置差异对比]
    R --> S{用户确认\n应用差异?}
    S -- 取消 --> T[清理临时目录\n不修改任何现有配置]
    S -- 确认 --> U[备份当前配置\nconfig.backup.{timestamp}/]
    U --> V[原子替换配置文件\n逐文件 rename]
    V --> W[重载受影响的服务\nProtocolEngine.reload\nPluginLoader.reload]
    W --> X[NotificationManager\nsuccess: 配置已导入并生效]

    style G fill:#2196F3,color:#fff
    style N fill:#f44336,color:#fff
    style Q fill:#f44336,color:#fff
    style T fill:#9E9E9E,color:#fff
    style X fill:#4CAF50,color:#fff
```

## 导出包结构

```
omni-config-2025-01-01T120000.zip
├── checksum.json              # 所有文件的 SHA256
├── meta.json                  # DevBridge 版本、导出时间、platform
├── devices.json               # 设备绑定关系
├── app-settings.json          # 全局配置
├── plugins/
│   ├── my-plugin/manifest.json
│   └── ...
└── protocol/
    ├── device-a.yaml
    └── ...
```

## 原子替换策略

```
配置文件替换不使用 fs.writeFile 直接覆盖，改用：
  1. 写临时文件 config.json.tmp
  2. fs.rename(tmp → config.json)  ←  原子操作，不会出现半写状态
```
