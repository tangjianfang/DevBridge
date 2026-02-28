import React, { useState, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useDeviceStore } from './mw/stores/device-store.js';
import { useNotificationStore } from './mw/stores/notification-store.js';
import { useMetricsStore } from './mw/stores/metrics-store.js';
import { commandService } from './mw/commands/command-service.js';

// ── Status badge ──────────────────────────────────────────────────────────────

function WsStatusBadge({ status }: { status: string }) {
  const colour =
    status === 'open'         ? '#22c55e' :
    status === 'connecting'   ? '#f59e0b' :
    status === 'reconnecting' ? '#f59e0b' : '#ef4444';
  return (
    <span style={{
      display:      'inline-flex',
      alignItems:   'center',
      gap:          '6px',
      fontSize:     '13px',
      color:        '#94a3b8',
    }}>
      <span style={{
        width: '8px', height: '8px', borderRadius: '50%',
        background: colour, display: 'inline-block',
      }} />
      {status}
    </span>
  );
}

// ── Device card ───────────────────────────────────────────────────────────────

function DeviceCard({ deviceId }: { deviceId: string }) {
  const device   = useDeviceStore(s => s.getDevice(deviceId));
  const events   = useDeviceStore(useShallow(s => s.eventBuffer.get(deviceId) ?? []));
  const [cmd, setCmd]     = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy]   = useState(false);

  if (!device) return null;

  const statusColor =
    device.status === 'connected'    ? '#22c55e' :
    device.status === 'reconnecting' ? '#f59e0b' : '#64748b';

  async function sendCommand() {
    if (!cmd.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await commandService.sendCommand(deviceId, cmd.trim(), {});
      setResult(res.success ? `✓ ${JSON.stringify(res.data ?? 'ok')}` : `✗ ${res.errorMessage ?? 'error'}`);
    } catch (e) {
      setResult(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      background:   '#1e293b',
      border:       '1px solid #334155',
      borderRadius: '8px',
      padding:      '16px',
      marginBottom: '12px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        <span style={{
          width: '10px', height: '10px', borderRadius: '50%',
          background: statusColor, flexShrink: 0,
        }} />
        <strong style={{ color: '#f1f5f9', fontSize: '14px' }}>
          {device.name ?? device.deviceId}
        </strong>
        <span style={{ color: '#64748b', fontSize: '12px', marginLeft: 'auto' }}>
          {device.transportType} · {device.address}
        </span>
      </div>

      {/* Command input */}
      {device.status === 'connected' && (
        <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
          <input
            value={cmd}
            onChange={e => setCmd(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && void sendCommand()}
            placeholder="command id…"
            style={{
              flex:       1,
              background: '#0f172a',
              border:     '1px solid #334155',
              borderRadius: '4px',
              color:      '#f1f5f9',
              padding:    '6px 10px',
              fontSize:   '13px',
              outline:    'none',
            }}
          />
          <button
            onClick={() => void sendCommand()}
            disabled={busy}
            style={{
              background:   busy ? '#334155' : '#3b82f6',
              color:        '#fff',
              border:       'none',
              borderRadius: '4px',
              padding:      '6px 14px',
              cursor:       busy ? 'not-allowed' : 'pointer',
              fontSize:     '13px',
            }}
          >
            {busy ? '…' : 'Send'}
          </button>
        </div>
      )}

      {result && (
        <div style={{
          fontSize:   '12px',
          color:      result.startsWith('✓') ? '#86efac' : '#fca5a5',
          fontFamily: 'monospace',
          marginBottom: '8px',
        }}>
          {result}
        </div>
      )}

      {/* Recent events */}
      {events.length > 0 && (
        <div style={{
          background:   '#0f172a',
          borderRadius: '4px',
          padding:      '8px',
          maxHeight:    '100px',
          overflowY:    'auto',
        }}>
          {events.slice(-5).reverse().map((ev, i) => (
            <div key={i} style={{ fontSize: '11px', color: '#94a3b8', fontFamily: 'monospace' }}>
              [{new Date(Number(ev.timestamp) / 1_000_000).toLocaleTimeString()}] {ev.messageType}
              {ev.data ? ` · ${JSON.stringify(ev.data).slice(0, 60)}` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Metrics panel ─────────────────────────────────────────────────────────────

function MetricsPanel() {
  const snap = useMetricsStore(s => s.latest());
  if (!snap) return (
    <div style={{ color: '#64748b', fontSize: '13px', textAlign: 'center', padding: '20px' }}>
      Waiting for metrics…
    </div>
  );
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
      {([
        ['Devices',    snap.activeDevices],
        ['WS Clients', snap.wsClientCount],
        ['Pending',    snap.pendingCommands],
        ['Memory',     snap.memoryMb.toFixed(1) + ' MB'],
        ['In',         snap.bytesInPerSec.toFixed(0)  + ' B/s'],
        ['Out',        snap.bytesOutPerSec.toFixed(0) + ' B/s'],
      ] as [string, string | number][]).map(([label, value]) => (
        <div key={label as string} style={{
          background: '#1e293b', borderRadius: '6px',
          padding: '10px 14px', border: '1px solid #334155',
        }}>
          <div style={{ color: '#64748b', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {label}
          </div>
          <div style={{ color: '#f1f5f9', fontSize: '20px', fontWeight: 600, marginTop: '4px' }}>
            {value}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Notification list ─────────────────────────────────────────────────────────

function NotificationList() {
  const notifications = useNotificationStore(s => s.notifications);
  const dismiss       = useNotificationStore(s => s.dismiss);

  if (notifications.length === 0) return (
    <div style={{ color: '#64748b', fontSize: '13px', textAlign: 'center', padding: '20px' }}>
      No notifications
    </div>
  );

  return (
    <div>
      {notifications.slice(0, 10).map(n => (
        <div key={n.id} style={{
          display:      'flex',
          alignItems:   'flex-start',
          gap:          '10px',
          padding:      '10px',
          marginBottom: '6px',
          background:   '#1e293b',
          borderRadius: '6px',
          border:       `1px solid ${n.severity === 'error' ? '#7f1d1d' : n.severity === 'warning' ? '#78350f' : '#1e3a5f'}`,
        }}>
          <span style={{
            color: n.severity === 'error' ? '#f87171' : n.severity === 'warning' ? '#fbbf24' : '#60a5fa',
            fontSize: '13px', flexShrink: 0,
          }}>
            {n.severity === 'error' ? '✕' : n.severity === 'warning' ? '⚠' : 'ℹ'}
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ color: '#e2e8f0', fontSize: '13px' }}>{n.message}</div>
            <div style={{ color: '#64748b', fontSize: '11px', marginTop: '2px' }}>
              {new Date(n.timestamp).toLocaleTimeString()}
            </div>
          </div>
          <button
            onClick={() => dismiss(n.id)}
            style={{
              background: 'none', border: 'none',
              color: '#475569', cursor: 'pointer', fontSize: '14px',
            }}
          >×</button>
        </div>
      ))}
    </div>
  );
}

// ── Layout ────────────────────────────────────────────────────────────────────

type Tab = 'devices' | 'metrics' | 'notifications';

export default function App() {
  const wsStatus   = useDeviceStore(s => s.wsStatus);
  const devices    = useDeviceStore(useShallow(s => s.getConnectedDevices()));
  const allDevices = useDeviceStore(useShallow(s => [...s.devices.values()]));
  const unread     = useNotificationStore(s => s.unreadCount);
  const [tab, setTab] = useState<Tab>('devices');

  const refreshDevices = useCallback(async () => {
    try {
      const res  = await fetch('/api/v1/devices');
      const json = await res.json() as { data: import('@devbridge/shared').DeviceInfo[] };
      for (const d of json.data) useDeviceStore.getState().upsertDevice(d);
    } catch { /* ignore */ }
  }, []);

  const tabs: { key: Tab; label: string; badge?: number }[] = [
    { key: 'devices',       label: 'Devices',      badge: allDevices.length > 0 ? allDevices.length : undefined },
    { key: 'metrics',       label: 'Metrics' },
    { key: 'notifications', label: 'Alerts',       badge: unread > 0 ? unread : undefined },
  ];

  return (
    <div style={{
      minHeight:   '100vh',
      background:  '#0f172a',
      color:       '#f1f5f9',
      fontFamily:  `-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`,
    }}>
      {/* Header */}
      <header style={{
        display:       'flex',
        alignItems:    'center',
        padding:       '0 24px',
        height:        '56px',
        background:    '#1e293b',
        borderBottom:  '1px solid #334155',
        gap:           '16px',
      }}>
        <span style={{ fontWeight: 700, fontSize: '18px', color: '#38bdf8' }}>
          DevBridge
        </span>
        <span style={{
          fontSize:     '11px',
          color:        '#475569',
          background:   '#0f172a',
          padding:      '2px 8px',
          borderRadius: '999px',
          border:       '1px solid #334155',
        }}>
          v0.1.0-beta.1
        </span>
        <div style={{ marginLeft: 'auto' }}>
          <WsStatusBadge status={wsStatus} />
        </div>
      </header>

      <div style={{ display: 'flex', height: 'calc(100vh - 56px)' }}>
        {/* Sidebar */}
        <nav style={{
          width:        '200px',
          flexShrink:   0,
          background:   '#1e293b',
          borderRight:  '1px solid #334155',
          padding:      '16px 0',
        }}>
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                display:      'flex',
                alignItems:   'center',
                width:        '100%',
                padding:      '10px 20px',
                background:   tab === t.key ? '#0f172a' : 'none',
                border:       'none',
                borderLeft:   tab === t.key ? '3px solid #38bdf8' : '3px solid transparent',
                color:        tab === t.key ? '#f1f5f9' : '#94a3b8',
                cursor:       'pointer',
                fontSize:     '14px',
                textAlign:    'left',
                gap:          '8px',
              }}
            >
              {t.label}
              {t.badge !== undefined && t.badge > 0 && (
                <span style={{
                  marginLeft:   'auto',
                  background:   t.key === 'notifications' ? '#ef4444' : '#334155',
                  color:        '#fff',
                  fontSize:     '11px',
                  borderRadius: '999px',
                  padding:      '1px 7px',
                  minWidth:     '20px',
                  textAlign:    'center',
                }}>
                  {t.badge}
                </span>
              )}
            </button>
          ))}

          {/* Connected device summary */}
          <div style={{
            margin:     '16px 12px 0',
            padding:    '10px',
            background: '#0f172a',
            borderRadius: '6px',
            fontSize:   '12px',
            color:      '#64748b',
          }}>
            <div>{devices.length} connected</div>
            <div>{allDevices.length - devices.length} offline</div>
          </div>
        </nav>

        {/* Main content */}
        <main style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
          {tab === 'devices' && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: '16px', gap: '8px' }}>
                <h2 style={{ color: '#cbd5e1', fontSize: '16px', fontWeight: 600, margin: 0 }}>
                  Devices
                </h2>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
                  <button
                    onClick={() => void refreshDevices()}
                    title="Refresh device list"
                    style={{
                      background: '#1e293b', color: '#94a3b8', border: '1px solid #334155',
                      borderRadius: '4px', padding: '4px 10px', cursor: 'pointer', fontSize: '12px',
                    }}
                  >
                    ↻ Refresh
                  </button>
                </span>
              </div>
              {allDevices.length === 0 ? (
                <div style={{
                  textAlign:    'center',
                  color:        '#475569',
                  padding:      '60px 0',
                  border:       '1px dashed #334155',
                  borderRadius: '8px',
                }}>
                  <div style={{ fontSize: '32px', marginBottom: '12px' }}>⚡</div>
                  <div style={{ fontSize: '15px' }}>No devices detected</div>
                  <div style={{ fontSize: '13px', marginTop: '6px' }}>
                    Connect a device via USB, Serial, or BLE
                  </div>
                </div>
              ) : (
                allDevices.map(d => (
                  <DeviceCard key={d.deviceId} deviceId={d.deviceId} />
                ))
              )}
            </div>
          )}

          {tab === 'metrics' && (
            <div>
              <h2 style={{ color: '#cbd5e1', fontSize: '16px', fontWeight: 600, marginTop: 0, marginBottom: '16px' }}>
                System Metrics
              </h2>
              <MetricsPanel />
            </div>
          )}

          {tab === 'notifications' && (
            <div>
              <h2 style={{ color: '#cbd5e1', fontSize: '16px', fontWeight: 600, marginTop: 0, marginBottom: '16px' }}>
                Notifications
              </h2>
              <NotificationList />
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
