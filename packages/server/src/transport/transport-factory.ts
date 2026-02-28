// packages/server/src/transport/transport-factory.ts

import type { TransportType, ITransport } from '@devbridge/shared';

type TransportCtor = new () => ITransport;

export class TransportFactory {
  private static registry = new Map<TransportType, TransportCtor>();

  static register(type: TransportType, ctor: TransportCtor): void {
    this.registry.set(type, ctor);
  }

  static create(type: TransportType): ITransport {
    const Ctor = this.registry.get(type);
    if (!Ctor) {
      throw Object.assign(
        new Error(`TRANSPORT_NOT_SUPPORTED: ${type}`),
        { errorCode: 'TRANSPORT_NOT_SUPPORTED', transportType: type },
      );
    }
    return new Ctor();
  }

  static isRegistered(type: TransportType): boolean {
    return this.registry.has(type);
  }

  static registeredTypes(): TransportType[] {
    return [...this.registry.keys()];
  }
}
