// packages/server/src/protocol/dynamic-protocol.ts
// DynamicProtocol — IProtocol implementation driven by ProtocolSchema.

import { EventEmitter } from 'node:events';

import type {
  ProtocolSchema,
  IProtocol,
  DecodedMessage,
  FieldDef,
} from '@devbridge/shared';

import { ChecksumAppender }     from './checksum.js';
import { Framer, FrameBuilder } from './framer.js';
import { FieldParser }          from './field-parser.js';
import { FieldSerializer }      from './field-serializer.js';

export class DynamicProtocol extends EventEmitter implements IProtocol {
  readonly name:    string;
  readonly version: string;

  private readonly schema: ProtocolSchema;

  constructor(schema: ProtocolSchema) {
    super();
    this.schema  = schema;
    this.name    = schema.name;
    this.version = schema.version;
  }

  // ──────────────────────────────────────────────────────────
  // IProtocol — Encode (command → device)
  // ──────────────────────────────────────────────────────────

  encode(commandId: string, params: Record<string, unknown>): Buffer {
    const cmd = this.schema.commands.find((c) => c.id === commandId);
    if (!cmd) {
      throw Object.assign(
        new Error(`PROTOCOL_ENCODE_FAILED: unknown command '${commandId}'`),
        { errorCode: 'PROTOCOL_ENCODE_FAILED' },
      );
    }

    // Merge requestCode into params as a fixed field if the channel defines it
    const requestFields: FieldDef[] = cmd.params ?? [];
    let body = FieldSerializer.serialize(requestFields, { ...params, _requestCode: cmd.requestCode });

    body = ChecksumAppender.append(body, this.schema.checksum);
    return FrameBuilder.wrap(body, this.schema.framing);
  }

  // ──────────────────────────────────────────────────────────
  // IProtocol — Decode (device → host)
  // ──────────────────────────────────────────────────────────

  decode(frame: Buffer): DecodedMessage {
    // 1. Strip framing header to get body (body + possible checksum)
    const bodyWithCs = FrameBuilder.unwrap(frame, this.schema.framing);

    // 2. Verify checksum on body+checksum, then strip to get pure body
    if (this.schema.checksum && !ChecksumAppender.verify(bodyWithCs, this.schema.checksum)) {
      throw Object.assign(
        new Error(`PROTOCOL_DECODE_FAILED: checksum verification failed`),
        { errorCode: 'PROTOCOL_DECODE_FAILED' },
      );
    }
    const payload = ChecksumAppender.strip(bodyWithCs, this.schema.checksum);

    // 3. Try to identify as a command response first, then as an event
    const cmdResponseFields = this.schema.channels.command.response.fields;
    const cmdIdField        = this.schema.channels.command.response.commandIdField;
    const eventFields       = this.schema.channels.event.fields;
    const eventIdField      = this.schema.channels.event.eventIdField;

    // Attempt command-response decode
    try {
      const header = FieldParser.parse(cmdResponseFields, payload, 0);
      const cmdCode = header[cmdIdField];
      const matchedCmd = this.schema.commands.find((c) => c.requestCode === cmdCode);
      if (matchedCmd) {
        const allFields = [
          ...cmdResponseFields,
          ...(matchedCmd.response ?? []),
        ];
        const fields = FieldParser.parse(allFields, payload, 0);
        return {
          messageType: `response:${matchedCmd.id}`,
          fields,
          rawHex: frame.toString('hex'),
        };
      }
    } catch {
      // Not a command response — fall through to event decode
    }

    // Attempt event decode
    try {
      const header   = FieldParser.parse(eventFields, payload, 0);
      const evCode   = header[eventIdField];
      const matchedEv = this.schema.events.find((e) => e.eventCode === evCode);
      if (matchedEv) {
        const allFields = [
          ...eventFields,
          ...(matchedEv.fields ?? []),
        ];
        const fields = FieldParser.parse(allFields, payload, 0);
        return {
          messageType: `event:${matchedEv.id}`,
          fields,
          rawHex: frame.toString('hex'),
        };
      }
    } catch {
      // Could not decode as event either
    }

    // Fallback: return raw bytes decoded as an unknown frame
    return {
      messageType: 'unknown',
      fields:      { raw: payload.toString('hex') },
      rawHex:      frame.toString('hex'),
    };
  }

  // ──────────────────────────────────────────────────────────
  // IProtocol — Validate
  // ──────────────────────────────────────────────────────────

  validate(schema: ProtocolSchema): void {
    if (!schema.name) throw new Error('PROTOCOL_INVALID: schema.name is required');
    if (!schema.version) throw new Error('PROTOCOL_INVALID: schema.version is required');
    if (!schema.framing?.mode) throw new Error('PROTOCOL_INVALID: schema.framing.mode is required');
  }

  // ──────────────────────────────────────────────────────────
  // Streaming
  // ──────────────────────────────────────────────────────────

  createFramer(onFrame: (frame: Buffer) => void): Framer {
    return new Framer(this.schema.framing, onFrame);
  }

  getSupportedCommands(): string[] {
    return this.schema.commands.map((c) => c.id);
  }

  getSchema(): ProtocolSchema {
    return this.schema;
  }

  // ──────────────────────────────────────────────────────────
  // Round-trip validation (used by ProtocolRegistry)
  // ──────────────────────────────────────────────────────────

  runExamples(): void {
    for (const example of this.schema.examples ?? []) {
      const encoded = this.encode(example.input['commandId'] as string ?? '', example.input);
      if (example.expectedHex && encoded.toString('hex') !== example.expectedHex.toLowerCase()) {
        throw new Error(
          `PROTOCOL example mismatch for '${example.name}': ` +
          `expected ${example.expectedHex} got ${encoded.toString('hex')}`,
        );
      }
      const decoded = this.decode(encoded);
      if (!decoded.messageType.startsWith('response:') && !decoded.messageType.startsWith('event:')) {
        throw new Error(
          `PROTOCOL round-trip failed for '${example.name}': decoded as '${decoded.messageType}'`,
        );
      }
    }
  }
}
