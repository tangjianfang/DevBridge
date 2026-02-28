// packages/server/src/transport/__tests__/base-transport.test.ts

import { describe, it, expect, vi } from 'vitest';
import { MockTransport } from '../mock/mock-transport.js';

describe('BaseTransport', () => {
  it('isConnected() returns false before connect()', () => {
    const t = new MockTransport();
    expect(t.isConnected()).toBe(false);
  });

  it('connect() emits "open" and sets isConnected=true', async () => {
    const t  = new MockTransport();
    const spy = vi.fn();
    t.on('open', spy);
    await t.connect({ transportType: 'usb-hid', vendorId: 0, productId: 0 });
    expect(t.isConnected()).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('disconnect() emits "close" and sets isConnected=false', async () => {
    const t  = new MockTransport();
    const spy = vi.fn();
    t.on('close', spy);
    await t.connect({ transportType: 'usb-hid', vendorId: 0, productId: 0 });
    await t.disconnect();
    expect(t.isConnected()).toBe(false);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('request() resolves when data is injected before timeout', async () => {
    const t   = new MockTransport();
    await t.connect({ transportType: 'usb-hid', vendorId: 0, productId: 0 });
    const payload = Buffer.from([0x01, 0x02]);
    const promise  = t.request(Buffer.from([0xAA]), 1000);
    t.injectData(payload);
    const result = await promise;
    expect(result).toEqual(payload);
  });

  it('request() rejects with TRANSPORT_REQUEST_TIMEOUT after timeout', async () => {
    const t = new MockTransport();
    await t.connect({ transportType: 'usb-hid', vendorId: 0, productId: 0 });
    await expect(t.request(Buffer.from([0x00]), 50))
      .rejects.toMatchObject({ errorCode: 'TRANSPORT_REQUEST_TIMEOUT' });
  });

  it('back-pressure: emitEvent() drops oldest frames when buffer exceeds 256', async () => {
    const t = new MockTransport();
    await t.connect({ transportType: 'usb-hid', vendorId: 0, productId: 0 });
    for (let i = 0; i < 300; i++) {
      t.injectEvent(Buffer.from([i & 0xff]));
    }
    expect(t._pendingEventCount).toBeLessThanOrEqual(256);
  });

  it('subscribeAll() subscribes only "in" and "bidir" endpoints', async () => {
    const endpoints = [
      { id: 'ep-in',    direction: 'in'    as const, type: 'interrupt' as const },
      { id: 'ep-out',   direction: 'out'   as const, type: 'interrupt' as const },
      { id: 'ep-bidir', direction: 'bidir' as const, type: 'stream'    as const },
    ];
    const t = new MockTransport('usb-hid', 'test:device', endpoints);
    await t.connect({ transportType: 'usb-hid', vendorId: 0, productId: 0 });
    await t.subscribeAll();
    // Only ep-in and ep-bidir should be subscribed (not ep-out)
    expect((t as unknown as { subscriptions: Set<string> }).subscriptions.has('ep-in')).toBe(true);
    expect((t as unknown as { subscriptions: Set<string> }).subscriptions.has('ep-bidir')).toBe(true);
    expect((t as unknown as { subscriptions: Set<string> }).subscriptions.has('ep-out')).toBe(false);
  });

  it('simulateDisconnect() emits "close" with reason', async () => {
    const t   = new MockTransport();
    await t.connect({ transportType: 'usb-hid', vendorId: 0, productId: 0 });
    const spy = vi.fn();
    t.on('close', spy);
    t.simulateDisconnect('hardware-fail');
    expect(spy).toHaveBeenCalledWith('hardware-fail');
    expect(t.isConnected()).toBe(false);
  });
});
