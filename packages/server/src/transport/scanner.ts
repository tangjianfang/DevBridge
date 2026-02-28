// packages/server/src/transport/scanner.ts

import { EventEmitter } from 'events';
import type { TransportType, IDeviceScanner } from '@devbridge/shared';
import type { RawDeviceInfo } from '@devbridge/shared';

export abstract class BaseScanner extends EventEmitter implements IDeviceScanner {
  abstract readonly transportType: TransportType;
  abstract scan(): Promise<RawDeviceInfo[]>;
  abstract startWatching(): void;
  abstract stopWatching():  void;
}
