// packages/server/src/protocol/checksum.ts
// Checksum algorithm implementations

import type { ChecksumAlgorithm, ChecksumConfig } from '@devbridge/shared';

// ── CRC tables ────────────────────────────────────────────────────

function makeCrc16Table(poly: number): Uint16Array {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 1) ? ((crc >>> 1) ^ poly) : (crc >>> 1);
    }
    table[i] = crc;
  }
  return table;
}

const CRC16_MODBUS_TABLE = makeCrc16Table(0xA001);   // reflected 0x8005
const CRC16_CCITT_TABLE  = makeCrc16Table(0x8408);   // reflected 0x1021

function crc32Table(): Uint32Array {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    t[i] = c >>> 0;
  }
  return t;
}
const CRC32_TABLE = crc32Table();

// ── Compute ──────────────────────────────────────────────────────

export function computeChecksum(
  buf:       Buffer,
  algorithm: ChecksumAlgorithm,
  start = 0,
  end   = buf.length,
): number {
  const slice = buf.subarray(start, end);
  switch (algorithm) {
    case 'xor': {
      let v = 0;
      for (const b of slice) v ^= b;
      return v;
    }
    case 'sum8': {
      let s = 0;
      for (const b of slice) s = (s + b) & 0xff;
      return s;
    }
    case 'lrc': {
      let s = 0;
      for (const b of slice) s = (s + b) & 0xff;
      return ((~s + 1) & 0xff);
    }
    case 'crc16-modbus': {
      let crc = 0xFFFF;
      for (const b of slice) crc = ((crc >>> 8) ^ (CRC16_MODBUS_TABLE[(crc ^ b) & 0xff]!)) >>> 0;
      return crc;
    }
    case 'crc16-ccitt': {
      // CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, non-reflected
      let crc = 0xFFFF;
      for (const b of slice) {
        crc ^= b << 8;
        for (let i = 0; i < 8; i++) {
          crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
        }
      }
      return crc;
    }
    case 'crc32': {
      let crc = 0xFFFFFFFF;
      for (const b of slice) crc = ((crc >>> 8) ^ (CRC32_TABLE[(crc ^ b) & 0xff]!)) >>> 0;
      return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    case 'none':
      return 0;
    default:
      throw new Error(`Unknown checksum algorithm: ${String(algorithm)}`);
  }
}

/** Byte width of the checksum value for a given algorithm */
export function checksumSize(algorithm: ChecksumAlgorithm): number {
  switch (algorithm) {
    case 'crc32':        return 4;
    case 'crc16-modbus': return 2;
    case 'crc16-ccitt':  return 2;
    case 'xor':
    case 'sum8':
    case 'lrc':          return 1;
    case 'none':         return 0;
  }
}

export class ChecksumAppender {
  static append(buf: Buffer, cfg?: ChecksumConfig): Buffer {
    if (!cfg || cfg.algorithm === 'none') return buf;
    const start = cfg.startOffset ?? 0;
    const end   = cfg.endOffset   ?? buf.length;
    const value = computeChecksum(buf, cfg.algorithm, start, end);
    const size  = checksumSize(cfg.algorithm);
    const out   = Buffer.alloc(buf.length + size);
    buf.copy(out);
    if (size === 1) out.writeUInt8(value, buf.length);
    else if (size === 2) out.writeUInt16LE(value, buf.length);
    else if (size === 4) out.writeUInt32LE(value, buf.length);
    return out;
  }

  static verify(buf: Buffer, cfg?: ChecksumConfig): boolean {
    if (!cfg || cfg.algorithm === 'none') return true;
    const size   = checksumSize(cfg.algorithm);
    if (buf.length < size) return false;
    const start  = cfg.startOffset ?? 0;
    const end    = buf.length - size;
    const stored = size === 1
      ? buf.readUInt8(end)
      : size === 2
        ? buf.readUInt16LE(end)
        : buf.readUInt32LE(end);
    const computed = computeChecksum(buf, cfg.algorithm, start, end);
    return stored === computed;
  }

  static strip(buf: Buffer, cfg?: ChecksumConfig): Buffer {
    if (!cfg || cfg.algorithm === 'none') return buf;
    const size = checksumSize(cfg.algorithm);
    return buf.subarray(0, buf.length - size);
  }
}
