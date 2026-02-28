// packages/server/src/transport/__tests__/transport-factory.test.ts

import { describe, it, expect, beforeEach } from 'vitest';
import { TransportFactory } from '../transport-factory.js';
import { MockTransport }    from '../mock/mock-transport.js';
import type { ITransport }  from '@devbridge/shared';

describe('TransportFactory', () => {
  beforeEach(() => {
    // Reset registry between tests via internal map (white-box)
    (TransportFactory as unknown as { registry: Map<string, unknown> }).registry.clear();
  });

  it('create() throws TRANSPORT_NOT_SUPPORTED for unregistered type', () => {
    expect(() => TransportFactory.create('usb-hid'))
      .toThrowError(/TRANSPORT_NOT_SUPPORTED/);
  });

  it('create() throws with errorCode property', () => {
    try {
      TransportFactory.create('serial');
    } catch (err) {
      expect((err as { errorCode?: string }).errorCode).toBe('TRANSPORT_NOT_SUPPORTED');
    }
  });

  it('register() + create() returns new instance', () => {
    TransportFactory.register('usb-hid', MockTransport as unknown as new () => ITransport);
    const t = TransportFactory.create('usb-hid');
    expect(t).toBeInstanceOf(MockTransport);
  });

  it('create() returns independent instances on each call', () => {
    TransportFactory.register('tcp', MockTransport as unknown as new () => ITransport);
    const a = TransportFactory.create('tcp');
    const b = TransportFactory.create('tcp');
    expect(a).not.toBe(b);
  });

  it('isRegistered() returns correct boolean', () => {
    expect(TransportFactory.isRegistered('ble')).toBe(false);
    TransportFactory.register('ble', MockTransport as unknown as new () => ITransport);
    expect(TransportFactory.isRegistered('ble')).toBe(true);
  });

  it('registeredTypes() lists all registered types', () => {
    TransportFactory.register('usb-hid',    MockTransport as unknown as new () => ITransport);
    TransportFactory.register('usb-native', MockTransport as unknown as new () => ITransport);
    const types = TransportFactory.registeredTypes();
    expect(types).toContain('usb-hid');
    expect(types).toContain('usb-native');
    expect(types).toHaveLength(2);
  });
});
