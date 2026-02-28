// packages/server/src/protocol/field-serializer.ts
// Encode Record<string, unknown> → Buffer per FieldDef array

import type { FieldDef, FieldType } from '@devbridge/shared';

export class FieldSerializer {
  static serialize(
    defs:   FieldDef[],
    params: Record<string, unknown>,
  ): Buffer {
    const chunks: Buffer[] = [];

    for (const def of defs) {
      if (def.type === 'conditional') {
        // For serialize we include conditional fields if value is present
        if (def.fields && params[def.name] !== undefined) {
          chunks.push(FieldSerializer.serialize(def.fields, params[def.name] as Record<string, unknown>));
        }
        continue;
      }

      const value = params[def.name];
      chunks.push(FieldSerializer.serializeField(def, value, params));
    }

    return Buffer.concat(chunks);
  }

  private static serializeField(
    def:    FieldDef,
    value:  unknown,
    ctx:    Record<string, unknown>,
  ): Buffer {
    const v = value ?? def.default;

    switch (def.type as FieldType) {
      case 'uint8': {
        const b = Buffer.allocUnsafe(1);
        b.writeUInt8(Number(v ?? 0));
        return b;
      }
      case 'uint16le': {
        const b = Buffer.allocUnsafe(2);
        b.writeUInt16LE(Number(v ?? 0));
        return b;
      }
      case 'uint16be': {
        const b = Buffer.allocUnsafe(2);
        b.writeUInt16BE(Number(v ?? 0));
        return b;
      }
      case 'uint32le': {
        const b = Buffer.allocUnsafe(4);
        b.writeUInt32LE(Number(v ?? 0));
        return b;
      }
      case 'uint32be': {
        const b = Buffer.allocUnsafe(4);
        b.writeUInt32BE(Number(v ?? 0));
        return b;
      }
      case 'int8': {
        const b = Buffer.allocUnsafe(1);
        b.writeInt8(Number(v ?? 0));
        return b;
      }
      case 'int16le': {
        const b = Buffer.allocUnsafe(2);
        b.writeInt16LE(Number(v ?? 0));
        return b;
      }
      case 'int16be': {
        const b = Buffer.allocUnsafe(2);
        b.writeInt16BE(Number(v ?? 0));
        return b;
      }
      case 'int32le': {
        const b = Buffer.allocUnsafe(4);
        b.writeInt32LE(Number(v ?? 0));
        return b;
      }
      case 'int32be': {
        const b = Buffer.allocUnsafe(4);
        b.writeInt32BE(Number(v ?? 0));
        return b;
      }
      case 'float32': {
        const b = Buffer.allocUnsafe(4);
        b.writeFloatLE(Number(v ?? 0));
        return b;
      }
      case 'float64': {
        const b = Buffer.allocUnsafe(8);
        b.writeDoubleLE(Number(v ?? 0));
        return b;
      }
      case 'ascii': {
        const str  = String(v ?? '');
        const size = def.length ?? str.length;
        const b    = Buffer.alloc(size);       // zero-padded
        b.write(str.substring(0, size), 'ascii');
        return b;
      }
      case 'hex':
      case 'bytes': {
        if (Buffer.isBuffer(v)) return v;
        if (typeof v === 'string') return Buffer.from(v, 'hex');
        if (Array.isArray(v))     return Buffer.from(v as number[]);
        return Buffer.alloc(0);
      }
      case 'bcd': {
        const str = String(v ?? '');
        const n   = def.length ?? Math.ceil(str.length / 2);
        const b   = Buffer.alloc(n);
        const padded = str.padStart(n * 2, '0');
        for (let i = 0; i < n; i++) {
          const hi = parseInt(padded[i * 2]!,     10) & 0xf;
          const lo = parseInt(padded[i * 2 + 1]!, 10) & 0xf;
          b[i] = (hi << 4) | lo;
        }
        return b;
      }
      case 'enum': {
        // Encode: either pass raw number or string key → number via reverse map
        let raw: number;
        if (typeof v === 'number') {
          raw = v;
        } else {
          const map   = def.enum ?? {};
          const entry = Object.entries(map).find(([, label]) => label === v);
          raw = entry ? parseInt(entry[0], 16) || parseInt(entry[0], 10) : 0;
        }
        const b = Buffer.allocUnsafe(1);
        b.writeUInt8(raw);
        return b;
      }
      case 'bitmap': {
        let raw = 0;
        const bitsObj = (v ?? {}) as Record<string, unknown>;
        for (const bit of def.bits ?? []) {
          const bv = bitsObj[bit.name];
          if (bit.type === 'uint' && bit.width) {
            raw |= (Number(bv ?? 0) & ((1 << bit.width) - 1)) << bit.bit;
          } else {
            if (bv) raw |= 1 << bit.bit;
          }
        }
        const b = Buffer.allocUnsafe(1);
        b.writeUInt8(raw);
        return b;
      }
      case 'struct': {
        if (!def.fields) return Buffer.alloc(0);
        return FieldSerializer.serialize(def.fields, (v ?? {}) as Record<string, unknown>);
      }
      case 'array': {
        if (!def.fields) return Buffer.alloc(0);
        const items = Array.isArray(v) ? v : [];
        return Buffer.concat(
          items.map((item) =>
            FieldSerializer.serialize(def.fields!, item as Record<string, unknown>),
          ),
        );
      }
      default:
        throw new Error(`PROTOCOL_ENCODE_FAILED: unsupported field type '${String(def.type)}'`);
    }
  }
}
