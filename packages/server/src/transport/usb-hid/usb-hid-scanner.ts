// packages/server/src/transport/usb-hid/usb-hid-scanner.ts

import type { RawDeviceInfo } from '@devbridge/shared';
import { BaseScanner } from '../scanner.js';

type HIDLib = typeof import('node-hid');
type UsbLib = typeof import('usb');

let HID: HIDLib | null = null;
let usb: UsbLib | null = null;
try { HID = require('node-hid') as HIDLib; } catch { /* optional */ }
try { usb = require('usb') as UsbLib; } catch { /* optional */ }

export class UsbHidScanner extends BaseScanner {
  readonly transportType = 'usb-hid' as const;
  private _watching = false;

  async scan(): Promise<RawDeviceInfo[]> {
    if (!HID) return [];
    return HID.devices().map((d) => ({
      transportType: 'usb-hid' as const,
      address:       `usb-hid:${d.vendorId}:${d.productId}:${d.serialNumber ?? ''}`,
      name:          d.product ?? undefined,
      vendorId:      d.vendorId,
      productId:     d.productId,
      serialNumber:  d.serialNumber ?? undefined,
      raw:           d,
    }));
  }

  startWatching(): void {
    if (this._watching || !usb) return;
    this._watching = true;

    let knownAddresses = new Set<string>();

    // Emit 'attached' for devices already connected at startup
    this.scan().then((devs) => {
      for (const d of devs) {
        knownAddresses.add(d.address);
        this.emit('attached', d);
      }
    });

    usb!.usb.on('attach', async () => {
      const current = await this.scan();
      for (const d of current) {
        if (!knownAddresses.has(d.address)) {
          knownAddresses.add(d.address);
          this.emit('attached', d);
        }
      }
    });

    usb!.usb.on('detach', async () => {
      const current = await this.scan();
      const currentAddresses = new Set(current.map((d) => d.address));
      for (const addr of knownAddresses) {
        if (!currentAddresses.has(addr)) {
          knownAddresses.delete(addr);
          this.emit('detached', addr);
        }
      }
    });
  }

  stopWatching(): void {
    this._watching = false;
    usb?.usb.removeAllListeners('attach');
    usb?.usb.removeAllListeners('detach');
  }
}
