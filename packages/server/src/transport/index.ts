// packages/server/src/transport/index.ts

export { BaseTransport }        from './base-transport.js';
export { TransportFactory }     from './transport-factory.js';
export { MockTransport }        from './mock/mock-transport.js';
export { UsbHidTransport }      from './usb-hid/usb-hid-transport.js';
export { SerialTransport }      from './serial/serial-transport.js';
export { BleTransport }         from './ble/ble-transport.js';
export { TcpTransport }         from './network/tcp-transport.js';
export { UsbNativeTransport }   from './usb-native/usb-native-transport.js';
export { FfiTransport }         from './ffi/ffi-transport.js';
export { UsbHidScanner }        from './usb-hid/usb-hid-scanner.js';
export { SerialScanner }        from './serial/serial-scanner.js';
export { BleScanner }           from './ble/ble-scanner.js';
export { UsbNativeScanner }     from './usb-native/usb-native-scanner.js';

import { TransportFactory }     from './transport-factory.js';
import { UsbHidTransport }      from './usb-hid/usb-hid-transport.js';
import { SerialTransport }      from './serial/serial-transport.js';
import { BleTransport }         from './ble/ble-transport.js';
import { TcpTransport }         from './network/tcp-transport.js';
import { UsbNativeTransport }   from './usb-native/usb-native-transport.js';
import { FfiTransport }         from './ffi/ffi-transport.js';

// Register all transports — called once at server startup
export function registerTransports(): void {
  TransportFactory.register('usb-hid',    UsbHidTransport    as unknown as new () => import('@devbridge/shared').ITransport);
  TransportFactory.register('serial',     SerialTransport    as unknown as new () => import('@devbridge/shared').ITransport);
  TransportFactory.register('ble',        BleTransport       as unknown as new () => import('@devbridge/shared').ITransport);
  TransportFactory.register('tcp',        TcpTransport       as unknown as new () => import('@devbridge/shared').ITransport);
  TransportFactory.register('usb-native', UsbNativeTransport as unknown as new () => import('@devbridge/shared').ITransport);
  // FFI: only registered inside Child Process (PluginLoader fork context)
  TransportFactory.register('ffi',        FfiTransport       as unknown as new () => import('@devbridge/shared').ITransport);
}
