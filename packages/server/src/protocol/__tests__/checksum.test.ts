// packages/server/src/protocol/__tests__/checksum.test.ts
import { describe, it, expect } from 'vitest';
import { computeChecksum, checksumSize, ChecksumAppender } from '../checksum.js';

describe('computeChecksum', () => {
  it('xor: XOR of all bytes', () => {
    const buf = Buffer.from([0x01, 0x02, 0x03]);
    expect(computeChecksum(buf, 'xor')).toBe(0x01 ^ 0x02 ^ 0x03);
  });

  it('sum8: sum modulo 256', () => {
    const buf = Buffer.from([0x80, 0x80, 0x01]);
    expect(computeChecksum(buf, 'sum8')).toBe((0x80 + 0x80 + 0x01) & 0xff);
  });

  it('lrc: two-complement sum', () => {
    // Modbus ASCII LRC: (~sum + 1) & 0xFF
    const buf = Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x0A]);
    const sum = buf.reduce((a, b) => a + b, 0) & 0xff;
    expect(computeChecksum(buf, 'lrc')).toBe(((~sum) + 1) & 0xff);
  });

  it('none: always 0', () => {
    expect(computeChecksum(Buffer.from([0xff, 0xfe]), 'none')).toBe(0);
  });

  it('crc16-modbus: known vector', () => {
    // "123456789" → 0x4B37 (Modbus CRC16)
    const buf = Buffer.from('123456789', 'ascii');
    expect(computeChecksum(buf, 'crc16-modbus')).toBe(0x4b37);
  });

  it('crc16-ccitt: known vector', () => {
    // initial 0xFFFF, "123456789" → 0x29B1
    const buf = Buffer.from('123456789', 'ascii');
    expect(computeChecksum(buf, 'crc16-ccitt')).toBe(0x29b1);
  });

  it('crc32: known vector', () => {
    // "123456789" → 0xCBF43926
    const buf = Buffer.from('123456789', 'ascii');
    expect(computeChecksum(buf, 'crc32')).toBe(0xcbf43926);
  });

  it('start/end range respected', () => {
    const buf = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    const full = computeChecksum(buf, 'xor');
    const part = computeChecksum(buf, 'xor', 1, 3); // [0x01, 0x02]
    expect(full).not.toBe(part);
    expect(part).toBe(0x01 ^ 0x02);
  });
});

describe('checksumSize', () => {
  it('returns correct byte widths', () => {
    expect(checksumSize('none')).toBe(0);
    expect(checksumSize('xor')).toBe(1);
    expect(checksumSize('sum8')).toBe(1);
    expect(checksumSize('lrc')).toBe(1);
    expect(checksumSize('crc16-modbus')).toBe(2);
    expect(checksumSize('crc16-ccitt')).toBe(2);
    expect(checksumSize('crc32')).toBe(4);
  });
});

describe('ChecksumAppender (static methods)', () => {
  const cfg = { algorithm: 'xor' as const };

  it('append: adds checksum bytes', () => {
    const buf = Buffer.from([0x01, 0x02, 0x03]);
    const out = ChecksumAppender.append(buf, cfg);
    expect(out.length).toBe(4);
    expect(out[3]).toBe(0x01 ^ 0x02 ^ 0x03);
  });

  it('verify: returns true for valid checksum', () => {
    const buf = Buffer.from([0x01, 0x02, 0x03]);
    const out = ChecksumAppender.append(buf, cfg);
    expect(ChecksumAppender.verify(out, cfg)).toBe(true);
  });

  it('verify: returns false for corrupted data', () => {
    const buf = Buffer.from([0x01, 0x02, 0x03]);
    const out = ChecksumAppender.append(buf, cfg);
    out[0] ^= 0xff; // flip a byte
    expect(ChecksumAppender.verify(out, cfg)).toBe(false);
  });

  it('strip: removes checksum bytes', () => {
    const buf = Buffer.from([0x01, 0x02, 0x03]);
    const out      = ChecksumAppender.append(buf, cfg);
    const stripped = ChecksumAppender.strip(out, cfg);
    expect(Buffer.from(stripped)).toEqual(buf);
  });

  it('append with none: returns same buffer', () => {
    const buf = Buffer.from([0xaa, 0xbb]);
    const out = ChecksumAppender.append(buf, { algorithm: 'none' as const });
    expect(out).toEqual(buf);
  });

  it('crc32 round-trip', () => {
    const c32 = { algorithm: 'crc32' as const };
    const buf = Buffer.from('hello world', 'ascii');
    const out = ChecksumAppender.append(buf, c32);
    expect(ChecksumAppender.verify(out, c32)).toBe(true);
    expect(Buffer.from(ChecksumAppender.strip(out, c32))).toEqual(buf);
  });
});
