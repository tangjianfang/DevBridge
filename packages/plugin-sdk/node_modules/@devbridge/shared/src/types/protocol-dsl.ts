// packages/shared/src/types/protocol-dsl.ts

import type { TransportType } from './transport.js';

// ── Field types ────────────────────────────────────────────────────

export type FieldType =
  | 'uint8' | 'uint16le' | 'uint16be' | 'uint32le' | 'uint32be'
  | 'int8'  | 'int16le'  | 'int16be'  | 'int32le'  | 'int32be'
  | 'float32' | 'float64'
  | 'ascii' | 'hex' | 'bytes'
  | 'bcd' | 'bitmap'
  | 'enum' | 'struct' | 'array' | 'conditional';

export interface BitField {
  name:    string;
  bit:     number;
  type?:   'bool' | 'uint';
  width?:  number;
}

export interface FieldDef {
  name:         string;
  type:         FieldType;
  offset?:      number;
  length?:      number;
  lengthField?: string;
  countField?:  string;
  count?:       number;
  /**
   * Safe expression string. Allowed: arithmetic, comparison, logical operators,
   * field access (fields.xxx). Forbidden: function calls, new, cross-scope.
   * Evaluated as: new Function('fields', `return (${condition})`)(decodedFields)
   */
  condition?:   string;
  bits?:        BitField[];
  fields?:      FieldDef[];
  default?:     unknown;
  readonly?:    boolean;
  description?: string;
  enum?:        Record<string, string>;
  value?:       unknown;       // fixed value (encode only)
  algorithm?:   ChecksumAlgorithm;
  range?:       string;        // checksum byte range, e.g. "cmdCode..payload"
}

// ── Framing ────────────────────────────────────────────────────────

export type FramingMode =
  | 'magic-header'
  | 'length-prefix'
  | 'delimiter'
  | 'fixed'
  | 'none';

export interface FramingConfig {
  mode:         FramingMode;
  header?:      string[];    // magic bytes e.g. ["0xAA","0x55"]
  footer?:      string[];    // delimiter bytes
  lengthField?: {
    offset:   number;
    type:     string;
    includes: 'all' | 'payload' | 'none';
  };
  fixedSize?:   number;
  maxFrameSize?: number;      // safety cap, default 65535
}

// ── Checksum ────────────────────────────────────────────────────────

export type ChecksumAlgorithm =
  | 'crc16-modbus' | 'crc16-ccitt' | 'crc32'
  | 'xor' | 'sum8' | 'lrc' | 'none';

export interface ChecksumConfig {
  algorithm: ChecksumAlgorithm;
  startOffset?: number;
  endOffset?:   number;
  seed?:        number;
}

// ── Channel definitions ────────────────────────────────────────────

export interface ChannelCommandDef {
  request: {
    fields:         FieldDef[];
  };
  response: {
    fields:         FieldDef[];
    commandIdField: string;
    statusField?:   string;
  };
}

export interface ChannelEventDef {
  fields:       FieldDef[];
  eventIdField: string;
}

export interface CommandDef {
  id:           string;
  requestCode:  number;
  description?: string;
  params?:      FieldDef[];
  response?:    FieldDef[];
}

export interface EventDef {
  id:           string;
  eventCode:    number;
  description?: string;
  fields?:      FieldDef[];
}

// ── Example entries ────────────────────────────────────────────────

export interface ExampleEntry {
  name:        string;
  direction:   'encode' | 'decode-command-response' | 'decode-event';
  input:       Record<string, unknown>;
  expectedHex: string;
}

// ── Full Protocol Schema ──────────────────────────────────────────

export interface ProtocolSchema {
  name:         string;
  version:      string;
  transport:    TransportType;
  framing:      FramingConfig;
  checksum?:    ChecksumConfig;
  channels: {
    command: ChannelCommandDef;
    event:   ChannelEventDef;
  };
  commands:     CommandDef[];
  events:       EventDef[];
  examples?:    ExampleEntry[];
}

// ── Runtime interface ─────────────────────────────────────────────

export interface DecodedMessage {
  messageType: string;
  fields:      Record<string, unknown>;
  rawHex?:     string;
}

export interface IProtocol {
  readonly name:    string;
  readonly version: string;
  encode(commandId: string, params: Record<string, unknown>): Buffer;
  decode(buffer: Buffer): DecodedMessage;
  validate(schema: ProtocolSchema): void;
}
