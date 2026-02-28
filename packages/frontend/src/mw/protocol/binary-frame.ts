// packages/frontend/src/mw/protocol/binary-frame.ts

/**
 * Parsed representation of a DevBridge binary frame (DBRG header).
 * Header layout (32 bytes):
 *   [0-3]   magic      = 0x44425247 ("DBRG") big-endian uint32
 *   [4-7]   frameType  = uint32 little-endian
 *   [8-23]  deviceId   = 16-byte UTF-8, null-padded
 *   [24-31] timestamp  = uint64 little-endian (read as two uint32s)
 *   [32+]   payload
 */

export interface ParsedBinaryFrame {
  deviceId:  string;
  frameType: number;
  timestamp: number;
  payload:   Uint8Array;
}

const HEADER_SIZE = 32;
const MAGIC       = 0x44425247; // "DBRG" big-endian

/**
 * Parse a raw ArrayBuffer received from the WebSocket.
 * Returns null if the buffer is too short or magic is wrong.
 */
export function parseBinaryFrame(
  ab: ArrayBuffer,
): ParsedBinaryFrame | null {
  if (ab.byteLength < HEADER_SIZE) return null;

  const view = new DataView(ab);

  const magic = view.getUint32(0, false); // big-endian
  if (magic !== MAGIC) return null;

  const frameType = view.getUint32(4, true); // little-endian

  // deviceId: offset 8, 16 bytes UTF-8, null-padded
  const idBytes      = new Uint8Array(ab, 8, 16);
  const nullIdx      = idBytes.indexOf(0);
  const idSlice      = nullIdx === -1 ? idBytes : idBytes.subarray(0, nullIdx);
  const deviceId     = new TextDecoder().decode(idSlice);

  // timestamp: offset 24, uint64-LE (high 32 bits ignored for safety in JS)
  const timestampLow  = view.getUint32(24, true);
  const timestampHigh = view.getUint32(28, true);
  const timestamp     = timestampHigh * 0x1_0000_0000 + timestampLow;

  const payload = new Uint8Array(ab, HEADER_SIZE);

  return { deviceId, frameType, timestamp, payload };
}
