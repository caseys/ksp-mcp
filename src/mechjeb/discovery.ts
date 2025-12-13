/**
 * MechJeb Module Discovery
 *
 * Queries SUFFIXNAMES to discover what modules are available
 * in the current kOS.MechJeb2.Addon installation.
 */

import type { KosConnection } from '../transport/kos-connection.js';
import type { MechJebModules } from './types.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse a kOS list output into an array of strings
 * Format: ["value"] = "ITEM1"[1] =["value"] = "ITEM2"...
 */
function parseSuffixList(output: string): string[] {
  const items: string[] = [];
  // Match patterns like ["value"] = "ITEMNAME"
  const regex = /\["value"\]\s*=\s*"([^"]+)"/g;
  let match;
  while ((match = regex.exec(output)) !== null) {
    items.push(match[1].toUpperCase());
  }
  return items;
}

/**
 * Check if MechJeb is available on the current vessel
 */
export async function isMechJebAvailable(conn: KosConnection): Promise<boolean> {
  const result = await conn.execute('PRINT ADDONS:MJ:AVAILABLE.');
  return result.output.includes('True');
}

/**
 * Get MechJeb version
 */
export async function getMechJebVersion(conn: KosConnection): Promise<string | undefined> {
  try {
    const result = await conn.execute('PRINT ADDONS:MJ:VERSION.');
    // Parse version from output
    const match = result.output.match(/[\d.]+/);
    return match ? match[0] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Discover what modules are available in the MechJeb addon
 */
export async function discoverModules(conn: KosConnection): Promise<MechJebModules> {
  // First check if MechJeb is available at all
  const available = await isMechJebAvailable(conn);

  if (!available) {
    return {
      available: false,
      hasAscent: false,
      hasLanding: false,
      hasManeuver: false,
      hasRendezvous: false,
      allSuffixes: []
    };
  }

  // Get version
  await delay(500);
  const version = await getMechJebVersion(conn);

  // Query MJ suffixes to see what modules exist
  await delay(500);
  const result = await conn.execute('PRINT ADDONS:MJ:SUFFIXNAMES.');
  const suffixes = parseSuffixList(result.output);

  // Check for known module names (kOS.MechJeb2.Addon uses different naming)
  const hasAscent = suffixes.includes('ASCENT') || suffixes.includes('ASCENTGUIDANCE');
  const hasLanding = suffixes.includes('LANDING') || suffixes.includes('LANDINGAUTOPILOT') || suffixes.includes('LANDINGGUIDANCE');
  const hasManeuver = suffixes.includes('MANEUVER') || suffixes.includes('NODE') || suffixes.includes('MANEUVERNODE') || suffixes.includes('MANEUVERPLANNER');
  const hasRendezvous = suffixes.includes('RENDEZVOUS') || suffixes.includes('RENDEZVOUSAUTOPILOT') || suffixes.includes('RENDEZVOUSGUIDANCE');

  return {
    available,
    version,
    hasAscent,
    hasLanding,
    hasManeuver,
    hasRendezvous,
    allSuffixes: suffixes
  };
}

/**
 * Discover ascent module suffixes
 */
export async function discoverAscentSuffixes(conn: KosConnection): Promise<string[]> {
  const result = await conn.execute('PRINT ADDONS:MJ:ASCENT:SUFFIXNAMES.');
  return parseSuffixList(result.output);
}

/**
 * Discover vessel state suffixes
 */
export async function discoverVesselSuffixes(conn: KosConnection): Promise<string[]> {
  const result = await conn.execute('PRINT ADDONS:MJ:VESSEL:SUFFIXNAMES.');
  return parseSuffixList(result.output);
}

/**
 * Discover info suffixes
 */
export async function discoverInfoSuffixes(conn: KosConnection): Promise<string[]> {
  const result = await conn.execute('PRINT ADDONS:MJ:INFO:SUFFIXNAMES.');
  return parseSuffixList(result.output);
}
