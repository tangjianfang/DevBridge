// packages/server/src/transport/ble/ble-scanner.ts

import type { RawDeviceInfo } from '@devbridge/shared';
import { BaseScanner } from '../scanner.js';

type Noble = typeof import('@abandonware/noble');

let noble: Noble | null = null;
try { noble = require('@abandonware/noble') as Noble; } catch { /* optional */ }

const RSSI_TIMEOUT_MS = 10_000;

interface BleSeenEntry {
  raw:     RawDeviceInfo;
  lastSeen: number;
}

export class BleScanner extends BaseScanner {
  readonly transportType = 'ble' as const;
  private seen      = new Map<string, BleSeenEntry>();
  private rssiTimer?: ReturnType<typeof setInterval>;
  private scanning  = false;

  async scan(): Promise<RawDeviceInfo[]> {
    // BLE scan is event-driven; return currently known devices
    return [...this.seen.values()].map((e) => e.raw);
  }

  startWatching(): void {
    if (this.scanning || !noble) return;
    this.scanning = true;

    noble!.on('stateChange', (state: string) => {
      if (state === 'poweredOn') noble!.startScanning([], true);
    });

    noble!.on('discover', (p: import('@abandonware/noble').Peripheral) => {
      const addr = p.address;
      const raw: RawDeviceInfo = {
        transportType: 'ble',
        address:       addr,
        name:          p.advertisement?.localName ?? undefined,
        raw:           p,
      };
      const isNew = !this.seen.has(addr);
      this.seen.set(addr, { raw, lastSeen: Date.now() });
      if (isNew) this.emit('attached', raw);
    });

    if (noble!.state === 'poweredOn') noble!.startScanning([], true);

    // RSSI timeout — emit 'detached' if not seen for RSSI_TIMEOUT_MS
    this.rssiTimer = setInterval(() => {
      const now = Date.now();
      for (const [addr, entry] of this.seen) {
        if (now - entry.lastSeen > RSSI_TIMEOUT_MS) {
          this.seen.delete(addr);
          this.emit('detached', addr);
        }
      }
    }, 2000);
  }

  stopWatching(): void {
    noble?.stopScanning();
    if (this.rssiTimer) { clearInterval(this.rssiTimer); this.rssiTimer = undefined; }
    this.scanning = false;
  }
}
