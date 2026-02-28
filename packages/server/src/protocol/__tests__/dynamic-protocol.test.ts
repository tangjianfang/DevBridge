// packages/server/src/protocol/__tests__/dynamic-protocol.test.ts
import { describe, it, expect } from 'vitest';
import { DynamicProtocol }  from '../dynamic-protocol.js';
import type { ProtocolSchema } from '@devbridge/shared';

// ── Minimal schema fixture ─────────────────────────────────────────────

const schema: ProtocolSchema = {
  name:      'test-protocol',
  version:   '1.0.0',
  transport: 'serial',
  framing: {
    mode:        'length-prefix',
    lengthField: { offset: 0, type: 'uint16be', includes: 'none' },
  },
  channels: {
    command: {
      request: {
        fields: [
          { name: 'cmdCode', type: 'uint8' },
        ],
      },
      response: {
        fields: [
          { name: 'cmdCode', type: 'uint8' },
          { name: 'status',  type: 'uint8' },
        ],
        commandIdField: 'cmdCode',
        statusField:    'status',
      },
    },
    event: {
      fields: [
        { name: 'evCode', type: 'uint8' },
      ],
      eventIdField: 'evCode',
    },
  },
  commands: [
    {
      id:          'getStatus',
      requestCode: 0x01,
      params:      [{ name: 'cmdCode', type: 'uint8', value: 0x01, default: 0x01 }],
      response:    [{ name: 'value',   type: 'uint8' }],
    },
    {
      id:          'setMode',
      requestCode: 0x02,
      params:      [
        { name: 'cmdCode', type: 'uint8', default: 0x02 },
        { name: 'mode',    type: 'uint8' },
      ],
    },
  ],
  events: [
    {
      id:        'dataReady',
      eventCode: 0x10,
      fields:    [{ name: 'payload', type: 'uint8' }],
    },
  ],
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe('DynamicProtocol', () => {
  const proto = new DynamicProtocol(schema);

  it('has correct name and version', () => {
    expect(proto.name).toBe('test-protocol');
    expect(proto.version).toBe('1.0.0');
  });

  it('getSupportedCommands returns known commands', () => {
    expect(proto.getSupportedCommands()).toEqual(['getStatus', 'setMode']);
  });

  it('getSchema returns the original schema', () => {
    expect(proto.getSchema()).toBe(schema);
  });

  describe('encode', () => {
    it('encodes a known command with default params', () => {
      const buf = proto.encode('getStatus', { cmdCode: 0x01 });
      // Frame: 2-byte length prefix (uint16be) + body
      // body: [0x01] (cmdCode)
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.length).toBeGreaterThanOrEqual(3); // 2 hdr + 1 body
      expect(buf.readUInt16BE(0)).toBe(buf.length - 2); // body length = total - header
    });

    it('encodes setMode with mode param', () => {
      const buf = proto.encode('setMode', { cmdCode: 0x02, mode: 0x03 });
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf.length).toBe(4); // 2 hdr + 2 body
    });

    it('throws PROTOCOL_ENCODE_FAILED for unknown command', () => {
      expect(() => proto.encode('unknownCmd', {})).toThrow('PROTOCOL_ENCODE_FAILED');
    });
  });

  describe('decode', () => {
    it('decodes a command-response frame', () => {
      // Build a raw response frame: length-prefix [cmdCode=0x01, status=0x00, value=0x42]
      const body   = Buffer.from([0x01, 0x00, 0x42]);
      const header = Buffer.allocUnsafe(2);
      header.writeUInt16BE(body.length, 0);
      const frame  = Buffer.concat([header, body]);

      const msg = proto.decode(frame);
      expect(msg.messageType).toBe('response:getStatus');
      expect(msg.fields['cmdCode']).toBe(0x01);
      expect(msg.fields['status']).toBe(0x00);
    });

    it('decodes an event frame', () => {
      // Build raw event frame: [evCode=0x10, payload=0x55]
      const body   = Buffer.from([0x10, 0x55]);
      const header = Buffer.allocUnsafe(2);
      header.writeUInt16BE(body.length, 0);
      const frame  = Buffer.concat([header, body]);

      const msg = proto.decode(frame);
      expect(msg.messageType).toBe('event:dataReady');
      expect(msg.fields['evCode']).toBe(0x10);
    });

    it('decodes unknown frame as "unknown"', () => {
      const body   = Buffer.from([0xFF, 0xFF]);
      const header = Buffer.allocUnsafe(2);
      header.writeUInt16BE(body.length, 0);
      const frame  = Buffer.concat([header, body]);

      const msg = proto.decode(frame);
      expect(msg.messageType).toBe('unknown');
    });

    it('includes rawHex in decoded message', () => {
      const body   = Buffer.from([0x01, 0x00, 0x42]);
      const header = Buffer.allocUnsafe(2);
      header.writeUInt16BE(body.length, 0);
      const frame  = Buffer.concat([header, body]);

      const msg = proto.decode(frame);
      expect(msg.rawHex).toBe(frame.toString('hex'));
    });
  });

  describe('validate', () => {
    it('passes for valid schema', () => {
      expect(() => proto.validate(schema)).not.toThrow();
    });

    it('throws for schema without name', () => {
      expect(() => proto.validate({ ...schema, name: '' })).toThrow('PROTOCOL_INVALID');
    });
  });

  describe('createFramer', () => {
    it('returns a Framer instance', () => {
      const framer = proto.createFramer(() => {});
      expect(framer).toBeDefined();
      expect(typeof framer.push).toBe('function');
      expect(typeof framer.reset).toBe('function');
    });

    it('Framer correctly processes frames', () => {
      const frames: Buffer[] = [];
      const framer = proto.createFramer((f) => frames.push(f));

      const body   = Buffer.from([0x01, 0x02, 0x03]);
      const header = Buffer.allocUnsafe(2);
      header.writeUInt16BE(body.length, 0);
      framer.push(Buffer.concat([header, body]));

      expect(frames).toHaveLength(1);
    });
  });
});
