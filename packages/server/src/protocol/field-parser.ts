// packages/server/src/protocol/field-parser.ts
// Decode bytes → Record<string, unknown> per FieldDef array

import type { FieldDef, FieldType } from '@devbridge/shared';

// Safe expression evaluation for 'conditional' fields.
// Allowed: arithmetic, comparison, logical, field access (fields.xxx)
// Forbidden: function calls, `new`, cross-scope identifiers
const SAFE_EXPR_RE = /^[\w\s\d.+\-*/%<>!=&|()[\]'"]+$/;

function evalCondition(expr: string, fields: Record<string, unknown>): boolean {
  if (!SAFE_EXPR_RE.test(expr)) {
    throw new Error(`PROTOCOL_DECODE_FAILED: unsafe condition expression: ${expr}`);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return Boolean(new Function('fields', `return (${expr})`)(fields));
  } catch {
    return false;
  }
}

export class FieldParser {
  static parse(
    defs:   FieldDef[],
    buf:    Buffer,
    offset = 0,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    let   pos    = offset;

    for (const def of defs) {
      if (def.readonly === true && !defs.some((d) => d.name === def.name)) continue;

      // Conditional field: only include if condition is true
      if (def.type === 'conditional') {
        if (def.condition && !evalCondition(def.condition, result)) continue;
        if (def.fields) {
          const nested = FieldParser.parse(def.fields, buf, pos);
          Object.assign(result, nested);
        }
        continue;
      }

      const [value, consumed] = FieldParser.parseField(def, buf, pos, result);
      result[def.name] = value;
      pos += consumed;
    }
    return result;
  }

  static tryParseField(
    buf:    Buffer,
    name:   string,
    defs:   FieldDef[],
  ): number | undefined {
    try {
      const fields = FieldParser.parse(defs, buf, 0);
      const v = fields[name];
      return typeof v === 'number' ? v : undefined;
    } catch {
      return undefined;
    }
  }

  private static parseField(
    def:    FieldDef,
    buf:    Buffer,
    offset: number,
    ctx:    Record<string, unknown>,
  ): [unknown, number] {
    const len = FieldParser.resolveLength(def, ctx);
    if (buf.length < offset + (len ?? 0)) {
      throw Object.assign(
        new Error(`PROTOCOL_DECODE_FAILED: buffer too short for field '${def.name}' at offset ${offset}`),
        { errorCode: 'PROTOCOL_DECODE_FAILED' },
      );
    }

    switch (def.type as FieldType) {
      case 'uint8':   return [buf.readUInt8(offset), 1];
      case 'uint16le': return [buf.readUInt16LE(offset), 2];
      case 'uint16be': return [buf.readUInt16BE(offset), 2];
      case 'uint32le': return [buf.readUInt32LE(offset), 4];
      case 'uint32be': return [buf.readUInt32BE(offset), 4];
      case 'int8':    return [buf.readInt8(offset), 1];
      case 'int16le': return [buf.readInt16LE(offset), 2];
      case 'int16be': return [buf.readInt16BE(offset), 2];
      case 'int32le': return [buf.readInt32LE(offset), 4];
      case 'int32be': return [buf.readInt32BE(offset), 4];
      case 'float32': return [buf.readFloatLE(offset), 4];
      case 'float64': return [buf.readDoubleLE(offset), 8];

      case 'ascii': {
        const n = len ?? 0;
        return [buf.subarray(offset, offset + n).toString('ascii').replace(/\0+$/, ''), n];
      }
      case 'hex':
      case 'bytes': {
        const n = len ?? (buf.length - offset);
        return [buf.subarray(offset, offset + n), n];
      }
      case 'bcd': {
        const n = len ?? 1;
        let s = '';
        for (let i = offset; i < offset + n; i++) {
          const b = buf[i]!;
          s += ((b >> 4) & 0xf).toString() + (b & 0xf).toString();
        }
        return [s, n];
      }
      case 'enum': {
        const [raw, sz] = FieldParser.parseField({ ...def, type: 'uint8' }, buf, offset, ctx);
        const hexKey = `0x${(raw as number).toString(16).toUpperCase().padStart(2, '0')}`;
        const decKey = String(raw);
        const mapped = def.enum?.[hexKey] ?? def.enum?.[decKey] ?? raw;
        return [mapped, sz];
      }
      case 'bitmap': {
        const [raw, sz] = FieldParser.parseField({ ...def, type: 'uint8' }, buf, offset, ctx);
        const obj: Record<string, boolean | number> = {};
        for (const bit of def.bits ?? []) {
          if (bit.type === 'uint' && bit.width) {
            obj[bit.name] = ((raw as number) >> bit.bit) & ((1 << bit.width) - 1);
          } else {
            obj[bit.name] = Boolean((raw as number) & (1 << bit.bit));
          }
        }
        return [obj, sz];
      }
      case 'struct': {
        if (!def.fields) throw new Error(`PROTOCOL_DECODE_FAILED: struct field '${def.name}' missing 'fields'`);
        const nested = FieldParser.parse(def.fields, buf, offset);
        const nestedSize = def.fields.reduce((acc, f) => acc + (FieldParser.resolveLength(f, nested) ?? 1), 0);
        return [nested, nestedSize];
      }
      case 'array': {
        if (!def.fields) throw new Error(`PROTOCOL_DECODE_FAILED: array field '${def.name}' missing 'fields'`);
        const count = typeof def.count === 'number'
          ? def.count
          : (def.countField ? Number(ctx[def.countField] ?? 0) : 0);
        const items: Record<string, unknown>[] = [];
        let p = offset;
        for (let i = 0; i < count; i++) {
          const item = FieldParser.parse(def.fields, buf, p);
          items.push(item);
          p += def.fields.reduce((acc, f) => acc + (FieldParser.resolveLength(f, item) ?? 1), 0);
        }
        return [items, p - offset];
      }
      default:
        throw new Error(`PROTOCOL_DECODE_FAILED: unknown field type '${String(def.type)}'`);
    }
  }

  private static resolveLength(def: FieldDef, ctx: Record<string, unknown>): number | undefined {
    if (def.length !== undefined) return def.length;
    if (def.lengthField) return Number(ctx[def.lengthField] ?? 0);
    return undefined;
  }
}
