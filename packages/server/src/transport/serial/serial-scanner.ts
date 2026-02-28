// packages/server/src/transport/serial/serial-scanner.ts

import type { RawDeviceInfo } from '@devbridge/shared';
import { BaseScanner } from '../scanner.js';

type SerialPortLib = typeof import('serialport');

let SerialPort: SerialPortLib | null = null;
try { SerialPort = require('serialport') as SerialPortLib; } catch { /* optional */ }

const POLL_INTERVAL_MS = 500;

export class SerialScanner extends BaseScanner {
  readonly transportType = 'serial' as const;
  private pollTimer?: ReturnType<typeof setInterval>;
  private knownPaths  = new Set<string>();

  async scan(): Promise<RawDeviceInfo[]> {
    if (!SerialPort) return [];
    const ports = await SerialPort.SerialPort.list();
    return ports.map((p) => ({
      transportType: 'serial' as const,
      address:       p.path,
      name:          p.manufacturer ?? undefined,
      vendorId:      p.vendorId   ? parseInt(p.vendorId, 16) : undefined,
      productId:     p.productId  ? parseInt(p.productId, 16) : undefined,
      serialNumber:  p.serialNumber ?? undefined,
      raw:           p,
    }));
  }

  startWatching(): void {
    if (this.pollTimer) return;
    // Initial scan — emit 'attached' for ports already present at startup
    this.scan().then((devs) => {
      for (const d of devs) {
        this.knownPaths.add(d.address);
        this.emit('attached', d);
      }
    });

    this.pollTimer = setInterval(async () => {
      const current = await this.scan();
      const currentPaths = new Set(current.map((d) => d.address));

      // Attached
      for (const d of current) {
        if (!this.knownPaths.has(d.address)) {
          this.knownPaths.add(d.address);
          this.emit('attached', d);
        }
      }
      // Detached
      for (const path of this.knownPaths) {
        if (!currentPaths.has(path)) {
          this.knownPaths.delete(path);
          this.emit('detached', path);
        }
      }
    }, POLL_INTERVAL_MS);
  }

  stopWatching(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = undefined; }
  }
}
