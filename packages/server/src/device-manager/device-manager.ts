// packages/server/src/device-manager/device-manager.ts
// DeviceManager — top-level coordinator for all connected device channels.

import type {
  DeviceInfo,
  DeviceStatus,
  RawDeviceInfo,
  IDeviceScanner,
  IPCMessage,
  IProtocol,
  TransportType,
} from '@devbridge/shared';

import type { IService, ServiceHealth } from '@devbridge/shared';
import { DeviceChannel, setIPCSender }  from './device-channel.js';

export type ProtocolSelector = (raw: RawDeviceInfo) => IProtocol | null;

export class DeviceManager implements IService {
  private readonly devices  = new Map<string, DeviceChannel>();
  private readonly scanners = new Map<TransportType, IDeviceScanner>();
  private protocolSelector: ProtocolSelector = () => null;
  private started = false;
  private ipcSend: (msg: IPCMessage) => void = () => {};

  // ──────────────────────────────────────────────────────────
  // Configuration
  // ──────────────────────────────────────────────────────────

  registerScanner(type: TransportType, scanner: IDeviceScanner): void {
    this.scanners.set(type, scanner);
  }

  setProtocolSelector(fn: ProtocolSelector): void {
    this.protocolSelector = fn;
  }

  /**
   * Set the IPC sender used by both this manager and all DeviceChannels.
   * Must be called before start().
   */
  configureIPC(fn: (msg: IPCMessage) => void): void {
    this.ipcSend = fn;
    setIPCSender(fn);   // propagate to all DeviceChannels
  }

  // ──────────────────────────────────────────────────────────
  // IService
  // ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    for (const [, scanner] of this.scanners) {
      scanner.on('attached', (raw: RawDeviceInfo) => this.onDeviceAttached(raw));
      scanner.on('detached', (address: string)    => this.onDeviceDetached(address));
      scanner.startWatching();
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    const closeAll = [...this.devices.values()].map((ch) => ch.close('manager-stop'));
    await Promise.allSettled(closeAll);
    for (const [, sc] of this.scanners) sc.stopWatching();
  }

  async health(): Promise<ServiceHealth> {
    return {
      status:  'ok',
      details: { connectedDevices: this.countByStatus('connected') },
    };
  }

  // ──────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────

  listDevices(): DeviceInfo[] {
    return [...this.devices.values()].map((ch) => ch.info);
  }

  getDevice(id: string): DeviceChannel {
    const ch = this.devices.get(id);
    if (!ch) {
      throw Object.assign(
        new Error(`DEVICE_NOT_FOUND: ${id}`),
        { errorCode: 'DEVICE_NOT_FOUND' },
      );
    }
    return ch;
  }

  hasDevice(id: string): boolean {
    return this.devices.has(id);
  }

  // ──────────────────────────────────────────────────────────
  // IPC message handling
  // ──────────────────────────────────────────────────────────

  handleIPCMessage(msg: IPCMessage): void {
    switch (msg.type) {
      case 'COMMAND_SEND':       this.routeCommand(msg);    break;
      case 'SUBSCRIBE_EVENTS':   this.subscribeEvents(msg); break;
      case 'PLUGIN_LOADED':      this.assignPlugin(msg);    break;
      case 'PLUGIN_HOT_UPDATED': this.reassignPlugin(msg);  break;
    }
  }

  private routeCommand(msg: IPCMessage): void {
    const { deviceId, commandId, params, correlationId } = msg.payload as {
      deviceId:      string;
      commandId:     string;
      params:        Record<string, unknown>;
      correlationId: string;
    };

    const ch = this.devices.get(deviceId);
    if (!ch || ch.info.status !== 'connected') {
      const errorCode = ch ? 'DEVICE_NOT_CONNECTED' : 'DEVICE_NOT_FOUND';
      this.replyError(deviceId, correlationId, errorCode);
      return;
    }

    if (!ch.protocol) {
      this.replyError(deviceId, correlationId, 'DEVICE_PROTOCOL_MISSING');
      return;
    }

    try {
      const encoded = ch.protocol.encode(commandId, params);
      // Enqueue BEFORE transport.send() — FIFO correlation integrity
      ch.enqueueCorrelation(correlationId);
      void ch.transport.send(encoded);
    } catch (err) {
      this.replyError(deviceId, correlationId, 'DEVICE_COMMAND_FAILED', String(err));
    }
  }

  private subscribeEvents(msg: IPCMessage): void {
    const { deviceId, endpointIds } = msg.payload as {
      deviceId:    string;
      endpointIds?: string[];
    };
    const ch = this.devices.get(deviceId);
    if (!ch) return;
    if (endpointIds?.length) {
      for (const ep of endpointIds) void ch.transport.subscribe(ep);
    } else {
      void ch.transport.subscribeAll();
    }
  }

  private assignPlugin(msg: IPCMessage): void {
    const { deviceId, plugin } = msg.payload as { deviceId: string; plugin: unknown };
    const ch = this.devices.get(deviceId);
    if (ch) ch.plugin = plugin as DeviceChannel['plugin'];
  }

  private reassignPlugin(msg: IPCMessage): void {
    this.assignPlugin(msg);
  }

  // ──────────────────────────────────────────────────────────
  // Scanner event handlers
  // ──────────────────────────────────────────────────────────

  private onDeviceAttached(raw: RawDeviceInfo): void {
    let ch: DeviceChannel;
    try {
      ch = DeviceChannel.create(raw, this.protocolSelector(raw));
    } catch (err) {
      // Transport type not registered (e.g. unsupported HW) — skip silently
      console.warn(`[DeviceManager] skipping device ${raw.address}: ${(err as Error).message}`);
      return;
    }
    const id = ch.info.deviceId;
    if (this.devices.has(id)) return; // de-duplicate (hot-plug duplicate guard)
    this.devices.set(id, ch);
  }

  private onDeviceDetached(address: string): void {
    for (const [, ch] of this.devices) {
      if (ch.info.address === address) {
        ch.updateStatus('detached');
        break;
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────

  private countByStatus(s: DeviceStatus): number {
    return [...this.devices.values()].filter((ch) => ch.info.status === s).length;
  }

  private replyError(
    deviceId:      string,
    correlationId: string,
    code:          string,
    message?:      string,
  ): void {
    this.ipcSend({
      type:    'DATA_RECEIVED',
      payload: { deviceId, correlationId, error: { code, message } },
    } as IPCMessage);
  }
}
