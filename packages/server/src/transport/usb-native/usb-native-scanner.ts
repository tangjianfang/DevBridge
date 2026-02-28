// packages/server/src/transport/usb-native/usb-native-scanner.ts

import type { RawDeviceInfo } from '@devbridge/shared';
import { BaseScanner } from '../scanner.js';

type UsbLib = typeof import('usb');
let usb: UsbLib | null = null;
try { usb = require('usb') as UsbLib; } catch { /* optional */ }

export class UsbNativeScanner extends BaseScanner {
  readonly transportType = 'usb-native' as const;
  private knownAddresses = new Set<string>();

  async scan(): Promise<RawDeviceInfo[]> {
    if (!usb) return [];
    return usb.getDeviceList().map((d) => {
      const desc = d.deviceDescriptor;
      const addr = `usb-native:${desc.idVendor}:${desc.idProduct}`;
      return {
        transportType: 'usb-native' as const,
        address:       addr,
        vendorId:      desc.idVendor,
        productId:     desc.idProduct,
        raw:           d,
      };
    });
  }

  startWatching(): void {
    if (!usb) return;

    // Emit 'attached' for devices already connected at startup
    this.scan().then((devs) => {
      for (const d of devs) {
        this.knownAddresses.add(d.address);
        this.emit('attached', d);
      }
    });

    usb!.usb.on('attach', (dev: import('usb').usb.Device) => {
      const desc = dev.deviceDescriptor;
      const addr = `usb-native:${desc.idVendor}:${desc.idProduct}`;
      if (!this.knownAddresses.has(addr)) {
        this.knownAddresses.add(addr);
        const raw: RawDeviceInfo = {
          transportType: 'usb-native',
          address:       addr,
          vendorId:      desc.idVendor,
          productId:     desc.idProduct,
          raw:           dev,
        };
        this.emit('attached', raw);
      }
    });

    usb!.usb.on('detach', (dev: import('usb').usb.Device) => {
      const desc = dev.deviceDescriptor;
      const addr = `usb-native:${desc.idVendor}:${desc.idProduct}`;
      this.knownAddresses.delete(addr);
      this.emit('detached', addr);
    });
  }

  stopWatching(): void {
    usb?.usb.removeAllListeners('attach');
    usb?.usb.removeAllListeners('detach');
  }
}
