// packages/server/src/protocol/framer.ts
// Frame splitter — splits a raw byte stream into discrete message frames.
// Uses the FramingConfig type defined in @devbridge/shared.

import type { FramingConfig } from '@devbridge/shared';

export type FrameCallback = (frame: Buffer) => void;

/** Parse hex-string array e.g. ["0xAA","0x55"] → Buffer */
function parseMagicBytes(header?: string[]): Buffer {
  if (!header?.length) return Buffer.alloc(0);
  return Buffer.from(header.map((s) => parseInt(s, 16)));
}

/** Parse footer/delimiter bytes array → Buffer (default: LF) */
function parseDelimiterBytes(footer?: string[]): Buffer {
  if (!footer?.length) return Buffer.from([0x0a]);
  return Buffer.from(footer.map((s) => parseInt(s, 16)));
}

/** Read the length value from a buffer according to the lengthField config. */
function readLengthField(buf: Buffer, offset: number, type: string): number {
  switch (type) {
    case 'uint8':    return buf.readUInt8(offset);
    case 'uint16le': return buf.readUInt16LE(offset);
    case 'uint16be': return buf.readUInt16BE(offset);
    case 'uint32le': return buf.readUInt32LE(offset);
    case 'uint32be': return buf.readUInt32BE(offset);
    default:         return buf.readUInt16BE(offset);
  }
}

/** Write the length value to a buffer according to the lengthField config. */
function writeLengthField(buf: Buffer, offset: number, type: string, value: number): void {
  switch (type) {
    case 'uint8':    buf.writeUInt8(value, offset);    break;
    case 'uint16le': buf.writeUInt16LE(value, offset); break;
    case 'uint16be': buf.writeUInt16BE(value, offset); break;
    case 'uint32le': buf.writeUInt32LE(value, offset); break;
    case 'uint32be': buf.writeUInt32BE(value, offset); break;
    default:         buf.writeUInt16BE(value, offset);
  }
}

function lengthFieldSize(type: string): number {
  switch (type) {
    case 'uint8':                    return 1;
    case 'uint16le': case 'uint16be': return 2;
    case 'uint32le': case 'uint32be': return 4;
    default:                         return 2;
  }
}

export class Framer {
  private buf: Buffer = Buffer.alloc(0);

  constructor(
    private readonly cfg: FramingConfig,
    private readonly onFrame: FrameCallback,
  ) {}

  /** Feed incoming bytes into the framer. */
  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    this.drain();
  }

  /** Process the internal buffer and emit complete frames. */
  private drain(): void {
    const { mode, maxFrameSize = 65535 } = this.cfg;

    while (this.buf.length > 0) {
      const before = this.buf.length;

      switch (mode) {
        case 'magic-header':
          if (!this.drainMagicHeader(maxFrameSize)) return;
          break;
        case 'length-prefix':
          if (!this.drainLengthPrefix(maxFrameSize)) return;
          break;
        case 'delimiter':
          if (!this.drainDelimiter()) return;
          break;
        case 'fixed':
          if (!this.drainFixed()) return;
          break;
        case 'none':
        default:
          this.emitAndClear(this.buf);
          return;
      }

      // Safeguard: if buffer size didn't shrink, break to avoid infinite loop
      if (this.buf.length >= before) return;
    }
  }

  private drainMagicHeader(maxFrameSize: number): boolean {
    const magicBuf = parseMagicBytes(this.cfg.header);
    const lf       = this.cfg.lengthField;
    const ltype    = lf?.type   ?? 'uint16be';
    const loffset  = lf?.offset ?? magicBuf.length;
    const lsize    = lengthFieldSize(ltype);
    const hdrLen   = loffset + lsize;

    // Find magic bytes
    const magicIdx = this.indexOf(this.buf, magicBuf);
    if (magicIdx === -1) {
      if (magicBuf.length > 0 && this.buf.length > magicBuf.length) {
        this.buf = this.buf.subarray(this.buf.length - magicBuf.length + 1);
      }
      return false;
    }
    if (magicIdx > 0) this.buf = this.buf.subarray(magicIdx);
    if (this.buf.length < hdrLen) return false;

    const bodyLen  = readLengthField(this.buf, loffset, ltype);
    const includes = lf?.includes ?? 'none';
    const totalLen = includes === 'all' ? bodyLen : hdrLen + bodyLen;

    if (totalLen > maxFrameSize) { this.buf = this.buf.subarray(1); return true; }
    if (this.buf.length < totalLen) return false;

    this.emitAndConsume(totalLen);
    return true;
  }

  private drainLengthPrefix(maxFrameSize: number): boolean {
    const lf      = this.cfg.lengthField;
    const ltype   = lf?.type   ?? 'uint16be';
    const loffset = lf?.offset ?? 0;
    const lsize   = lengthFieldSize(ltype);
    const hdrLen  = loffset + lsize;

    if (this.buf.length < hdrLen) return false;

    const bodyLen  = readLengthField(this.buf, loffset, ltype);
    const includes = lf?.includes ?? 'none';
    const totalLen = includes === 'all' ? bodyLen : hdrLen + bodyLen;

    if (totalLen > maxFrameSize || totalLen === 0) { this.buf = this.buf.subarray(1); return true; }
    if (this.buf.length < totalLen) return false;

    this.emitAndConsume(totalLen);
    return true;
  }

  private drainDelimiter(): boolean {
    const delim = parseDelimiterBytes(this.cfg.footer);
    const idx   = this.indexOf(this.buf, delim);
    if (idx === -1) return false;

    const frame = this.buf.subarray(0, idx);
    this.buf    = this.buf.subarray(idx + delim.length);
    this.onFrame(Buffer.from(frame));
    return true;
  }

  private drainFixed(): boolean {
    const sz = this.cfg.fixedSize ?? 64;
    if (this.buf.length < sz) return false;
    this.emitAndConsume(sz);
    return true;
  }

  private emitAndConsume(size: number): void {
    this.onFrame(Buffer.from(this.buf.subarray(0, size)));
    this.buf = this.buf.subarray(size);
  }

  private emitAndClear(b: Buffer): void {
    this.onFrame(Buffer.from(b));
    this.buf = Buffer.alloc(0);
  }

  /** Naive indexOf for Buffer subsequence. */
  private indexOf(haystack: Buffer, needle: Buffer): number {
    if (needle.length === 0) return 0;
    outer:
    for (let i = 0; i <= haystack.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (haystack[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  /** Reset internal buffer (e.g. on transport reconnect). */
  reset(): void {
    this.buf = Buffer.alloc(0);
  }
}

// ── FrameBuilder: one-shot framing ───────────────────────────────────────

export class FrameBuilder {
  /** Strip framing header from a received frame, returning the payload. */
  static unwrap(frame: Buffer, cfg: FramingConfig): Buffer {
    switch (cfg.mode) {
      case 'magic-header':
      case 'length-prefix': {
        const magicBuf = cfg.mode === 'magic-header' ? parseMagicBytes(cfg.header) : Buffer.alloc(0);
        const lf       = cfg.lengthField;
        const loffset  = lf?.offset ?? magicBuf.length;
        const lsize    = lengthFieldSize(lf?.type ?? 'uint16be');
        const hdrLen   = loffset + lsize;
        return frame.subarray(hdrLen);
      }
      case 'delimiter':
      case 'fixed':
      case 'none':
      default:
        return frame;
    }
  }

  /** Wrap a payload body according to FramingConfig. */
  static wrap(body: Buffer, cfg: FramingConfig): Buffer {
    switch (cfg.mode) {
      case 'magic-header':
      case 'length-prefix': {
        const magicBuf = cfg.mode === 'magic-header' ? parseMagicBytes(cfg.header) : Buffer.alloc(0);
        const lf       = cfg.lengthField;
        const ltype    = lf?.type   ?? 'uint16be';
        const loffset  = lf?.offset ?? magicBuf.length;
        const lsize    = lengthFieldSize(ltype);
        const includes = lf?.includes ?? 'none';
        const hdrLen   = loffset + lsize;
        const bodyLen  = includes === 'all' ? body.length + hdrLen : body.length;
        const header   = Buffer.alloc(hdrLen);
        magicBuf.copy(header, 0);
        writeLengthField(header, loffset, ltype, bodyLen);
        return Buffer.concat([header, body]);
      }
      case 'delimiter': {
        const delim = parseDelimiterBytes(cfg.footer);
        return Buffer.concat([body, delim]);
      }
      case 'fixed': {
        const sz = cfg.fixedSize ?? 64;
        const b  = Buffer.alloc(sz);
        body.copy(b, 0, 0, Math.min(body.length, sz));
        return b;
      }
      case 'none':
      default:
        return body;
    }
  }
}
