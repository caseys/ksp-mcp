/**
 * Shared utilities for MechJeb maneuver operations
 */

import type { KosConnection } from '../../transport/kos-connection.js';

/**
 * Unlock steering and throttle controls.
 * Call this after errors to ensure the vessel isn't left in a locked state.
 */
export async function unlockControls(conn: KosConnection): Promise<void> {
  try {
    await conn.execute('UNLOCK STEERING. UNLOCK THROTTLE.', 2000);
  } catch {
    // Ignore errors - best effort cleanup
  }
}

/**
 * Check if a navigation target is currently set.
 */
export async function hasTarget(conn: KosConnection): Promise<boolean> {
  const result = await conn.execute('PRINT HASTARGET.', 2000);
  return result.output.toLowerCase().includes('true');
}

/**
 * Require a target to be set, returning an error result if not.
 * Use this at the start of functions that need a target.
 */
export async function requireTarget(conn: KosConnection): Promise<ManeuverResult | null> {
  if (await hasTarget(conn)) {
    return null; // Target exists, proceed
  }
  return {
    success: false,
    error: 'No target set. Use set_target first.'
  };
}

/**
 * Get the name of the current target.
 * Returns empty string if no target is set.
 */
export async function getTargetName(conn: KosConnection): Promise<string> {
  const result = await conn.execute('PRINT TARGET:NAME.', 2000);
  // Clean up kOS prompt characters
  return result.output.trim().replace(/[>\s]+$/, '');
}

export interface ManeuverResult {
  success: boolean;
  deltaV?: number;        // m/s
  timeToNode?: number;    // seconds
  nodesCreated?: number;  // actual number of nodes created
  error?: string;
  targetInfo?: TargetEncounterInfo;  // Target-specific encounter info
}

/** Info for celestial body targets (Mun, Minmus, planets) */
export interface BodyEncounterInfo {
  targetType: 'body';
  targetName: string;
  /** Periapsis in target SOI (meters), negative = crash trajectory! */
  periapsisInTargetSOI?: number;
  /** Time to closest approach (seconds) */
  timeToClosestApproach?: number;
  /** Delta-V needed for capture burn (m/s) */
  captureDeltaV?: number;
  /** Atmosphere height in meters (0 if no atmosphere) */
  atmosphereHeight?: number;
}

/** Info for vessel targets (ships, stations) */
export interface VesselEncounterInfo {
  targetType: 'vessel';
  targetName: string;
  /** Distance at closest approach (meters) */
  closestApproachDistance?: number;
  /** Time to closest approach (seconds) */
  timeToClosestApproach?: number;
  /** Relative velocity at closest approach (m/s) */
  closestApproachRelVel?: number;
}

export type TargetEncounterInfo = BodyEncounterInfo | VesselEncounterInfo;

/**
 * Parse a numeric value from kOS output
 * Looks for patterns like "23.80  m/s" or just bare numbers (including negative)
 * Returns 0 if input is undefined, null, or doesn't contain a number
 */
export function parseNumber(output: string | undefined | null): number {
  if (!output) return 0;

  // First try to find a number with units (e.g., "23.80  m/s" or "-23.80  m/s")
  const withUnits = output.match(/(-?\d+(?:\.\d+)?)\s*m\/s/i);
  if (withUnits) {
    return Number.parseFloat(withUnits[1]);
  }

  // Otherwise find all numbers (including negative)
  const allNumbers = output.match(/-?\d+(?:\.\d+)?(?:E[+-]?\d+)?/gi);
  if (allNumbers && allNumbers.length > 0) {
    // Take the last number which is most likely the actual value
    // Using non-null assertion since we checked length > 0
    return Number.parseFloat(allNumbers.at(-1)!);
  }

  return 0;
}

/**
 * Parse time string like "31m 10s", "5h 23m 10s", or "1d 00h 34m 17s" to seconds
 */
function parseTimeString(output: string): number {
  // Try standard number first (pure seconds)
  const numMatch = output.match(/^[\s\S]*?([\d.]+)\s*$/);
  if (numMatch) {
    const val = Number.parseFloat(numMatch[1]);
    if (!isNaN(val) && val > 0) return val;
  }

  // Parse human-readable format: Xd Yh Zm Ws
  let seconds = 0;
  const daysMatch = output.match(/(\d+)\s*d/i);
  const hoursMatch = output.match(/(\d+)\s*h/i);
  const minsMatch = output.match(/(\d+)\s*m/i);
  const secsMatch = output.match(/(\d+)\s*s/i);

  if (daysMatch) seconds += Number.parseInt(daysMatch[1]) * 86_400;
  if (hoursMatch) seconds += Number.parseInt(hoursMatch[1]) * 3600;
  if (minsMatch) seconds += Number.parseInt(minsMatch[1]) * 60;
  if (secsMatch) seconds += Number.parseInt(secsMatch[1]);

  return seconds;
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/**
 * Query a numeric value from MechJeb (e.g., "23.80  m/s")
 */
export async function queryNumber(conn: KosConnection, suffix: string): Promise<number> {
  const result = await conn.execute(`PRINT ${suffix}.`, 2000);
  return parseNumber(result.output);
}

/**
 * Query maneuver node info using kOS native commands
 * Returns deltaV and timeToNode for the next maneuver node
 *
 * Uses kOS's NEXTNODE instead of MechJeb INFO suffixes which return "N/A"
 * Optimized: single command instead of 3 sequential queries
 */
export async function queryNodeInfo(conn: KosConnection): Promise<{ deltaV: number; timeToNode: number }> {
  // Single atomic query: check for node and get values in one command
  const result = await conn.execute(
    'IF HASNODE { PRINT "NODE|" + NEXTNODE:DELTAV:MAG + "|" + NEXTNODE:ETA. } ELSE { PRINT "NONODE". }',
    3000
  );

  // Parse "NODE|deltaV|eta" format
  // The command echo contains "NONODE" as string literal, so we must check for
  // the actual result pattern first
  const match = result.output.match(/NODE\|([\d.]+)\|([\d.]+)/);
  if (match) {
    return {
      deltaV: Number.parseFloat(match[1]),
      timeToNode: Number.parseFloat(match[2])
    };
  }

  // No node data found - either no node exists or output was empty/error
  return { deltaV: 0, timeToNode: 0 };
}

/**
 * Query a time value from MechJeb (e.g., "31m 10s")
 */
export async function queryTime(conn: KosConnection, suffix: string): Promise<number> {
  const result = await conn.execute(`PRINT ${suffix}.`, 2000);
  return parseTimeString(result.output);
}

/**
 * Sanitize kOS output for error messages.
 * Removes command echoes and extracts meaningful failure reasons.
 */
function sanitizeError(rawOutput: string): string {
  // If output contains command echo, give generic message
  // Check this FIRST because command echo may contain FALSE as parameter
  if (rawOutput.includes('SET ') || rawOutput.includes('PRINT ')) {
    return 'Planner did not return success';
  }

  const errorPatterns = [
    { pattern: /No target/i, message: 'No target set' },
    { pattern: /Cannot find/i, message: 'Command not found - MechJeb may not be available' },
    { pattern: /Syntax error/i, message: 'kOS syntax error' },
    { pattern: /^False$/i, message: 'Planner returned False' },  // Exact match only
  ];

  for (const { pattern, message } of errorPatterns) {
    if (pattern.test(rawOutput)) {
      return message;
    }
  }

  // Return cleaned output (limit length)
  const cleaned = rawOutput.trim().slice(0, 100);
  return cleaned || 'Unknown error';
}

/**
 * Execute a maneuver planning command and return the result with node info
 */
export async function executeManeuverCommand(
  conn: KosConnection,
  cmd: string,
  timeout = 10_000
): Promise<ManeuverResult> {
  const result = await conn.execute(cmd, timeout);

  const success = result.output.includes('True');
  if (!success) {
    return { success: false, error: sanitizeError(result.output) };
  }

  // Use kOS native NEXTNODE instead of broken MechJeb INFO suffixes
  const nodeInfo = await queryNodeInfo(conn);

  return {
    success: true,
    deltaV: nodeInfo.deltaV,
    timeToNode: nodeInfo.timeToNode
  };
}

/**
 * Parse MechJeb formatted distance string to meters.
 * Examples: "123.4 km", "1,234 m", "45.2 Mm", "N/A"
 */
function parseDistanceString(str: string): number | undefined {
  if (!str || str.includes('N/A')) return undefined;

  // Extract number and unit
  const match = str.match(/(-?[\d,.]+)\s*(m|km|Mm|Gm)?/i);
  if (!match) return undefined;

  const value = Number.parseFloat(match[1].replaceAll(',', ''));
  const unit = (match[2] || 'm').toLowerCase();

  const multipliers: Record<string, number> = {
    'm': 1,
    'km': 1000,
    'mm': 1_000_000,
    'gm': 1_000_000_000,
  };

  return value * (multipliers[unit] || 1);
}

/**
 * Parse MechJeb formatted velocity string to m/s.
 * Examples: "823.4 m/s", "1.2 km/s", "N/A"
 */
function parseVelocityString(str: string): number | undefined {
  if (!str || str.includes('N/A')) return undefined;

  const match = str.match(/(-?[\d,.]+)\s*(m\/s|km\/s)?/i);
  if (!match) return undefined;

  const value = Number.parseFloat(match[1].replaceAll(',', ''));
  const unit = (match[2] || 'm/s').toLowerCase();

  return unit === 'km/s' ? value * 1000 : value;
}

/**
 * Query target encounter information from MechJeb.
 * Returns different info based on target type (body vs vessel).
 *
 * @param conn kOS connection
 * @returns TargetEncounterInfo or null if no target
 */
export async function queryTargetEncounterInfo(
  conn: KosConnection
): Promise<TargetEncounterInfo | null> {
  // First, check if target exists and get its type
  const targetCheck = await conn.execute(
    'IF HASTARGET { PRINT "TGT|" + TARGET:NAME + "|" + TARGET:TYPENAME. } ELSE { PRINT "NOTGT". }',
    3000
  );

  if (targetCheck.output.includes('NOTGT')) {
    return null;
  }

  // Parse target name and type
  const targetMatch = targetCheck.output.match(/TGT\|([^|]+)\|(\w+)/);
  if (!targetMatch) {
    return null;
  }

  const targetName = targetMatch[1].trim();
  const targetType = targetMatch[2].toLowerCase();

  if (targetType === 'body') {
    // Query body-specific encounter info
    // Note: TCA = time to closest approach, TPERI = periapsis in target SOI, TCAPDV = capture delta-V
    const bodyInfo = await conn.execute(
      'PRINT "BODY|" + ADDONS:MJ:INFO:TPERI + "|" + ADDONS:MJ:INFO:TCA + "|" + ADDONS:MJ:INFO:TCAPDV + "|" + TARGET:ATM:HEIGHT.',
      3000
    );

    const bodyMatch = bodyInfo.output.match(/BODY\|([^|]+)\|([^|]+)\|([^|]+)\|(.+)/);
    if (!bodyMatch) {
      // Fallback: return basic info
      return {
        targetType: 'body',
        targetName,
      };
    }

    return {
      targetType: 'body',
      targetName,
      periapsisInTargetSOI: parseDistanceString(bodyMatch[1]),
      timeToClosestApproach: parseTimeString(bodyMatch[2]),
      captureDeltaV: parseVelocityString(bodyMatch[3]),
      atmosphereHeight: parseNumber(bodyMatch[4]),
    };
  } else {
    // Query vessel-specific encounter info
    const vesselInfo = await conn.execute(
      'PRINT "VESSEL|" + ADDONS:MJ:INFO:CADIST + "|" + ADDONS:MJ:INFO:TCA + "|" + ADDONS:MJ:INFO:CAREL.',
      3000
    );

    const vesselMatch = vesselInfo.output.match(/VESSEL\|([^|]+)\|([^|]+)\|(.+)/);
    if (!vesselMatch) {
      // Fallback: return basic info
      return {
        targetType: 'vessel',
        targetName,
      };
    }

    return {
      targetType: 'vessel',
      targetName,
      closestApproachDistance: parseDistanceString(vesselMatch[1]),
      timeToClosestApproach: parseTimeString(vesselMatch[2]),
      closestApproachRelVel: parseVelocityString(vesselMatch[3]),
    };
  }
}
