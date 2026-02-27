# 设计文档 07 — Frontend MW & UI

> **所属模块**: `packages/frontend/`  
> **技术栈**: React 18+、TypeScript 5 strict、Zustand、Shadcn/UI + Tailwind CSS  
> **子层划分**: `mw/`（中间件，无 UI）+ `ui/`（React 组件）

---

## 1. 目录结构

```
packages/frontend/
├── mw/                       # 中间件层（无 JSX，可独立测试）
│   ├── ws/
│   │   ├── ws-client.ts      # WsClient 类（连接/重连/路由）
│   │   └── ws-event-bus.ts   # 全局 EventEmitter（发布 WS 事件）
│   ├── stores/
│   │   ├── device-store.ts   # Zustand：设备状态
│   │   ├── notification-store.ts
│   │   ├── metrics-store.ts
│   │   └── plugin-store.ts
│   ├── commands/
│   │   └── command-service.ts  # CommandService（sendCommand / broadcast）
│   └── protocol/
│       └── binary-frame.ts   # Binary Frame 解析（ArrayBuffer → 结构体）
│
└── ui/
    ├── components/
    │   ├── device-card.tsx
    │   ├── device-list.tsx
    │   ├── hex-dump.tsx        # Binary Frame / 原始字节可视化
    │   ├── notification-bell.tsx
    │   └── metrics-chart.tsx
    ├── pages/
    │   ├── dashboard-page.tsx
    │   ├── devices-page.tsx
    │   ├── plugins-page.tsx
    │   └── settings-page.tsx
    ├── hooks/
    │   ├── use-ws-event.ts     # 订阅单种 WS event type
    │   ├── use-device-channel.ts # 命令收发 + 订阅
    │   └── use-packet-tap.ts   # Binary Frame 订阅 + 解析
    └── theme/
        └── index.ts            # Tailwind + Shadcn 主题
```

---

## 2. WsClient

```typescript
// packages/frontend/mw/ws/ws-client.ts

import { wsEventBus } from './ws-event-bus';

const RECONNECT_DELAY_MS   = 2000;
const MAX_RECONNECT_ATTEMPTS = 10;

export class WsClient {
  private ws?:         WebSocket;
  private url:         string;
  private attempt      = 0;
  private destroyed    = false;

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    if (this.destroyed) return;
    this.ws = new WebSocket(this.url);
    this.ws.binaryType = 'arraybuffer';   // ← 必须设置，否则收到 Blob

    this.ws.onopen    = ()    => { this.attempt = 0; wsEventBus.emit('ws:open'); };
    this.ws.onclose   = (ev)  => { wsEventBus.emit('ws:close', ev); this.scheduleReconnect(); };
    this.ws.onerror   = (ev)  => { wsEventBus.emit('ws:error', ev); };
    this.ws.onmessage = (ev)  => {
      if (ev.data instanceof ArrayBuffer) {
        wsEventBus.emit('ws:binary', ev.data);   // → PacketTap 处理
      } else {
        try {
          const msg = JSON.parse(ev.data as string) as { type: string; payload: unknown };
          wsEventBus.emit(msg.type, msg.payload);  // → 各 Store 的 useWsEvent 订阅
        } catch { /* 忽略非法 JSON */ }
      }
    };
  }

  send(type: string, payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.ws?.close();
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.attempt >= MAX_RECONNECT_ATTEMPTS) {
      wsEventBus.emit('ws:reconnect-exhausted');
      return;
    }
    this.attempt++;
    setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }
}

// 单例导出
export const wsClient = new WsClient(
  `ws://${window.location.host}/ws`
);
```

---

## 3. Zustand Stores

### 3.1 DeviceStore

```typescript
// packages/frontend/mw/stores/device-store.ts

import { create } from 'zustand';

const MAX_EVENTS_PER_DEVICE = 200;

export interface DeviceStoreState {
  devices:    Map<string, DeviceInfo>;
  eventBuffer: Map<string, DeviceEvent[]>; // deviceId → 最近 200 条事件
  wsStatus:   'connecting' | 'open' | 'closed' | 'reconnecting';

  // Actions
  upsertDevice(info: DeviceInfo): void;
  removeDevice(deviceId: string): void;
  appendEvent(event: DeviceEvent): void;
  setWsStatus(status: DeviceStoreState['wsStatus']): void;

  // Selectors（纯函数，不存入 state）
  getDevice(deviceId: string): DeviceInfo | undefined;
  getConnectedDevices(): DeviceInfo[];
}

export const useDeviceStore = create<DeviceStoreState>((set, get) => ({
  devices:     new Map(),
  eventBuffer: new Map(),
  wsStatus:    'connecting',

  upsertDevice(info) {
    set(s => { s.devices.set(info.deviceId, info); return { devices: new Map(s.devices) }; });
  },
  removeDevice(deviceId) {
    set(s => {
      s.devices.delete(deviceId);
      s.eventBuffer.delete(deviceId);
      return { devices: new Map(s.devices), eventBuffer: new Map(s.eventBuffer) };
    });
  },
  appendEvent(event) {
    set(s => {
      const buf = s.eventBuffer.get(event.deviceId) ?? [];
      const next = [...buf, event].slice(-MAX_EVENTS_PER_DEVICE);
      s.eventBuffer.set(event.deviceId, next);
      return { eventBuffer: new Map(s.eventBuffer) };
    });
  },
  setWsStatus(status) { set({ wsStatus: status }); },

  getDevice(deviceId)       { return get().devices.get(deviceId); },
  getConnectedDevices()     { return [...get().devices.values()].filter(d => d.status === 'connected'); },
}));
```

### 3.2 NotificationStore

```typescript
// packages/frontend/mw/stores/notification-store.ts

export interface Notification {
  id:        string;
  severity:  'info' | 'warning' | 'error';
  message:   string;
  timestamp: number;
  read:      boolean;
}

export interface NotificationStoreState {
  notifications: Notification[];
  unreadCount:   number;

  push(n: Omit<Notification, 'id' | 'read'>): void;
  markAllRead(): void;
  dismiss(id: string): void;
}

export const useNotificationStore = create<NotificationStoreState>((set) => ({
  notifications: [],
  unreadCount:   0,

  push(n) {
    const item: Notification = { ...n, id: crypto.randomUUID(), read: false };
    set(s => ({
      notifications: [item, ...s.notifications].slice(0, 100), // 最多保留 100 条
      unreadCount:   s.unreadCount + 1,
    }));
  },
  markAllRead() {
    set(s => ({
      notifications: s.notifications.map(n => ({ ...n, read: true })),
      unreadCount:   0,
    }));
  },
  dismiss(id) {
    set(s => ({
      notifications: s.notifications.filter(n => n.id !== id),
      unreadCount:   s.notifications.filter(n => n.id !== id && !n.read).length,
    }));
  },
}));
```

### 3.3 MetricsStore

```typescript
// packages/frontend/mw/stores/metrics-store.ts

export interface MetricsSnapshot {
  timestamp:        number;
  cpuPercent:       number;
  memoryMb:         number;
  activeDevices:    number;
  bytesInPerSec:    number;
  bytesOutPerSec:   number;
  pendingCommands:  number;
  wsClientCount:    number;
}

export interface MetricsStoreState {
  snapshots: MetricsSnapshot[];  // 最多 60 个（= 5 分钟 @5s 间隔）
  push(snapshot: MetricsSnapshot): void;
  latest(): MetricsSnapshot | undefined;
}

export const useMetricsStore = create<MetricsStoreState>((set, get) => ({
  snapshots: [],
  push(snapshot) {
    set(s => ({ snapshots: [...s.snapshots, snapshot].slice(-60) }));
  },
  latest() { return get().snapshots.at(-1); },
}));
```

### 3.4 PluginStore

```typescript
// packages/frontend/mw/stores/plugin-store.ts

export interface PluginStoreState {
  plugins: Map<string, PluginInfo>;
  upsertPlugin(info: PluginInfo): void;
  removePlugin(pluginId: string): void;
}

export const usePluginStore = create<PluginStoreState>((set) => ({
  plugins: new Map(),
  upsertPlugin(info) {
    set(s => { s.plugins.set(info.pluginId, info); return { plugins: new Map(s.plugins) }; });
  },
  removePlugin(pluginId) {
    set(s => { s.plugins.delete(pluginId); return { plugins: new Map(s.plugins) }; });
  },
}));
```

---

## 4. WS 事件 → Store 映射表

| WS type | Store | Action | 说明 |
|---------|-------|--------|------|
| `device:connected` | DeviceStore | `upsertDevice(payload.device)` | 设备新增/更新 |
| `device:disconnected` | DeviceStore | `upsertDevice({ ...existing, status:'disconnected' })` | 状态更新 |
| `device:reconnecting` | DeviceStore | `upsertDevice({ ...existing, status:'reconnecting' })` | — |
| `device:removed` | DeviceStore | `removeDevice(payload.deviceId)` | 从 Map 删除 |
| `device:status` | DeviceStore | `upsertDevice({ ...existing, ...payload })` | 通用状态变更 |
| `device:event` | DeviceStore | `appendEvent(payload)` | 事件历史追加 |
| `device:response` | — | Promise resolve（useDeviceChannel 内部处理） | — |
| `notification` | NotificationStore | `push(payload)` | 系统通知 |
| `metrics:update` | MetricsStore | `push(payload)` | 指标更新 |
| `plugin:status` | PluginStore | `upsertPlugin(payload)` | 插件状态 |
| `ws:open` | DeviceStore | `setWsStatus('open')` | WS 连通 |
| `ws:close` | DeviceStore | `setWsStatus('closed')` | WS 断开 |
| `ws:reconnect-exhausted` | NotificationStore | `push({ severity:'error', ... })` | 重连耗尽通知 |

---

## 5. Hooks

### 5.1 useWsEvent

```typescript
// packages/frontend/ui/hooks/use-ws-event.ts

import { useEffect } from 'react';
import { wsEventBus } from '../../mw/ws/ws-event-bus';

export function useWsEvent<T = unknown>(
  eventType: string,
  handler:   (payload: T) => void
): void {
  useEffect(() => {
    const cb = (payload: T) => handler(payload);
    wsEventBus.on(eventType, cb);
    return () => { wsEventBus.off(eventType, cb); };
  }, [eventType, handler]);
}
```

### 5.2 useDeviceChannel

```typescript
// packages/frontend/ui/hooks/use-device-channel.ts

import { useCallback, useRef } from 'react';
import { wsClient } from '../../mw/ws/ws-client';
import { wsEventBus } from '../../mw/ws/ws-event-bus';

const COMMAND_TIMEOUT_MS = 5000;

export interface DeviceChannelHook {
  sendCommand(commandId: string, params: Record<string, unknown>): Promise<CommandResult>;
  subscribe(endpointIds?: string[]): void;
  unsubscribe(): void;
}

export function useDeviceChannel(deviceId: string): DeviceChannelHook {
  const pendingRef = useRef(new Map<string, {
    resolve: (r: CommandResult) => void;
    reject:  (e: Error)         => void;
    timer:   ReturnType<typeof setTimeout>;
  }>());

  // 监听 device:response，解析 correlationId
  useWsEvent<CommandResult>('device:response', useCallback((result) => {
    const pending = pendingRef.current.get(result.correlationId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingRef.current.delete(result.correlationId);
    result.success ? pending.resolve(result) : pending.reject(
      Object.assign(new Error(result.errorMessage ?? ''), { errorCode: result.errorCode })
    );
  }, []));

  const sendCommand = useCallback(
    (commandId: string, params: Record<string, unknown>): Promise<CommandResult> => {
      const correlationId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRef.current.delete(correlationId);
          reject(Object.assign(
            new Error(`Command timeout: ${commandId}`),
            { errorCode: 'COMMAND_TIMEOUT' }
          ));
        }, COMMAND_TIMEOUT_MS);

        pendingRef.current.set(correlationId, { resolve, reject, timer });
        wsClient.send('device:command', { deviceId, commandId, params, correlationId });
      });
    }, [deviceId]
  );

  const subscribe = useCallback((endpointIds?: string[]) => {
    wsClient.send('device:subscribe', { deviceId, endpointIds });
  }, [deviceId]);

  const unsubscribe = useCallback(() => {
    wsClient.send('device:unsubscribe', { deviceId });
  }, [deviceId]);

  return { sendCommand, subscribe, unsubscribe };
}
```

### 5.3 usePacketTap

```typescript
// packages/frontend/ui/hooks/use-packet-tap.ts

import { useEffect } from 'react';
import { wsEventBus } from '../../mw/ws/ws-event-bus';
import { wsClient   } from '../../mw/ws/ws-client';

export interface ParsedBinaryFrame {
  deviceId:  string;
  frameType: number;
  timestamp: number;
  payload:   Uint8Array;
}

const MAGIC = 0x44425247; // "DBRG" as uint32-be

export function usePacketTap(
  deviceId: string,
  onFrame:  (frame: ParsedBinaryFrame) => void
): void {
  useEffect(() => {
    wsClient.send('packettap:subscribe', { deviceId });

    const handler = (ab: ArrayBuffer) => {
      const view = new DataView(ab);
      if (ab.byteLength < 32) return;

      // 验证 magic（4 字节，big-endian 读取以对齐字符顺序）
      const magic = view.getUint32(0, false);
      if (magic !== MAGIC) return;

      const frameType = view.getUint32(4, true);

      // deviceId：offset 8，16 字节 UTF-8（去尾部 0x00）
      const idBytes  = new Uint8Array(ab, 8, 16);
      const frameDeviceId = new TextDecoder().decode(
        idBytes.subarray(0, idBytes.indexOf(0) === -1 ? 16 : idBytes.indexOf(0))
      );
      if (frameDeviceId !== deviceId) return;

      // timestamp：offset 24，uint64-le（JS 用两个 uint32 读取，忽略高 32 位）
      const timestampLow  = view.getUint32(24, true);
      const timestampHigh = view.getUint32(28, true);
      const timestamp     = timestampHigh * 0x100000000 + timestampLow;

      const payload = new Uint8Array(ab, 32);

      onFrame({ deviceId: frameDeviceId, frameType, timestamp, payload });
    };

    wsEventBus.on('ws:binary', handler);
    return () => {
      wsEventBus.off('ws:binary', handler);
      wsClient.send('packettap:unsubscribe', { deviceId });
    };
  }, [deviceId, onFrame]);
}
```

---

## 6. CommandService（mw 层）

```typescript
// packages/frontend/mw/commands/command-service.ts

export interface CommandService {
  /** 向单台设备发送命令，等待响应（REST 方式） */
  sendCommand(
    deviceId:  string,
    commandId: string,
    params:    Record<string, unknown>,
    options?:  { timeoutMs?: number }
  ): Promise<CommandResult>;

  /** 广播命令到多台设备 */
  broadcast(
    commandId: string,
    params:    Record<string, unknown>,
    deviceIds: string[]
  ): Promise<BroadcastResult>;
}

export const commandService: CommandService = {
  async sendCommand(deviceId, commandId, params, options) {
    const resp = await fetch(`/api/v1/devices/${deviceId}/command`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ commandId, params, timeoutMs: options?.timeoutMs }),
    });
    const json = await resp.json() as { data: CommandResult } | { error: unknown };
    if (!resp.ok || 'error' in json) throw json;
    return (json as { data: CommandResult }).data;
  },

  async broadcast(commandId, params, deviceIds) {
    const resp = await fetch('/api/v1/devices/broadcast', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ commandId, params, deviceIds }),
    });
    const json = await resp.json() as { data: BroadcastResult } | { error: unknown };
    if (!resp.ok || 'error' in json) throw json;
    return (json as { data: BroadcastResult }).data;
  },
};
```

---

## 7. 高频事件批处理

```typescript
// packages/frontend/mw/ws/ws-event-bus.ts（批处理实现）

const BATCH_INTERVAL_MS = 16; // ≈ 60fps

let pendingEvents: Array<{ type: string; payload: unknown }> = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

export function batchEmit(type: string, payload: unknown): void {
  pendingEvents.push({ type, payload });
  if (!batchTimer) {
    batchTimer = setTimeout(() => {
      const events = pendingEvents.splice(0);
      batchTimer = null;
      for (const ev of events) wsEventBus.emit(ev.type, ev.payload);
    }, BATCH_INTERVAL_MS);
  }
}
```

> 高频事件（`device:event`、`metrics:update`）使用 `batchEmit()` 代替 `wsEventBus.emit()`，合并到 16ms 时间窗，避免 React 频繁重渲染。

---

## 8. 组件树

```
App
├── Router
│   ├── /                    DashboardPage
│   │   ├── DeviceList
│   │   │   └── DeviceCard (× N)
│   │   └── MetricsChart
│   ├── /devices             DevicesPage
│   │   ├── DeviceList
│   │   └── DevToolsPanel
│   │       └── HexDump (PacketTap 可视化)
│   ├── /plugins             PluginsPage
│   └── /settings            SettingsPage
└── NotificationBell (全局, 悬浮)
```

### DeviceCard 使用示例

```tsx
// packages/frontend/ui/components/device-card.tsx

export function DeviceCard({ deviceId }: { deviceId: string }) {
  const info    = useDeviceStore(s => s.getDevice(deviceId));
  const { sendCommand } = useDeviceChannel(deviceId);
  const [loading, setLoading] = useState(false);

  if (!info) return null;

  const handleGetVersion = async () => {
    setLoading(true);
    try {
      const result = await sendCommand('GET_VERSION', {});
      alert(`Firmware: ${result.data?.['version']}`);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium">{info.name}</span>
        <StatusBadge status={info.status} />
      </div>
      <p className="text-sm text-muted-foreground">{info.deviceId}</p>
      <Button size="sm" disabled={loading} onClick={handleGetVersion}>
        {loading ? 'Sending…' : 'Get Version'}
      </Button>
    </div>
  );
}
```

---

## 9. i18n 键名约定

```
{domain}.{action_or_state}
```

| 键名 | 中文示例值 |
|------|---------|
| `device.connect` | 连接设备 |
| `device.disconnect` | 断开连接 |
| `device.reconnecting` | 重连中… |
| `device.status.connected` | 已连接 |
| `device.status.error` | 连接错误 |
| `plugin.hotUpdate` | 热更新插件 |
| `plugin.status.crashed` | 插件崩溃 |
| `command.send` | 发送命令 |
| `command.timeout` | 命令超时 |
| `error.unknown` | 未知错误 |
| `error.networkLost` | 网络连接中断 |
| `settings.save` | 保存设置 |
| `notification.markAllRead` | 全部已读 |

---

## 10. 测试要点

- **WsClient binaryType**：连接建立后断言 `ws.binaryType === 'arraybuffer'`
- **Text Frame 路由**：发送 `{ type: 'device:connected', payload: {...} }` → 断言 DeviceStore.devices 新增
- **Binary Frame 路由**：发送合法 DBRG ArrayBuffer → 断言 wsEventBus 触发 `ws:binary`
- **usePacketTap magic 过滤**：发送 magic=0x00000000 的 ArrayBuffer，断言 onFrame 不被调用
- **useDeviceChannel 超时**：不注入 device:response，等 5100ms，断言 Promise reject COMMAND_TIMEOUT
- **batchEmit 合并**：16ms 内多次 batchEmit('device:event')，断言只触发一次 React re-render
- **NotificationStore dismiss**：push 3 条 → dismiss id[1] → 断言 notifications.length=2，unreadCount 正确
- **MetricsStore 上限**：push 61 个 snapshot，断言 snapshots.length=60
