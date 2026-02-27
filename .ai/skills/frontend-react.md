# Skill: Frontend React — 前端架构与组件设计

## Preconditions

当以下情况发生时激活本 skill：
- 用户需要实现 React 前端组件（设备列表、通知中心、MetricsPanel、DevTools）
- 涉及 WebSocket 连接管理（自动重连、消息路由）
- 用户讨论 Zustand DeviceStore 设计
- 涉及 `useDeviceChannel` Hook 的实现
- 涉及 Recharts 性能图表、react-i18next 语言切换
- 用户需要前端 Shadcn/UI + Tailwind 组件规范

## 前端双层架构（MW / UI）

```
client/src/
├── mw/                    ← MW 中间层（业务逻辑，无 JSX）
│   ├── ws/                # WsClient 单例、消息路由、自动重连
│   ├── stores/            # Zustand stores（设备、命令、通知、诊断）
│   ├── commands/          # CommandService：命令构建 + ws.send
│   └── protocol/          # PacketTap：Binary Frame 解析
└── ui/                    ← UI 层（纯渲染）
    ├── components/        # React 组件（无业务逻辑）
    ├── pages/             # 页面路由
    ├── hooks/             # useDevice / useCommand 等，封装 store 读取
    └── theme/             # Tailwind / Shadcn 主题
```

**边界规则：**
- UI 组件只做：`const { devices } = useDeviceStore()` 读状态 + 调 action
- MW 层只做：持有 WsClient、维护 Store、处理 Binary Frame
- UI 层 **禁止** 直接 `import WsClient` 或调用 `ws.send()`
- MW 层 **禁止** 出现任何 JSX / `React.createElement`

---

## Instructions

### WebSocket 连接管理

```typescript
// packages/client/src/hooks/useWebSocket.ts

/** 单例 WebSocket 连接（整个应用共享） */
class WsClient {
  private ws?: WebSocket;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private subscribers = new Map<string, Set<(payload: unknown) => void>>();
  private reconnectDelay = 1000;

  connect(url: string): void {
    this.ws = new WebSocket(url);
    this.ws.onopen    = () => { this.reconnectDelay = 1000; this.emit('ws:open', {}); };
    this.ws.onclose   = () => { this.emit('ws:close', {}); this.scheduleReconnect(url); };
    this.ws.onerror   = (e) => this.emit('ws:error', e);
    this.ws.binaryType = 'arraybuffer';  // 必须设置，否则收到 Blob 无法直接操作
    this.ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) {
        // Binary Frame → PacketTap rawBuffer（由 mw/protocol/PacketTap 处理）
        this.emit('ws:binary', e.data);
        return;
      }
      const msg = JSON.parse(e.data) as WsMessage<unknown>;
      this.emit(msg.type, msg.payload);
    };
  }

  private scheduleReconnect(url: string): void {
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30_000);
      this.connect(url);
    }, this.reconnectDelay);
  }

  subscribe<T>(type: string, handler: (payload: T) => void): () => void {
    if (!this.subscribers.has(type)) this.subscribers.set(type, new Set());
    this.subscribers.get(type)!.add(handler as (p: unknown) => void);
    return () => this.subscribers.get(type)?.delete(handler as (p: unknown) => void);
  }

  send(type: string, payload: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    }
  }

  private emit(type: string, payload: unknown): void {
    this.subscribers.get(type)?.forEach(h => h(payload));
  }
}

export const wsClient = new WsClient();

export function useWsEvent<T>(type: string, handler: (payload: T) => void): void {
  useEffect(() => wsClient.subscribe(type, handler), [type]);
}
```

### Zustand DeviceStore

```typescript
// packages/client/src/stores/device-store.ts

interface DeviceState {
  devices: Map<string, DeviceInfo>;
  events: Map<string, DeviceEvent[]>;        // 设备最近 50 条事件
  connectionStatus: 'connecting' | 'connected' | 'disconnected';

  // Actions
  upsertDevice:   (device: DeviceInfo) => void;
  removeDevice:   (deviceId: string) => void;
  appendEvent:    (event: DeviceEvent) => void;
  clearEvents:    (deviceId: string) => void;
  setWsStatus:    (status: DeviceState['connectionStatus']) => void;
}

export const useDeviceStore = create<DeviceState>()(
  devtools(
    (set) => ({
      devices: new Map(),
      events: new Map(),
      connectionStatus: 'connecting',

      upsertDevice: (device) => set(state => {
        const next = new Map(state.devices);
        next.set(device.id, device);
        return { devices: next };
      }),

      removeDevice: (deviceId) => set(state => {
        const next = new Map(state.devices);
        next.delete(deviceId);
        return { devices: next };
      }),

      appendEvent: (event) => set(state => {
        const list = [...(state.events.get(event.deviceId) ?? []), event].slice(-50);
        const next = new Map(state.events);
        next.set(event.deviceId, list);
        return { events: next };
      }),

      clearEvents: (deviceId) => set(state => {
        const next = new Map(state.events);
        next.set(deviceId, []);
        return { events: next };
      }),

      setWsStatus: (connectionStatus) => set({ connectionStatus }),
    }),
    { name: 'DeviceStore' }
  )
);

/** 在应用顶层初始化 WebSocket 事件绑定 */
export function useDeviceStoreSync(): void {
  const { upsertDevice, removeDevice, appendEvent, setWsStatus } = useDeviceStore();

  useEffect(() => {
    wsClient.connect(`ws://${window.location.host}/ws`);
    const unsubs = [
      wsClient.subscribe('device:connected',    upsertDevice),
      wsClient.subscribe('device:disconnected', ({ deviceId }: { deviceId: string }) =>
        upsertDevice({ id: deviceId, status: 'disconnected' } as DeviceInfo)
      ),
      wsClient.subscribe('device:removed',      ({ deviceId }: { deviceId: string }) =>
        removeDevice(deviceId)
      ),
      wsClient.subscribe('device:event',        appendEvent),
      wsClient.subscribe('ws:open',             () => setWsStatus('connected')),
      wsClient.subscribe('ws:close',            () => setWsStatus('disconnected')),
    ];
    return () => unsubs.forEach(fn => fn());
  }, []);
}
```

### useDeviceChannel Hook

```typescript
// packages/client/src/hooks/useDeviceChannel.ts

interface UseDeviceChannelOptions {
  deviceId: string;
  onEvent?: (event: DeviceEvent) => void;
}

interface UseDeviceChannelResult {
  // 发送命令并等待响应
  sendCommand: (commandId: string, params?: object) => Promise<DeviceResponse>;
  // 订阅设备事件（仅此设备）
  subscribe: () => void;
  unsubscribe: () => void;
  isSubscribed: boolean;
}

export function useDeviceChannel({
  deviceId,
  onEvent
}: UseDeviceChannelOptions): UseDeviceChannelResult {
  const [isSubscribed, setIsSubscribed] = useState(false);
  const pendingRef = useRef(new Map<string, (resp: DeviceResponse) => void>());

  const sendCommand = useCallback(
    async (commandId: string, params?: object): Promise<DeviceResponse> => {
      const correlationId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pendingRef.current.delete(correlationId);
          reject(new Error(`Command timeout: ${commandId}`));
        }, 5000);

        pendingRef.current.set(correlationId, (resp) => {
          clearTimeout(timeout);
          resolve(resp);
        });

        wsClient.send('device:command', { deviceId, commandId, params, correlationId });
      });
    },
    [deviceId]
  );

  useWsEvent<DeviceResponse>('device:response', (resp) => {
    const resolver = pendingRef.current.get(resp.correlationId);
    if (resolver) {
      pendingRef.current.delete(resp.correlationId);
      resolver(resp);
    }
  });

  useWsEvent<DeviceEvent>('device:event', (event) => {
    if (event.deviceId === deviceId && onEvent) onEvent(event);
  });

  const subscribe   = useCallback(() => {
    wsClient.send('device:subscribe', { deviceId });
    setIsSubscribed(true);
  }, [deviceId]);

  const unsubscribe = useCallback(() => {
    wsClient.send('device:unsubscribe', { deviceId });
    setIsSubscribed(false);
  }, [deviceId]);

  return { sendCommand, subscribe, unsubscribe, isSubscribed };
}
```

### 设备列表组件（Shadcn/UI + Tailwind）

```tsx
// packages/client/src/components/DeviceList.tsx

export function DeviceList(): React.ReactElement {
  const { t } = useTranslation();
  const devices = useDeviceStore(s => [...s.devices.values()]);

  return (
    <div className="flex flex-col gap-2 p-4">
      <h2 className="text-lg font-semibold">{t('device.list.title')}</h2>
      {devices.length === 0 && (
        <p className="text-muted-foreground text-sm">{t('device.list.empty')}</p>
      )}
      {devices.map(device => (
        <DeviceCard key={device.id} device={device} />
      ))}
    </div>
  );
}

function DeviceCard({ device }: { device: DeviceInfo }): React.ReactElement {
  const { t } = useTranslation();
  const statusColor: Record<DeviceStatus, string> = {
    connected:    'bg-green-500',
    reconnecting: 'bg-yellow-500',
    disconnected: 'bg-gray-400',
    error:        'bg-red-500',
    scanning:     'bg-blue-400',
    identified:   'bg-blue-600',
    removed:      'bg-gray-300',
  };

  return (
    <Card className="p-3 flex items-center gap-3">
      <span className={`w-2 h-2 rounded-full ${statusColor[device.status]}`} />
      <div className="flex-1 min-w-0">
        <p className="font-medium truncate">{device.name ?? device.id}</p>
        <p className="text-xs text-muted-foreground">
          {device.transport} · {device.vendorId}:{device.productId}
        </p>
      </div>
      <Badge variant={device.status === 'connected' ? 'default' : 'secondary'}>
        {t(`device.status.${device.status}`)}
      </Badge>
    </Card>
  );
}
```

### Metrics Dashboard（Recharts）

```tsx
// packages/client/src/components/MetricsPanel.tsx

export function MetricsPanel(): React.ReactElement {
  const [data, setData] = useState<LatencyPoint[]>([]);

  useEffect(() => {
    const id = setInterval(async () => {
      const res = await fetch('/api/v1/metrics/latency?window=60000');
      const json = await res.json() as LatencyPercentiles & { ts: number };
      setData(prev => [...prev.slice(-59), { ...json, ts: Date.now() }]);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="p-4">
      <h3 className="font-semibold mb-2">命令延迟 (ms)</h3>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="ts" tickFormatter={ts => new Date(ts).toLocaleTimeString()} />
          <YAxis unit="ms" />
          <Tooltip />
          <Legend />
          <Line type="monotone" dataKey="p50"  stroke="#22c55e" dot={false} name="P50" />
          <Line type="monotone" dataKey="p95"  stroke="#f59e0b" dot={false} name="P95" />
          <Line type="monotone" dataKey="p99"  stroke="#ef4444" dot={false} name="P99" />
          {/* SLA 5ms 参考线 */}
          <ReferenceLine y={5} stroke="#ef4444" strokeDasharray="4 2" label="SLA 5ms" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

---

## Constraints

- Zustand store 中的 `devices` / `events` 使用 `Map`，**禁止**使用数组避免 O(n) 查找
- `useDeviceChannel` 的 `sendCommand` **必须**设置 5s 超时并清理 `pendingRef`，防止内存泄漏
- 组件**禁止**直接调用 `fetch` 到设备管理 API，状态**必须**通过 WebSocket 消息推送更新（单向数据流）
- Recharts 图表使用 `ResponsiveContainer`，**禁止**写死像素宽高
- i18n key **必须**使用点号分层命名（`device.status.connected`），**禁止**直接写中文字符串在 JSX 中
- Shadcn 组件**必须**从 `@/components/ui` 导入（路径别名），**禁止**直接从 `@radix-ui` 导入
- 所有 WebSocket 消息订阅**必须**在 `useEffect` 返回函数中取消订阅，防止内存泄漏

---

## Examples

### 通知中心 UI 数据流

```
1. 服务端 notificationManager.notify('error', 'diagnostics', '...') 
   → wsServer.broadcast({ type: 'notification', payload: {...} })
2. 前端 wsClient.subscribe('notification', ...) 接收
3. 存入 notificationStore（Zustand），最近 50 条
4. NotificationBell 组件显示未读数（红点 badge）
5. 点击铃铛 → NotificationDrawer 弹出，列表展示所有通知
6. 点击操作按钮（如 "复制修复命令"）→ 执行对应动作
```
