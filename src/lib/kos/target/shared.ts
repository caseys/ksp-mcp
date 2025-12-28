/**
 * Shared utilities for target management
 */

import type { KosConnection } from '../../../transport/kos-connection.js';

/**
 * Check if a navigation target is currently set
 */
export async function hasTarget(conn: KosConnection): Promise<boolean> {
  const result = await conn.execute('PRINT HASTARGET.', 2000);
  const output = result.output.trim().toLowerCase();
  // kOS returns "True" or "False" - check for true anywhere in output
  return output.includes('true');
}

/**
 * Get the name of the body the ship is currently orbiting (SOI body)
 */
export async function getSOIBody(conn: KosConnection): Promise<string> {
  const result = await conn.execute('PRINT SHIP:BODY:NAME.', 2000);
  // Extract body name from output (may have kOS prompt chars)
  const match = result.output.match(/([A-Za-z]+)/);
  return match ? match[1] : result.output.trim();
}

/**
 * Format distance for display: m for <10km, km for <10Mm, Mm for larger
 */
export function formatDistance(d: number): string {
  if (d < 10_000) return `${d} m`;
  if (d < 10_000_000) return `${(d / 1000).toFixed(1)} km`;
  return `${(d / 1_000_000).toFixed(2)} Mm`;
}
