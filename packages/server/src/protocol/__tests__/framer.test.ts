// packages/server/src/protocol/__tests__/framer.test.ts
import { describe, it, expect } from 'vitest';
import { Framer, FrameBuilder } from '../framer.js';
import type { FramingConfig } from '@devbridge/shared';

// ── Helpers ───────────────────────────────────────────────────────────────

function collect(cfg: FramingConfig, ...chunks: Buffer[]): Buffer[] {
  const frames: Buffer[] = [];
  const framer = new Framer(cfg, (f) => frames.push(Buffer.from(f)));
  for (const c of chunks) framer.push(c);
  return frames;
}

// ── Framer ────────────────────────────────────────────────────────────────

describe('Framer — none mode', () => {
  it('emits whole chunk as one frame', () => {
    const cfg: FramingConfig = { mode: 'none' };
    const frames = collect(cfg, Buffer.from([0x01, 0x02, 0x03]));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(Buffer.from([0x01, 0x02, 0x03]));
  });
});

describe('Framer — fixed mode', () => {
  const cfg: FramingConfig = { mode: 'fixed', fixedSize: 4 };

  it('splits exact multiple', () => {
    const frames = collect(cfg, Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04]));
    expect(frames[1]).toEqual(Buffer.from([0x05, 0x06, 0x07, 0x08]));
  });

  it('waits for full frame', () => {
    const frames = collect(cfg, Buffer.from([0x01, 0x02]));
    expect(frames).toHaveLength(0);
  });

  it('handles fragmented input', () => {
    const frames = collect(cfg, Buffer.from([0x01, 0x02]), Buffer.from([0x03, 0x04]));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04]));
  });
});

describe('Framer — delimiter mode', () => {
  const cfg: FramingConfig = { mode: 'delimiter', footer: ['0x0d', '0x0a'] };

  it('splits on delimiter', () => {
    const frames = collect(cfg, Buffer.from('HELLO\r\nWORLD\r\n'));
    expect(frames).toHaveLength(2);
    expect(frames[0]!.toString()).toBe('HELLO');
    expect(frames[1]!.toString()).toBe('WORLD');
  });

  it('handles delimiter split across chunks', () => {
    const frames = collect(cfg, Buffer.from('HELLO\r'), Buffer.from('\nWORLD\r\n'));
    expect(frames).toHaveLength(2);
  });
});

describe('Framer — length-prefix mode', () => {
  const cfg: FramingConfig = {
    mode:        'length-prefix',
    lengthField: { offset: 0, type: 'uint16be', includes: 'none' },
  };

  it('reads 2-byte length and emits frame', () => {
    const body   = Buffer.from([0xaa, 0xbb, 0xcc]);
    const header = Buffer.allocUnsafe(2);
    header.writeUInt16BE(3, 0);
    const frames = collect(cfg, Buffer.concat([header, body]));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(Buffer.concat([header, body]));
  });

  it('reassembles fragmented frame', () => {
    const body   = Buffer.from([0xaa, 0xbb, 0xcc]);
    const header = Buffer.allocUnsafe(2);
    header.writeUInt16BE(3, 0);
    const full = Buffer.concat([header, body]);
    const frames = collect(cfg, full.subarray(0, 3), full.subarray(3));
    expect(frames).toHaveLength(1);
  });
});

describe('Framer — magic-header mode', () => {
  const cfg: FramingConfig = {
    mode:        'magic-header',
    header:      ['0x55', '0xAA'],
    lengthField: { offset: 2, type: 'uint16be', includes: 'none' },
  };

  it('finds magic and emits frame', () => {
    const body   = Buffer.from([0x01, 0x02, 0x03]);
    const header = Buffer.allocUnsafe(4); // 2 magic + 2 length
    header[0] = 0x55; header[1] = 0xAA;
    header.writeUInt16BE(3, 2);
    const frames = collect(cfg, Buffer.concat([header, body]));
    expect(frames).toHaveLength(1);
  });

  it('skips garbage bytes before magic', () => {
    const body   = Buffer.from([0xFF]);
    const header = Buffer.allocUnsafe(4);
    header[0] = 0x55; header[1] = 0xAA;
    header.writeUInt16BE(1, 2);
    const frame   = Buffer.concat([header, body]);
    const garbage = Buffer.from([0x00, 0x11, 0x22]);
    const frames  = collect(cfg, Buffer.concat([garbage, frame]));
    expect(frames).toHaveLength(1);
  });
});

describe('Framer — reset', () => {
  it('clears internal buffer', () => {
    const cfg: FramingConfig = { mode: 'fixed', fixedSize: 4 };
    const frames: Buffer[] = [];
    const framer = new Framer(cfg, (f) => frames.push(f));
    framer.push(Buffer.from([0x01, 0x02])); // partial
    framer.reset();
    framer.push(Buffer.from([0x01, 0x02, 0x03, 0x04])); // full frame
    expect(frames).toHaveLength(1);
  });
});

// ── FrameBuilder ─────────────────────────────────────────────────────────

describe('FrameBuilder', () => {
  it('none: returns body unchanged', () => {
    const body = Buffer.from([0xAA]);
    expect(FrameBuilder.wrap(body, { mode: 'none' })).toEqual(body);
  });

  it('fixed: pads to fixedSize', () => {
    const body  = Buffer.from([0x01, 0x02]);
    const frame = FrameBuilder.wrap(body, { mode: 'fixed', fixedSize: 8 });
    expect(frame.length).toBe(8);
    expect(frame[0]).toBe(0x01);
    expect(frame[2]).toBe(0x00);
  });

  it('delimiter: appends footer bytes', () => {
    const body  = Buffer.from('CMD');
    const frame = FrameBuilder.wrap(body, { mode: 'delimiter', footer: ['0x0d', '0x0a'] });
    expect(frame.slice(-2)).toEqual(Buffer.from([0x0d, 0x0a]));
  });

  it('length-prefix: prepends 2-byte length', () => {
    const body  = Buffer.from([0x01, 0x02, 0x03]);
    const frame = FrameBuilder.wrap(body, {
      mode:        'length-prefix',
      lengthField: { offset: 0, type: 'uint16be', includes: 'none' },
    });
    expect(frame.length).toBe(5);
    expect(frame.readUInt16BE(0)).toBe(3);
  });

  it('round-trip: length-prefix framer', () => {
    const cfg: FramingConfig = {
      mode:        'length-prefix',
      lengthField: { offset: 0, type: 'uint16be', includes: 'none' },
    };
    const body   = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
    const frame  = FrameBuilder.wrap(body, cfg);
    const frames = collect(cfg, frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(frame);
  });
});
