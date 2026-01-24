/**
 * Shared utilities for MechJeb maneuver operations
 */

import type { KosConnection } from '../../transport/kos-connection.js';
import type { McpLogger } from '../tool-types.js';

/**
 * Unlock steering and throttle controls.
 * Call this after errors to ensure the vessel isn't left in a locked state.
 */
export async function unlockControls(conn: KosConnection): Promise<void> {
  try {
    await conn.raw('UNLOCK STEERING. UNLOCK THROTTLE.', 2000);
  } catch {
    // Ignore errors - best effort cleanup
  }
}

export interface ManeuverResult {
  success: boolean;
  deltaV?: number;        // m/s
  timeToNode?: number;    // seconds
  nodesCreated?: number;  // actual number of nodes created
  error?: string;
  warning?: string;       // Non-error guidance (e.g., crash trajectory needs follow-up)
  targetInfo?: TargetEncounterInfo;  // Target-specific encounter info
  /** Close approach without SOI encounter (for low-gravity bodies like Minmus) */
  closeApproach?: {
    distance: number;  // meters
    time: number;      // seconds from now
  };
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
 * Details about a wrong encounter situation (encounter with unexpected body)
 */
export interface WrongEncounterDetails {
  encounterBody: string;
  encounterPeriapsis: number;  // altitude above surface in meters
  transferApoapsis: number;     // transfer orbit apoapsis in parent SOI
  targetSMA: number;            // target's semi-major axis
  isCrash: boolean;             // true if encounter periapsis < 10km
  hasCloseApproach: boolean;    // true if transfer apoapsis >= 85% of target SMA
}

/**
 * Query details about a wrong encounter situation.
 * Must be called while nodes still exist (before clearing).
 *
 * @param conn kOS connection
 * @param encounterBody Name of the body we're encountering
 */
export async function queryWrongEncounterDetails(
  conn: KosConnection,
  encounterBody: string
): Promise<WrongEncounterDetails | null> {
  try {
    // Use queue() for clean output extraction
    const result = await conn.queue(
      `LOCAL encPe IS NEXTNODE:ORBIT:NEXTPATCH:PERIAPSIS. ` +
      `LOCAL xferAp IS NEXTNODE:ORBIT:APOAPSIS. ` +
      `LOCAL tgtSMA IS TARGET:ORBIT:SEMIMAJORAXIS. ` +
      `PRINT encPe + "|" + xferAp + "|" + tgtSMA.`,
      5000
    );

    if (!result.success) return null;

    const parts = result.output.split('|');
    if (parts.length < 3) return null;

    const encounterPeriapsis = parseFloat(parts[0]);
    const transferApoapsis = parseFloat(parts[1]);
    const targetSMA = parseFloat(parts[2]);

    const SAFE_PE_THRESHOLD = 10_000;  // 10km minimum safe periapsis
    const CLOSE_APPROACH_RATIO = 0.85;  // Must reach 85% of target's orbital altitude

    return {
      encounterBody,
      encounterPeriapsis,
      transferApoapsis,
      targetSMA,
      isCrash: encounterPeriapsis < SAFE_PE_THRESHOLD,
      hasCloseApproach: transferApoapsis >= targetSMA * CLOSE_APPROACH_RATIO,
    };
  } catch {
    return null;
  }
}

/**
 * Parse a numeric value from kOS/MechJeb output
 * Handles values with units like "534.23 kN", "23.80 m/s", "150.5 km", or bare numbers
 * Returns 0 if input is undefined, null, or doesn't contain a number
 */
export function parseNumber(output: string | undefined | null): number {
  if (!output) return 0;

  // Try to match a number with common kOS/MechJeb units
  // Order matters: check specific units before bare number fallback
  const unitPatterns = [
    /(-?\d+(?:\.\d+)?(?:E[+-]?\d+)?)\s*kN/i,   // thrust: "534.23 kN"
    /(-?\d+(?:\.\d+)?(?:E[+-]?\d+)?)\s*m\/s/i, // velocity: "23.80 m/s"
    /(-?\d+(?:\.\d+)?(?:E[+-]?\d+)?)\s*km/i,   // distance: "150.5 km"
    /(-?\d+(?:\.\d+)?(?:E[+-]?\d+)?)\s*m(?!\w)/i, // meters: "500 m" (not "ms" or "min")
  ];

  for (const pattern of unitPatterns) {
    const match = output.match(pattern);
    if (match) {
      return Number.parseFloat(match[1]);
    }
  }

  // Fallback: find all numbers (including negative and scientific notation)
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

/**
 * Query a numeric value from MechJeb (e.g., "23.80  m/s")
 */
export async function queryNumber(conn: KosConnection, suffix: string): Promise<number> {
  const result = await conn.queue(`PRINT ${suffix}.`, 2000);
  return result.success ? parseNumber(result.output) : 0;
}

/**
 * Query maneuver node info using kOS native commands
 * Returns deltaV and timeToNode for the next maneuver node
 *
 * Uses kOS's NEXTNODE instead of MechJeb INFO suffixes which return "N/A"
 * Optimized: single command instead of 3 sequential queries
 */
export async function queryNodeInfo(conn: KosConnection): Promise<{ deltaV: number; timeToNode: number }> {
  // Use queue() for clean output - no need to worry about echo interference
  const result = await conn.queue(
    'IF HASNODE { PRINT NEXTNODE:DELTAV:MAG + "|" + NEXTNODE:ETA. } ELSE { PRINT "NONODE". }',
    3000
  );

  if (!result.success || result.output === 'NONODE') {
    return { deltaV: 0, timeToNode: 0 };
  }

  // Parse "deltaV|eta" format - clean output, no markers needed
  const parts = result.output.split('|');
  if (parts.length >= 2) {
    return {
      deltaV: Number.parseFloat(parts[0]),
      timeToNode: Number.parseFloat(parts[1])
    };
  }

  return { deltaV: 0, timeToNode: 0 };
}

/**
 * Sanitize kOS output for error messages.
 * Removes command echoes and extracts meaningful failure reasons.
 */
export function sanitizeError(rawOutput: string, operation?: string): string {
  const opPrefix = operation ? `${operation} failed - ` : '';

  // If output contains command echo, give generic message
  // Check this FIRST because command echo may contain FALSE as parameter
  if (rawOutput.includes('SET ') || rawOutput.includes('PRINT ')) {
    return `${opPrefix}planner did not return success`;
  }

  const errorPatterns = [
    { pattern: /No target/i, message: 'No target set' },
    { pattern: /Cannot find/i, message: 'Command not found - MechJeb may not be available' },
    { pattern: /Syntax error/i, message: 'kOS syntax error' },
    { pattern: /^False$/i, message: `${opPrefix}planner returned False` },  // Exact match only
  ];

  for (const { pattern, message } of errorPatterns) {
    if (pattern.test(rawOutput)) {
      return message;
    }
  }

  // Return cleaned output (limit length)
  const cleaned = rawOutput.trim().slice(0, 100);
  return cleaned || `${opPrefix}unknown error`;
}

/**
 * Validate that a created maneuver node is in the current conic patch.
 * If node is beyond the next SOI change, clears it and returns error.
 *
 * @param conn kOS connection
 * @param toolName Name of tool for error message
 * @returns Validation result - valid:true if node is in current patch
 */
export async function validateNodeInCurrentPatch(
  conn: KosConnection,
  toolName: string
): Promise<{ valid: boolean; error?: string }> {
  // Use queue() for clean output extraction
  const result = await conn.queue(
    'IF HASNODE AND SHIP:ORBIT:HASNEXTPATCH { ' +
    '  SET np TO SHIP:ORBIT:NEXTPATCH. ' +
    '  IF np:TRANSITION = "ENCOUNTER" OR np:TRANSITION = "ESCAPE" { ' +
    '    PRINT NEXTNODE:ETA + "|" + (np:STARTTIME - TIME:SECONDS). ' +
    '  } ELSE { PRINT "OK". } ' +
    '} ELSE { PRINT "OK". }',
    3000
  );

  console.log(`[${toolName}] validateNodeInCurrentPatch output: ${result.output}`);

  // Parse "nodeEta|timeToSOI" format - clean output from queue()
  const parts = result.output.split('|');
  if (parts.length >= 2 && result.output !== 'OK') {
    const nodeEta = Number.parseFloat(parts[0]);
    const timeToSOI = Number.parseFloat(parts[1]);

    console.log(`[${toolName}] nodeEta=${nodeEta}s, timeToSOI=${timeToSOI}s, nodeAfterSOI=${nodeEta > timeToSOI}`);

    if (nodeEta > timeToSOI) {
      // Node is beyond current patch - clear it
      await conn.raw('REMOVE NEXTNODE.', 2000);
      console.log(`[${toolName}] Node was ${Math.round(nodeEta - timeToSOI)}s past SOI change - REMOVED`);
      return {
        valid: false,
        error: `${toolName} planning resulted in a maneuver beyond the current patch.\n` +
               `Node was ${Math.round(nodeEta - timeToSOI)}s past SOI change. Node has been removed.`,
      };
    }
  } else {
    console.log(`[${toolName}] No patch check needed (output was OK or no match)`);
  }

  return { valid: true };
}

/**
 * Execute a maneuver planning command and return the result with node info
 *
 * @param conn kOS connection
 * @param cmd kOS command to execute
 * @param timeout Command timeout in ms
 * @param toolName Optional tool name - if provided, validates node is in current patch
 */
export async function executeManeuverCommand(
  conn: KosConnection,
  cmd: string,
  timeout = 10_000,
  toolName?: string
): Promise<ManeuverResult> {
  if (toolName) {
    console.log(`[${toolName}] executeManeuverCommand starting`);
  }

  // Rewrite "PRINT PLANNER:OP(args)." to "LOCAL _mjr IS PLANNER:OP(args). WAIT 0.5. PRINT _mjr."
  // MechJeb planner operations need a brief delay before result is ready
  const rewrittenCmd = cmd.replace(
    /PRINT (PLANNER:[A-Z]+\([^)]*\))\./,
    'LOCAL _mjr IS $1. WAIT 0.5. PRINT _mjr.'
  );

  const result = await conn.queue(rewrittenCmd, timeout);

  const success = result.success && result.output.includes('True');
  if (!success) {
    if (toolName) {
      console.log(`[${toolName}] Planning failed: ${result.output}`);
    }
    return { success: false, error: sanitizeError(result.output) };
  }

  // Validate node is in current patch if toolName provided
  if (toolName) {
    console.log(`[${toolName}] Planning succeeded, validating patch...`);
    const patchValidation = await validateNodeInCurrentPatch(conn, toolName);
    if (!patchValidation.valid) {
      return { success: false, error: patchValidation.error };
    }
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
  // Use queue() for clean output - check if target exists and get its type
  const targetCheck = await conn.queue(
    'IF HASTARGET { PRINT TARGET:NAME + "|" + TARGET:TYPENAME. } ELSE { PRINT "NOTGT". }',
    3000
  );

  if (!targetCheck.success || targetCheck.output === 'NOTGT') {
    return null;
  }

  // Parse "name|type" format - clean output from queue()
  const parts = targetCheck.output.split('|');
  if (parts.length < 2) {
    return null;
  }

  const targetName = parts[0].trim();
  const targetType = parts[1].toLowerCase();

  if (targetType === 'body') {
    // Use queue() for clean output - query body-specific encounter info
    const bodyInfo = await conn.queue(
      'LOCAL encPe IS -999. LOCAL encEta IS -1. ' +
      'IF HASNODE AND NEXTNODE:ORBIT:HASNEXTPATCH { ' +
        'SET encPe TO ROUND(NEXTNODE:ORBIT:NEXTPATCH:PERIAPSIS). ' +
        'SET encEta TO ROUND(NEXTNODE:ETA + NEXTNODE:ORBIT:NEXTPATCH:ETA:PERIAPSIS). ' +
      '} ELSE IF ORBIT:HASNEXTPATCH { ' +
        'SET encPe TO ROUND(ORBIT:NEXTPATCH:PERIAPSIS). ' +
        'SET encEta TO ROUND(ORBIT:NEXTPATCH:ETA:PERIAPSIS). ' +
      '} ' +
      'PRINT encPe + "|" + encEta + "|" + TARGET:ATM:HEIGHT.',
      5000
    );

    // Parse "encPe|encEta|atmHeight" format - clean output from queue()
    const bodyParts = bodyInfo.output.split('|');
    if (bodyParts.length < 3) {
      return { targetType: 'body', targetName };
    }

    const encPe = parseNumber(bodyParts[0]);
    const encEta = parseNumber(bodyParts[1]);

    return {
      targetType: 'body',
      targetName,
      periapsisInTargetSOI: encPe != null && encPe > -999 ? encPe : undefined,
      timeToClosestApproach: encEta != null && encEta > 0 ? encEta : undefined,
      atmosphereHeight: parseNumber(bodyParts[2]),
    };
  } else {
    // Use queue() for clean output - query vessel-specific encounter info
    const vesselInfo = await conn.queue(
      'PRINT ADDONS:MJ:INFO:CADIST + "|" + ADDONS:MJ:INFO:TCA + "|" + ADDONS:MJ:INFO:CAREL.',
      3000
    );

    // Parse "dist|time|relVel" format - clean output from queue()
    const vesselParts = vesselInfo.output.split('|');
    if (vesselParts.length < 3) {
      return { targetType: 'vessel', targetName };
    }

    return {
      targetType: 'vessel',
      targetName,
      closestApproachDistance: parseDistanceString(vesselParts[0]),
      timeToClosestApproach: parseTimeString(vesselParts[1]),
      closestApproachRelVel: parseVelocityString(vesselParts[2]),
    };
  }
}

/**
 * Format the current orbit info for tool output.
 * Shows body, apoapsis, periapsis, and whether orbit is circular.
 *
 * @param conn kOS connection
 * @returns Formatted string like "\nOrbit: 100km by 80km at Kerbin (circular)"
 */
export async function formatResultingOrbit(conn: KosConnection): Promise<string> {
  try {
    // Use queue() for clean output extraction
    const orbitInfo = await conn.queue(
      'PRINT SHIP:BODY:NAME + "|" + ROUND(APOAPSIS/1000) + "|" + ROUND(PERIAPSIS/1000) + "|" + ROUND(ORBIT:ECCENTRICITY, 4).',
      3000
    );

    if (!orbitInfo.success) return '';

    // Parse "body|apoKm|peKm|ecc" format - clean output from queue()
    const parts = orbitInfo.output.split('|').map(s => s.trim());
    if (parts.length >= 4) {
      const [body, apoKm, peKm, ecc] = parts;

      const apoNum = Number.parseFloat(apoKm);
      const peNum = Number.parseFloat(peKm);
      const eccNum = Number.parseFloat(ecc);
      if (isNaN(apoNum) || isNaN(peNum) || isNaN(eccNum)) {
        return '';
      }

      const isCircular = eccNum < 0.05;
      return `\nOrbit: ${apoNum}km by ${peNum}km at ${body}${isCircular ? ' (circular)' : ''}`;
    }
  } catch {
    // Ignore errors - best effort
  }
  return '';
}

/**
 * Check if post-burn periapsis would result in crash or reentry.
 * Call this after creating a maneuver node to warn about dangerous trajectories.
 *
 * @param conn kOS connection
 * @param logger Optional logger for debugging
 * @returns Warning string if dangerous, undefined if safe
 */
export async function checkPostBurnPeriapsis(conn: KosConnection, logger?: McpLogger): Promise<string | undefined> {
  try {
    // Use queue() for clean output extraction
    const result = await conn.queue(
      'IF HASNODE { ' +
      'LOCAL atmH IS CHOOSE SHIP:BODY:ATM:HEIGHT IF SHIP:BODY:ATM:EXISTS ELSE 0. ' +
      'PRINT ROUND(NEXTNODE:ORBIT:PERIAPSIS) + "|" + ROUND(atmH) + "|" + SHIP:BODY:NAME. ' +
      '} ELSE { PRINT "NONODE". }',
      3000
    );

    logger?.info(`[checkPostBurnPeriapsis] Output: ${result.output}`);

    if (!result.success || result.output === 'NONODE') {
      return undefined;
    }

    // Parse "pe|atmH|bodyName" format - clean output from queue()
    const parts = result.output.split('|');
    if (parts.length < 3) {
      logger?.warn(`[checkPostBurnPeriapsis] Failed to parse output: ${result.output}`);
      return undefined;
    }

    const postBurnPe = Number.parseInt(parts[0]);
    const atmHeight = Number.parseInt(parts[1]);
    const bodyName = parts[2].trim();

    logger?.info(`[checkPostBurnPeriapsis] PostBurnPe=${postBurnPe}, atmHeight=${atmHeight}, body=${bodyName}`);

    if (postBurnPe < 0) {
      return `⚠️ CRASH WARNING: Post-burn periapsis ${(postBurnPe / 1000).toFixed(1)}km below ${bodyName} surface!`;
    } else if (atmHeight > 0 && postBurnPe < atmHeight) {
      return `⚠️ REENTRY WARNING: Post-burn periapsis ${(postBurnPe / 1000).toFixed(1)}km below ${bodyName} atmosphere (${(atmHeight / 1000).toFixed(0)}km)!`;
    }

    return undefined;
  } catch (error) {
    logger?.error(`[checkPostBurnPeriapsis] Error: ${error}`);
    return undefined;
  }
}
