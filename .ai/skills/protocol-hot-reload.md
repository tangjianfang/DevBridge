# Skill: Protocol Hot Reload — 协议热加载

## Preconditions

当以下情况发生时激活本 skill：
- 用户需要在不重启服务的情况下更新协议 Schema
- 涉及 `chokidar` 文件监听实现
- 用户讨论协议版本兼容性和平滑升级
- 涉及 `ProtocolRegistry` 注册与注销流程
- 插件动态加载（manifest 或 schema 变更时重新组装）

---

## Instructions

### ProtocolRegistry — 协议注册中心

```typescript
class ProtocolRegistry {
  private protocols = new Map<string, IProtocol>();
  private versions = new Map<string, string>(); // name → version

  register(protocol: IProtocol): void {
    const existing = this.protocols.get(protocol.name);
    if (existing) {
      logger.info({ name: protocol.name, oldVersion: existing.version,
                    newVersion: protocol.version }, 'protocol_hot_replaced');
    }
    this.protocols.set(protocol.name, protocol);
    this.versions.set(protocol.name, protocol.version);
    eventBus.emit('protocol:updated', { name: protocol.name, version: protocol.version });
  }

  unregister(name: string): void {
    this.protocols.delete(name);
    this.versions.delete(name);
    eventBus.emit('protocol:removed', { name });
  }

  get(name: string): IProtocol {
    const p = this.protocols.get(name);
    if (!p) throw new Error(`PROTOCOL_NOT_FOUND: ${name}`);
    return p;
  }
}

export const protocolRegistry = new ProtocolRegistry();
```

### ProtocolHotLoader — 文件监听与热加载

```typescript
class ProtocolHotLoader {
  private watcher?: chokidar.FSWatcher;
  private loadingSet = new Set<string>(); // 防止并发加载同一文件

  start(watchDirs: string[]): void {
    this.watcher = chokidar.watch(
      watchDirs.map(d => path.join(d, '**/*.protocol.{json,yaml}')),
      {
        persistent: true,
        ignoreInitial: false, // 启动时加载已有文件
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 } // 等文件写完再处理
      }
    );

    this.watcher
      .on('add',    (filePath) => this.onFileChange(filePath, 'add'))
      .on('change', (filePath) => this.onFileChange(filePath, 'change'))
      .on('unlink', (filePath) => this.onFileRemove(filePath));
  }

  private async onFileChange(filePath: string, event: 'add' | 'change'): Promise<void> {
    if (this.loadingSet.has(filePath)) return; // 防并发
    this.loadingSet.add(filePath);

    try {
      // 1. 读取并解析 Schema 文件
      const raw = await fs.readFile(filePath, 'utf-8');
      const schema = filePath.endsWith('.yaml')
        ? yaml.parse(raw)
        : JSON.parse(raw);

      // 2. Schema 结构验证（Zod）
      const parsed = ProtocolSchemaZod.safeParse(schema);
      if (!parsed.success) {
        logger.error({ filePath, errors: parsed.error.flatten() }, 'protocol_schema_invalid');
        notificationManager.notify('error', 'protocol-loader',
          `协议 Schema 验证失败: ${path.basename(filePath)}`);
        return;
      }

      // 3. 编译（含 examples 自测）
      let compiled: IProtocol;
      try {
        compiled = ProtocolRuntimeEngine.compile(parsed.data);
      } catch (err) {
        logger.error({ filePath, err }, 'protocol_selftest_failed');
        notificationManager.notify('error', 'protocol-loader',
          `协议自测失败: ${path.basename(filePath)} — ${(err as Error).message}`);
        return;
      }

      // 4. 检查版本兼容性（semver）
      const existing = protocolRegistry.tryGet(compiled.name);
      if (existing && !semver.compatible(existing.version, compiled.version)) {
        logger.warn({ name: compiled.name, oldVer: existing.version, newVer: compiled.version },
          'protocol_version_incompatible');
        notificationManager.notify('warning', 'protocol-loader',
          `协议 ${compiled.name} 版本不兼容，需要手动确认升级`);
        return;
      }

      // 5. 平滑热替换：等待当前事务完成后切换
      await this.gracefulReplace(compiled);

    } finally {
      this.loadingSet.delete(filePath);
    }
  }

  private async gracefulReplace(newProtocol: IProtocol): Promise<void> {
    // 找到使用此协议的 DeviceChannel
    const affectedChannels = deviceManager.getChannelsByProtocol(newProtocol.name);

    // 等待所有进行中的命令完成（最长 2s）
    await Promise.all(affectedChannels.map(ch =>
      ch.drainPendingCommands(2000).catch(() => {})
    ));

    // 原子替换
    protocolRegistry.register(newProtocol);

    // 重新绑定 DeviceChannel
    for (const channel of affectedChannels) {
      channel.updateProtocol(newProtocol);
    }

    logger.info({ name: newProtocol.name, version: newProtocol.version }, 'protocol_hot_reloaded');
    notificationManager.notify('info', 'protocol-loader',
      `协议 ${newProtocol.name} v${newProtocol.version} 已热加载`);
  }

  private async onFileRemove(filePath: string): Promise<void> {
    const schemaName = this.filePathToProtocolName(filePath);
    // 检查是否有设备在使用
    const users = deviceManager.getChannelsByProtocol(schemaName);
    if (users.length > 0) {
      logger.warn({ schemaName, deviceCount: users.length }, 'protocol_removed_while_in_use');
      notificationManager.notify('warning', 'protocol-loader',
        `协议 ${schemaName} 被删除，但仍有 ${users.length} 台设备在使用`);
    }
    protocolRegistry.unregister(schemaName);
  }

  stop(): void {
    this.watcher?.close();
  }
}
```

### Plugin 热加载（manifest 或 schema 变更）

```typescript
class PluginHotLoader {
  start(pluginsDir: string): void {
    const watcher = chokidar.watch(
      [
        path.join(pluginsDir, '*/manifest.json'),
        path.join(pluginsDir, '*/protocol.schema.json'),
        path.join(pluginsDir, '*/protocol.schema.yaml'),
      ],
      { awaitWriteFinish: { stabilityThreshold: 300 } }
    );

    watcher.on('change', async (filePath) => {
      const pluginDir = path.dirname(filePath);
      await this.reloadPlugin(pluginDir);
    });
  }

  private async reloadPlugin(pluginDir: string): Promise<void> {
    const manifest = await loadManifest(pluginDir);
    const schema = await loadSchema(pluginDir);

    // 1. 先热加载 Protocol Schema
    if (schema) {
      const compiled = ProtocolRuntimeEngine.compile(schema);
      protocolRegistry.register(compiled);
    }

    // 2. 更新 Plugin 注册
    pluginLoader.updatePlugin(manifest);

    // 3. 通知已连接的使用此 Plugin 的设备重新绑定
    const channels = deviceManager.getChannelsByPlugin(manifest.name);
    for (const channel of channels) {
      await channel.reloadConfig(manifest, schema ? protocolRegistry.get(schema.name) : undefined);
    }
  }
}
```

---

## Constraints

- 热加载失败（Schema 无效、自测失败、版本不兼容）时**必须**保留旧版本继续运行，不能中断现有设备通信
- 热替换必须等待当前事务（pending commands）完成后才切换 Protocol，**禁止**在命令等待响应期间切换协议
- 同一文件的并发加载事件（短时间内多次 `change`）通过 `loadingSet` + `awaitWriteFinish` 防重
- `examples` 自测是加载的硬性门槛，自测失败**必须**拒绝加载并通知用户具体错误
- 版本不兼容（major 版本升级）需要用户手动确认，不自动强制升级
- 文件删除时如果仍有设备在使用该协议，**禁止**立即注销，应改为 `deprecated` 状态并发出告警

---

## Examples

### 热加载触发流程

```
1. 开发者修改 protocols/my-sensor.protocol.json
2. chokidar 'change' 事件触发（200ms awaitWriteFinish 后）
3. 读取文件 → JSON.parse → ZodValidate → 通过
4. ProtocolRuntimeEngine.compile() → selfTest() → examples 全部通过
5. 检查版本：1.0.0 → 1.1.0（minor 升级，兼容）
6. 等待正在进行的命令完成（最长 2s）
7. protocolRegistry.register(newProtocol)（原子替换）
8. 3 个 DeviceChannel 更新 protocol 引用
9. logger.info + WS 通知前端: "协议 my_sensor v1.1.0 已热加载"
10. 前端 Toast: "协议已更新"
```
