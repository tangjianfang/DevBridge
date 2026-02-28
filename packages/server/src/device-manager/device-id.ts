// packages/server/src/device-manager/device-id.ts
// Stable device ID generation using SHA-256 fingerprint.

import { createHash } from 'node:crypto';
import type { RawDeviceInfo } from '@devbridge/shared';

/**
 * Returns a stable device ID string: `{transportType}:{16-char SHA-256 hex}`.
 * The 16-char (64-bit) hash space reduces collision risk compared to 32-bit.
 */
export function buildDeviceId(raw: RawDeviceInfo): string {
  const fingerprint = `${raw.address}:${raw.vendorId ?? 0}:${raw.productId ?? 0}:${raw.serialNumber ?? ''}`;
  const hash = createHash('sha256').update(fingerprint).digest('hex').slice(0, 16);
  return `${raw.transportType}:${hash}`;
}
