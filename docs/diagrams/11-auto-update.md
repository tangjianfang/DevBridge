# 自动更新流程（三层更新策略）

> 应用程序、插件、前端资源三条独立更新路径，各自具备回滚能力。

```mermaid
flowchart TD
    A([定时触发\n或用户手动检查更新]) --> B[UpdateManager\nPOST /api/update/check]
    B --> C[拉取 update-manifest.json\n含版本号 + SHA256 + URL]
    C --> D{当前版本 < 最新版本?}
    D -- 否 --> E[已是最新，无需更新]
    D -- 是 --> F{更新层级?}

    F -- 应用主程序 --> G[下载新安装包\n流式写入临时目录]
    G --> H[SHA256 完整性校验]
    H --> I{校验通过?}
    I -- 否 --> J[删除临时文件\nerror: 下载损坏]
    I -- 是 --> K[备份当前版本\nbackup/ 目录保留 2 个版本]
    K --> L[前端弹出确认对话框\n"检测到新版本，是否立即更新？"]
    L --> M{用户确认?}
    M -- 取消 --> N[延迟提醒\n下次启动再问]
    M -- 确认 --> O[重启并替换\nelectron autoUpdater / 覆盖安装]
    O --> P{安装成功?}
    P -- 否 --> Q[回滚到 backup/ 版本]
    P -- 是 --> R[启动新版本]

    F -- 插件热更新 --> S[下载新 Plugin\n写入 plugins/pending/]
    S --> T[SHA256 验证 + manifest 合法性]
    T --> U[PluginLoader 热加载新版本\n新 Child Process fork]
    U --> V[旧 Child Process 优雅关闭\n处理完当前命令后退出]
    V --> W[零停机切换完成]

    F -- 前端资源 --> X[Service Worker\n后台下载新资源]
    X --> Y[前端显示 Toast\n"已下载新版本，刷新生效"]
    Y --> Z[用户主动刷新\n或下次打开时生效]

    style E fill:#4CAF50,color:#fff
    style J fill:#f44336,color:#fff
    style Q fill:#FF9800,color:#fff
    style R fill:#4CAF50,color:#fff
    style W fill:#4CAF50,color:#fff
```

## 三层更新对比

| 更新层 | 重启需求 | 热更新 | 回滚能力 | 用户感知 |
|--------|---------|--------|---------|---------|
| 应用主程序 | ✅ 需要重启 | ❌ | ✅ backup 目录 | 高（需确认）|
| 插件 | ❌ 无需重启 | ✅ | ✅ 版本快照 | 低（静默）|
| 前端资源 | ❌ 无需重启 | ✅（刷新生效）| ✅ Service Worker 缓存版本 | 中（Toast 提示）|

## 回滚触发条件

- 主程序：安装后启动失败（exit code ≠ 0 或 5s 内进程崩溃）
- 插件：新 Child Process 启动失败 / manifest 合法性检查失败
- 前端：Service Worker 激活失败（自动降级到上一缓存版本）
