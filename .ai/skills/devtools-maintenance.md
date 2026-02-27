# Skill: DevTools & Maintenance — 开发工具与运维

## Preconditions

当以下情况发生时激活本 skill：
- 用户需要实现抓包/Packet Tap 调试功能
- 涉及前端 Hex Dump 面板（字段彩色高亮、录制/回放）
- 用户讨论手动发送 Raw Hex 命令
- 涉及自动更新机制（AppUpdater）
- 用户需要配置导入/导出（zip 打包 + diff 预览）
- 涉及 i18n 国际化（react-i18next、中英文切换）

---

## Instructions

### PacketTap — 零开销可插拔抓包

PacketTap 作为 TransformStream 插入 Transport→Protocol 管道中间。关闭时不创建 Transform 对象，热路径零开销。

```typescript
// packages/server/src/devtools/packet-tap.ts

class PacketTap {
  private sessions = new Map<string, TapSession>();

  /** 
   * 为设备创建 tap（Transport read 事件 → 同时转发给所有已订阅的 WS 客户端）
   * 只在前端打开 DevTools 面板时调用，平时不创建
   */
  createTap(deviceId: string, direction: 'in' | 'out' | 'both'): TapSession {
    const session: TapSession = {
      id: crypto.randomUUID(),
      deviceId,
      direction,
      startTs: Date.now(),
      packetCount: 0,
      recording: false,
      recordedPackets: [],
    };
    this.sessions.set(session.id, session);
    return session;
  }

  /** Transport 层调用此方法转发原始数据 */
  tap(deviceId: string, direction: 'in' | 'out', rawData: Buffer, meta?: object): void {
    // 如果没有任何 session 监听此设备，立即返回（零开销）
    const matching = [...this.sessions.values()].filter(
      s => s.deviceId === deviceId &&
           (s.direction === 'both' || s.direction === direction)
    );
    if (matching.length === 0) return;

    const packet: TapPacket = {
      ts: Date.now(),
      deviceId,
      direction,
      rawHex: rawData.toString('hex'),
      length: rawData.length,
      meta,
    };

    for (const session of matching) {
      session.packetCount++;
      if (session.recording) {
        session.recordedPackets.push(packet);
      }
      // 推送到订阅的 WebSocket 客户端
      wsServer.sendToSession(session.wsClientId!, {
        type: 'devtools:packet',
        payload: packet,
      });
    }
  }

  stopTap(sessionId: string): TapSession | undefined {
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    return session;
  }
}

export const packetTap = new PacketTap();
```

在 `BaseTransport` 中集成：

```typescript
// packages/server/src/transports/base-transport.ts（关键路径注入）
protected emitRawInData(data: Buffer): void {
  // 抓包（仅当有 session 时有开销，否则 O(1) Map 查找）
  packetTap.tap(this.deviceId, 'in', data);
  this.emit('data', data);
}
```

### 录制 / 回放

```typescript
// 录制：前端调用 POST /api/v1/devtools/tap/:deviceId/record/start
tapSession.recording = true;

// 停止录制：POST .../record/stop → 返回 JSONL 文件
tapSession.recording = false;
const jsonl = tapSession.recordedPackets
  .map(p => JSON.stringify(p))
  .join('\n');

// 回放：POST /api/v1/devtools/replay/:deviceId
// body: { jsonl: string, speedMultiplier: number }
async function replay(deviceId: string, jsonl: string, speed = 1): Promise<void> {
  const packets: TapPacket[] = jsonl.split('\n')
    .filter(Boolean).map(line => JSON.parse(line));

  for (let i = 0; i < packets.length; i++) {
    const current = packets[i];
    if (i > 0) {
      const delay = (current.ts - packets[i - 1].ts) / speed;
      await sleep(Math.max(0, delay));
    }
    if (current.direction === 'out') {
      await deviceManager.sendRaw(deviceId, Buffer.from(current.rawHex, 'hex'));
    }
  }
}
```

### 手动发送 Raw Hex

```typescript
// POST /api/v1/devtools/send-raw
// body: { deviceId: string; hex: string; expectResponseMs?: number }
fastify.post('/api/v1/devtools/send-raw', async (req, reply) => {
  const { deviceId, hex, expectResponseMs } = req.body as SendRawBody;
  const buf = Buffer.from(hex.replace(/\s+/g, ''), 'hex');

  if (expectResponseMs) {
    // 等待下一个 IN 数据包
    const resp = await deviceManager.sendRawAndWaitResponse(
      deviceId, buf, expectResponseMs
    );
    return reply.send({ ok: true, responseHex: resp.toString('hex') });
  }

  await deviceManager.sendRaw(deviceId, buf);
  return reply.send({ ok: true });
});
```

### AppUpdater — 自动更新

```typescript
// packages/server/src/maintenance/updater.ts

class AppUpdater {
  async checkForUpdate(): Promise<UpdateInfo | null> {
    try {
      const resp = await fetch(
        `${UPDATE_FEED_URL}/latest.json?current=${process.env.APP_VERSION}`
      );
      if (!resp.ok) return null;
      const info = await resp.json() as UpdateInfo;
      if (!semver.gt(info.version, process.env.APP_VERSION!)) return null;
      return info;
    } catch {
      return null;
    }
  }

  async downloadAndApply(info: UpdateInfo): Promise<void> {
    notificationManager.notify('info', 'updater', `正在下载更新 v${info.version}...`);
    // 下载到临时目录，验证 SHA256，替换可执行文件，通知重启
    // 具体实现取决于部署方式（npm pkg / electron / systemd service）
  }
}
```

### 配置导入 / 导出

```typescript
// packages/server/src/maintenance/config-manager.ts

class ConfigManager {
  /** 导出：将 config/ + plugins/*/manifest.json + protocols/ 打包为 zip */
  async exportConfig(outputPath: string): Promise<void> {
    const zip = new AdmZip();
    zip.addLocalFolder(path.join(rootDir, 'config'),    'config');
    zip.addLocalFolder(path.join(rootDir, 'plugins'),   'plugins');
    zip.addLocalFolder(path.join(rootDir, 'protocols'), 'protocols');
    zip.writeZip(outputPath);
    logger.info({ outputPath }, 'config_exported');
  }

  /** 导入：解压并与当前配置做 diff，返回变更列表供用户确认 */
  async previewImport(zipPath: string): Promise<ConfigDiff[]> {
    const zip = new AdmZip(zipPath);
    const diffs: ConfigDiff[] = [];
    for (const entry of zip.getEntries()) {
      const newContent = entry.getData().toString('utf-8');
      const localPath = path.join(rootDir, entry.entryName);
      let oldContent: string | null = null;
      try { oldContent = await fs.readFile(localPath, 'utf-8'); } catch {}
      if (oldContent !== newContent) {
        diffs.push({ path: entry.entryName, type: oldContent ? 'modified' : 'added',
                     diff: createTwoFilePatch('old', 'new', oldContent ?? '', newContent) });
      }
    }
    return diffs;
  }

  /** 确认导入后实际写入 */
  async applyImport(zipPath: string, selectedPaths: string[]): Promise<void> {
    const zip = new AdmZip(zipPath);
    for (const entry of zip.getEntries()) {
      if (!selectedPaths.includes(entry.entryName)) continue;
      const localPath = path.join(rootDir, entry.entryName);
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, entry.getData());
    }
    // 触发热加载（协议和插件目录变更已由 chokidar 监听，自动重载）
  }
}
```

### i18n — react-i18next 配置

```typescript
// packages/client/src/i18n/index.ts

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enUS from './locales/en-US.json';
import zhCN from './locales/zh-CN.json';

i18n
  .use(initReactI18next)
  .init({
    resources: {
      'en-US': { translation: enUS },
      'zh-CN': { translation: zhCN },
    },
    lng: localStorage.getItem('DevBridge-locale') ?? 'zh-CN',
    fallbackLng: 'en-US',
    interpolation: { escapeValue: false },
  });

export default i18n;

// 使用示例
// const { t } = useTranslation();
// t('device.status.connected')  → "已连接" / "Connected"
```

---

## Constraints

- `PacketTap.tap()` 在没有活跃 session 时**必须**完全零开销（Map.size 判断后立即返回）；**禁止**在生产模式常驻抓包
- 录制文件使用 JSONL 格式（每行一个 JSON 对象），**禁止**使用 JSON 数组（无法流式处理大文件）
- Raw hex 手动发送**必须**通过 DevTools API 端点（需要 `devtools: true` feature flag 启用），**禁止**在生产 API 中暴露
- 配置导入**必须**先 `previewImport` 展示 diff，用户确认后才能 `applyImport`，**禁止**直接覆盖
- i18n namespace 统一为 `translation`，key 格式 `<module>.<subKey>`（如 `device.status.connected`）
- 自动更新下载**必须**验证 SHA256 签名，验证失败**禁止**写入磁盘

---

## Examples

### 前端 DevTools Hex Dump 面板数据流

```
1. 用户打开 DevTools → 前端 POST /api/v1/devtools/tap/:deviceId { direction: 'both' }
2. 服务端创建 TapSession，返回 sessionId
3. 前端 WebSocket 订阅 session → 接收 devtools:packet 消息
4. 每个 rawHex 数据包在前端解析为字段表格（根据 Protocol Schema 标注字段边界）
5. 用户点击 "开始录制" → POST .../record/start
6. 用户点击 "停止录制" → GET .../record/stop → 下载 .jsonl 文件
7. 用户关闭 DevTools → DELETE /api/v1/devtools/tap/:sessionId
```
