// packages/server/src/plugin-loader/plugin-matcher.ts

import type { RawDeviceInfo } from '@devbridge/shared';
import type { PluginManifest, PluginMatchRule } from '@devbridge/shared';

/**
 * Scores how well a PluginManifest matches a RawDeviceInfo.
 *
 * Scoring:
 *   transport type match   : +10  pts
 *   vendorId  exact match  : +100 pts
 *   productId exact match  : +200 pts
 *   serviceUUID match      : +50  pts each
 */
export class PluginMatcher {
  /**
   * Returns the highest-scoring manifest for `raw`, or `null` if nothing matches.
   */
  static match(raw: RawDeviceInfo, manifests: PluginManifest[]): PluginManifest | null {
    let best: { manifest: PluginManifest; score: number } | null = null;

    for (const manifest of manifests) {
      const score = PluginMatcher.scoreManifest(raw, manifest);
      if (score > 0 && (!best || score > best.score)) {
        best = { manifest, score };
      }
    }

    return best?.manifest ?? null;
  }

  /**
   * Computes the match score for a single manifest against `raw`.
   * Returns 0 if no rule matches.
   */
  static scoreManifest(raw: RawDeviceInfo, manifest: PluginManifest): number {
    let topScore = 0;

    for (const rule of manifest.match) {
      const ruleScore = PluginMatcher.scoreRule(raw, rule);
      if (ruleScore > topScore) topScore = ruleScore;
    }

    return topScore;
  }

  /**
   * Returns the score for a single MatchRule against `raw`.
   * Returns 0 if the transport type doesn't match.
   */
  static scoreRule(raw: RawDeviceInfo, rule: PluginMatchRule): number {
    if (rule.transport !== raw.transportType) return 0;

    let score = 10; // transport type match

    if ('vendorId'  in rule && rule.vendorId  !== undefined && rule.vendorId  === raw.vendorId)  score += 100;
    if ('productId' in rule && rule.productId !== undefined && rule.productId === raw.productId) score += 200;

    // BLE service UUID match
    if ('serviceUUID' in rule && rule.serviceUUID) {
      const rawUUIDs = (raw.raw as { serviceUUIDs?: string[] } | undefined)?.serviceUUIDs;
      if (rawUUIDs?.includes(rule.serviceUUID)) score += 50;
    }

    // BLE name prefix match
    if ('namePrefix' in rule && rule.namePrefix && raw.address) {
      if (raw.address.startsWith(rule.namePrefix)) score += 50;
    }

    return score;
  }
}
