/**
 * SOI-based targets cache
 *
 * Caches the list of available targets (moons, planets, vessels) keyed by SOI.
 * When SOI changes, the cache is automatically invalidated.
 */

import type { ListTargetsResult } from '../kos/target/types.js';

interface TargetsCache {
  soi: string;
  timestamp: number;
  data: ListTargetsResult;
}

let cache: TargetsCache | null = null;

// Cache expires after 60 seconds (backup to SOI invalidation)
const MAX_AGE_MS = 60_000;

/**
 * Get cached targets if still valid for the current SOI
 */
export function getCachedTargets(currentSoi: string): ListTargetsResult | null {
  if (!cache) return null;
  if (cache.soi !== currentSoi) return null; // SOI changed = invalidate
  if (Date.now() - cache.timestamp > MAX_AGE_MS) return null; // Expired
  return cache.data;
}

/**
 * Store targets in cache for the given SOI
 */
export function setCachedTargets(soi: string, data: ListTargetsResult): void {
  cache = { soi, timestamp: Date.now(), data };
}
