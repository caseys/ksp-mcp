/**
 * MechJeb Telemetry Wrappers
 *
 * Provides structured access to vessel state and MechJeb info
 */

import type { KosConnection } from '../../transport/kos-connection.js';
import type { VesselState, OrbitInfo, MechJebInfo } from '../types.js';
import type { TargetEncounterInfo, BodyEncounterInfo, VesselEncounterInfo } from './shared.js';
import { config } from '../../config/index.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const TELEMETRY_DELAY_MS = 100;

/**
 * Parse a numeric value from kOS output
 * Returns 0 if input is undefined, null, or doesn't contain a number
 */
function parseNumber(output: string | undefined | null): number {
  if (!output) return 0;
  const match = output.match(/-?[\d.]+(?:E[+-]?\d+)?/i);
  return match ? Number.parseFloat(match[0]) : 0;
}

/**
 * Safely check if a string contains 'true' (case-insensitive)
 * Returns false if input is undefined or null
 */
function parseBool(output: string | undefined | null): boolean {
  if (!output) return false;
  return output.toLowerCase().includes('true');
}

/**
 * Query multiple values in a batch (comma-separated)
 * Returns array of numbers in order
 */
async function queryNumbers(
  conn: KosConnection,
  suffixes: string[],
  timeoutMs: number = config.timeouts.command
): Promise<number[]> {
  const expr = suffixes.map(s => s).join(' + "," + ');
  const result = await conn.execute(`PRINT ${expr}.`, timeoutMs);

  // Parse comma-separated values
  // Note: output includes command echo which may contain commas, so take only last N values
  const allParts = result.output.split(',');
  const valueParts = allParts.slice(-suffixes.length);
  const values = valueParts.map(s => parseNumber(s.trim()));
  return values;
}

/**
 * Get current vessel state from MechJeb
 */
export async function getVesselState(conn: KosConnection): Promise<VesselState> {
  // Query in batches to reduce round trips
  const [altTrue, altASL, speedSurf, speedOrb, speedVert] = await queryNumbers(conn, [
    'ADDONS:MJ:VESSEL:ALTITUDETRUE',
    'ADDONS:MJ:VESSEL:ALTITUDEASL',
    'ADDONS:MJ:VESSEL:SPEEDSURFACE',
    'ADDONS:MJ:VESSEL:SPEEDORBITAL',
    'ADDONS:MJ:VESSEL:SPEEDVERTICAL'
  ]);

  await delay(TELEMETRY_DELAY_MS);
  const [heading, pitch, roll] = await queryNumbers(conn, [
    'ADDONS:MJ:VESSEL:VESSELHEADING',
    'ADDONS:MJ:VESSEL:VESSELPITCH',
    'ADDONS:MJ:VESSEL:VESSELROLL'
  ]);

  await delay(TELEMETRY_DELAY_MS);
  const [dynPressure, aoa, mach] = await queryNumbers(conn, [
    'ADDONS:MJ:VESSEL:DYNAMICPRESSURE',
    'ADDONS:MJ:VESSEL:AOA',
    'ADDONS:MJ:VESSEL:MACH'
  ]);

  await delay(TELEMETRY_DELAY_MS);
  const [lat, lon] = await queryNumbers(conn, [
    'ADDONS:MJ:VESSEL:LATITUDE',
    'ADDONS:MJ:VESSEL:LONGITUDE'
  ]);

  return {
    altitudeTrue: altTrue,
    altitudeASL: altASL,
    latitude: lat,
    longitude: lon,
    speedSurface: speedSurf,
    speedOrbital: speedOrb,
    speedVertical: speedVert,
    heading,
    pitch,
    roll,
    dynamicPressure: dynPressure,
    angleOfAttack: aoa,
    mach
  };
}

/**
 * Get orbital parameters using native kOS (more reliable than MechJeb VESSEL suffixes)
 */
export async function getOrbitInfo(conn: KosConnection): Promise<OrbitInfo> {
  const [apo, per, period, inc, ecc, lan] = await queryNumbers(conn, [
    'APOAPSIS',
    'PERIAPSIS',
    'ORBIT:PERIOD',
    'ORBIT:INCLINATION',
    'ORBIT:ECCENTRICITY',
    'ORBIT:LAN'
  ]);

  return {
    apoapsis: apo,
    periapsis: per,
    period,
    inclination: inc,
    eccentricity: ecc,
    lan
  };
}

/**
 * Safely query a single value, returning 0 on error
 */
async function safeQueryNumber(conn: KosConnection, suffix: string): Promise<number> {
  try {
    const result = await conn.execute(`PRINT ${suffix}.`, 2000);
    if (result.error) return 0;
    return parseNumber(result.output);
  } catch {
    return 0;
  }
}

/**
 * Get MechJeb info values (TWR, delta-V, etc.)
 * Note: These queries might fail depending on addon version
 */
export async function getMechJebInfo(conn: KosConnection): Promise<MechJebInfo> {
  // Query each value individually with error handling
  const surfTwr = await safeQueryNumber(conn, 'ADDONS:MJ:INFO:SURFACETWR');
  await delay(TELEMETRY_DELAY_MS);
  const localTwr = await safeQueryNumber(conn, 'ADDONS:MJ:INFO:LOCALTWR');
  await delay(TELEMETRY_DELAY_MS);
  const thrust = await safeQueryNumber(conn, 'ADDONS:MJ:INFO:CURRENTTHRUST');
  await delay(TELEMETRY_DELAY_MS);
  const maxThrust = await safeQueryNumber(conn, 'ADDONS:MJ:INFO:MAXTHRUST');
  await delay(TELEMETRY_DELAY_MS);
  const accel = await safeQueryNumber(conn, 'ADDONS:MJ:INFO:ACCELERATION');

  // Optional values
  await delay(TELEMETRY_DELAY_MS);
  const nextNodeDeltaV = await safeQueryNumber(conn, 'ADDONS:MJ:INFO:NEXTMANEUVERNODEDELTAV') || undefined;
  await delay(TELEMETRY_DELAY_MS);
  const timeToNode = await safeQueryNumber(conn, 'ADDONS:MJ:INFO:TIMETOMANEUVERNODE') || undefined;
  await delay(TELEMETRY_DELAY_MS);
  const timeToImpact = await safeQueryNumber(conn, 'ADDONS:MJ:INFO:TIMETOIMPACT') || undefined;
  await delay(TELEMETRY_DELAY_MS);
  const escapeVel = await safeQueryNumber(conn, 'ADDONS:MJ:INFO:ESCAPEVELOCITY') || undefined;

  return {
    surfaceTWR: surfTwr,
    localTWR: localTwr,
    currentThrust: thrust,
    maxThrust: maxThrust,
    acceleration: accel,
    nextNodeDeltaV: nextNodeDeltaV === 0 ? undefined : nextNodeDeltaV,
    timeToManeuverNode: timeToNode === 0 ? undefined : timeToNode,
    timeToImpact: timeToImpact === 0 ? undefined : timeToImpact,
    escapeVelocity: escapeVel === 0 ? undefined : escapeVel
  };
}

/**
 * Quick query for basic flight data (minimal latency)
 */
export async function getQuickStatus(conn: KosConnection): Promise<{
  altitude: number;
  apoapsis: number;
  periapsis: number;
  speed: number;
}> {
  // Use native kOS for minimal latency
  const [alt, apo, per, spd] = await queryNumbers(conn, [
    'ALTITUDE',
    'APOAPSIS',
    'PERIAPSIS',
    'VELOCITY:SURFACE:MAG'
  ]);

  return {
    altitude: alt,
    apoapsis: apo,
    periapsis: per,
    speed: spd
  };
}

/**
 * Format time in seconds to human-readable format
 */
function formatTime(seconds: number): string {
  if (seconds < 0) return '(past)';
  if (seconds < 60) return `${Math.floor(seconds)}s`;

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  return hours > 0 ? `${hours}h ${minutes}m ${secs}s` : `${minutes}m ${secs}s`;
}

/**
 * Ship telemetry for operation outputs
 * Optimized: max 3 queries for typical maneuver scenarios
 */
export interface ShipTelemetryOptions {
  /**
   * Timeout for each telemetry command (ms).
   */
  timeoutMs?: number;
}

/**
 * Structured vessel information
 */
export interface VesselInfo {
  name: string;
  type: string;
  status: string;
}

/**
 * Structured orbit information
 */
export interface OrbitTelemetry {
  body: string;
  apoapsis: number;
  periapsis: number;
  period: number;
  inclination: number;
  eccentricity: number;
  lan: number;
}

/**
 * Structured maneuver node information
 */
export interface ManeuverInfo {
  deltaV: number;
  timeToNode: number;
  estimatedBurnTime: number;
}

/**
 * Structured encounter information
 */
export interface EncounterInfo {
  body: string;
  periapsis: number;
}

/**
 * Structured target information
 */
export interface TargetInfo {
  name: string;
  type: string;
  distance: number;
}

/**
 * Available targets for navigation
 */
export interface AvailableTargets {
  bodies: string[];
  vessels: string[];
}

/**
 * Complete ship telemetry with structured data and formatted output
 */
export interface ShipTelemetry {
  vessel: VesselInfo;
  orbit: OrbitTelemetry;
  maneuver?: ManeuverInfo;
  encounter?: EncounterInfo;
  target?: TargetInfo;
  availableTargets: AvailableTargets;
  /** Human-readable formatted output */
  formatted: string;
}

// Separator for inline PRINT values
const SEP = '|~|';

/**
 * Format distance for human-readable output
 */
function formatDistance(meters: number): string {
  if (meters >= 1_000_000) {
    return `${(meters / 1_000_000).toFixed(2)} Mm`;
  } else if (meters >= 1000) {
    return `${(meters / 1000).toFixed(1)} km`;
  } else {
    return `${meters.toFixed(0)} m`;
  }
}

/**
 * Get structured ship telemetry with formatted output.
 *
 * Returns structured data for programmatic use plus a human-readable formatted string.
 */
export async function getShipTelemetry(
  conn: KosConnection,
  options: ShipTelemetryOptions = {}
): Promise<ShipTelemetry> {
  const { timeoutMs = 2500 } = options;
  const lines: string[] = [];

  // Query 1: Combined base + orbital params + vessel info + node check + encounter check
  // This single query gets everything we need to know what additional data to fetch
  // Note: On escape trajectories (ecc >= 1), APOAPSIS and PERIOD are infinity which breaks ROUND()
  // We use CHOOSE to output -1 as a sentinel value for these cases
  const baseResult = await conn.execute(
    'IF HASNODE { ' +
      `PRINT "BASE|" + SHIP:ORBIT:BODY:NAME + "${SEP}" + (CHOOSE -1 IF ORBIT:ECCENTRICITY >= 1 ELSE ROUND(APOAPSIS)) + "${SEP}" + ROUND(PERIAPSIS) + "${SEP}" + (CHOOSE -1 IF ORBIT:ECCENTRICITY >= 1 ELSE ROUND(ORBIT:PERIOD)) + "${SEP}" + ROUND(ORBIT:INCLINATION,2) + "${SEP}" + ROUND(ORBIT:ECCENTRICITY,4) + "${SEP}" + ROUND(ORBIT:LAN,2) + "${SEP}" + SHIP:NAME + "${SEP}" + SHIP:TYPE + "${SEP}" + SHIP:STATUS + "${SEP}" + NEXTNODE:DELTAV:MAG + "${SEP}" + NEXTNODE:ETA + "${SEP}" + NEXTNODE:ORBIT:HASNEXTPATCH. ` +
    '} ELSE { ' +
      `PRINT "BASE|" + SHIP:ORBIT:BODY:NAME + "${SEP}" + (CHOOSE -1 IF ORBIT:ECCENTRICITY >= 1 ELSE ROUND(APOAPSIS)) + "${SEP}" + ROUND(PERIAPSIS) + "${SEP}" + (CHOOSE -1 IF ORBIT:ECCENTRICITY >= 1 ELSE ROUND(ORBIT:PERIOD)) + "${SEP}" + ROUND(ORBIT:INCLINATION,2) + "${SEP}" + ROUND(ORBIT:ECCENTRICITY,4) + "${SEP}" + ROUND(ORBIT:LAN,2) + "${SEP}" + SHIP:NAME + "${SEP}" + SHIP:TYPE + "${SEP}" + SHIP:STATUS + "${SEP}0${SEP}0${SEP}" + ORBIT:HASNEXTPATCH. ` +
    '}',
    timeoutMs
  );

  if (baseResult.error) {
    throw new Error(`Telemetry error: ${baseResult.error}`);
  }

  // Parse "BASE|soi|apo|per|period|inc|ecc|lan|name|type|status|dv|eta|hasEnc"
  // Note: ETA can be negative if node is in the past, deltaV is always positive
  // Note: SHIP:NAME can contain spaces/special chars, SHIP:TYPE and SHIP:STATUS are single words
  const baseMatch = baseResult.output.match(/BASE\|([^|]+)\|~\|(-?[\d.]+)\|~\|(-?[\d.]+)\|~\|([\d.]+)\|~\|([\d.]+)\|~\|([\d.]+)\|~\|([\d.]+)\|~\|([^|]+)\|~\|([^|]+)\|~\|([^|]+)\|~\|([\d.]+)\|~\|(-?[\d.]+)\|~\|(True|False)/i);
  if (!baseMatch) {
    // Include raw output for debugging parse failures
    const preview = baseResult.output.slice(0, 200);
    throw new Error(`Telemetry error: parse failed. Raw: ${preview}`);
  }

  const soi = baseMatch[1].replaceAll(/^Body\(|\)$/g, '').replaceAll('"', '');
  const apoRaw = parseNumber(baseMatch[2]);
  const per = parseNumber(baseMatch[3]);
  const periodRaw = parseNumber(baseMatch[4]);
  const inc = parseNumber(baseMatch[5]);
  const ecc = parseNumber(baseMatch[6]);
  const lan = parseNumber(baseMatch[7]);
  const vesselName = baseMatch[8].trim().replaceAll('"', '');
  const vesselType = baseMatch[9].trim();
  const vesselStatus = baseMatch[10].trim();
  const nodeDv = parseNumber(baseMatch[11]);
  const nodeEta = parseNumber(baseMatch[12]);
  const hasEncounter = parseBool(baseMatch[13]);
  const hasNode = nodeDv > 0;

  // Handle escape trajectory sentinel values (-1 means infinity)
  const isEscapeTrajectory = apoRaw < 0 || periodRaw < 0;
  const apo = isEscapeTrajectory ? Infinity : apoRaw;
  const period = isEscapeTrajectory ? Infinity : periodRaw;

  // Build structured data
  const vessel: VesselInfo = {
    name: vesselName,
    type: vesselType,
    status: vesselStatus,
  };

  const orbit: OrbitTelemetry = {
    body: soi,
    apoapsis: apo,
    periapsis: per,
    period,
    inclination: inc,
    eccentricity: ecc,
    lan,
  };

  let maneuver: ManeuverInfo | undefined;
  let encounter: EncounterInfo | undefined;
  let target: TargetInfo | undefined;

  // Build formatted output
  lines.push('=== Ship Status ===');
  lines.push(`Vessel: ${vesselName} (${vesselType}) - ${vesselStatus}`);
  lines.push(`SOI: ${soi}`);
  lines.push(`Apoapsis: ${isEscapeTrajectory ? 'Escape' : `${(apo / 1000).toFixed(1)} km`}`);
  lines.push(`Periapsis: ${(per / 1000).toFixed(1)} km`);
  lines.push(`Period: ${isEscapeTrajectory ? 'N/A' : `${period.toFixed(0)}s`} | Inc: ${inc.toFixed(1)}° | Ecc: ${ecc.toFixed(4)} | LAN: ${lan.toFixed(1)}°`);

  if (hasNode) {
    const estimatedBurnTime = nodeDv / (1.5 * 9.81);
    maneuver = {
      deltaV: nodeDv,
      timeToNode: nodeEta,
      estimatedBurnTime,
    };
    lines.push('', '=== Next Maneuver ===');
    lines.push(`Delta-V: ${nodeDv.toFixed(1)} m/s`);
    lines.push(`Time to node: ${formatTime(nodeEta)}`);
    lines.push(`Est. burn time: ${formatTime(estimatedBurnTime)}`);
  }

  // Query 2: Get encounter details (only if there's an encounter)
  if (hasEncounter) {
    const encResult = await conn.execute(
      'IF HASNODE AND NEXTNODE:ORBIT:HASNEXTPATCH { ' +
        `PRINT "ENC|" + NEXTNODE:ORBIT:NEXTPATCH:BODY:NAME + "${SEP}" + ROUND(NEXTNODE:ORBIT:NEXTPATCH:PERIAPSIS). ` +
      '} ELSE IF ORBIT:HASNEXTPATCH { ' +
        `PRINT "ENC|" + ORBIT:NEXTPATCH:BODY:NAME + "${SEP}" + ROUND(ORBIT:NEXTPATCH:PERIAPSIS). ` +
      '} ELSE { PRINT "NOENC". }',
      timeoutMs
    );

    if (!encResult.error && !encResult.output.includes('NOENC')) {
      const encMatch = encResult.output.match(/ENC\|([^|]+)\|~\|(-?[\d.]+)/);
      if (encMatch) {
        const encounterBody = encMatch[1].replaceAll(/^Body\(|\)$/g, '').replaceAll('"', '');
        const encounterPe = parseNumber(encMatch[2]);

        encounter = {
          body: encounterBody,
          periapsis: encounterPe,
        };

        lines.push('', '=== Encounter ===', `Target: ${encounterBody}`);
        lines.push(`Periapsis: ${(encounterPe / 1000).toFixed(1)} km`);
      }
    }
  }

  // Query 3: Get target info (if a target is set)
  const targetResult = await conn.execute(
    'IF HASTARGET { ' +
      `PRINT "TGT|" + TARGET:NAME + "${SEP}" + TARGET:TYPENAME + "${SEP}" + ROUND(TARGET:DISTANCE). ` +
    '} ELSE { PRINT "NOTGT". }',
    timeoutMs
  );

  if (!targetResult.error && !targetResult.output.includes('NOTGT')) {
    const tgtMatch = targetResult.output.match(/TGT\|([^|]+)\|~\|([^|]+)\|~\|(-?[\d.]+)/);
    if (tgtMatch) {
      const targetName = tgtMatch[1].replaceAll(/^Body\(|\)$/g, '').replaceAll('"', '').trim();
      const targetType = tgtMatch[2].trim();
      const targetDist = parseNumber(tgtMatch[3]);

      target = {
        name: targetName,
        type: targetType,
        distance: targetDist,
      };

      lines.push('', '=== Target ===');
      lines.push(`${targetName} (${targetType})`);
      lines.push(`Distance: ${formatDistance(targetDist)}`);
    }
  }

  // Query 4: Get available targets (bodies and vessels)
  // Use BODY|name|0 format - the trailing |0 acts as sentinel to avoid matching command echo
  const availableTargets: AvailableTargets = { bodies: [], vessels: [] };
  const targetsResult = await conn.execute(
    'LIST BODIES IN bods. LIST TARGETS IN tgts. ' +
    'FOR b IN bods { PRINT "BODY|" + b:NAME + "|0". } ' +
    'FOR t IN tgts { IF t <> SHIP AND t:BODY = SHIP:BODY { PRINT "VESSEL|" + t:NAME + "|0". } } ' +
    'PRINT "LIST_DONE".',
    timeoutMs
  );

  if (!targetsResult.error) {
    // Parse body names - BODY|name|0 pattern (sentinel |0 avoids command echo)
    const bodyMatches = targetsResult.output.matchAll(/BODY\|([^|]+)\|0/g);
    for (const m of bodyMatches) {
      availableTargets.bodies.push(m[1].trim());
    }
    // Parse vessel names - VESSEL|name|0 pattern
    const vesselMatches = targetsResult.output.matchAll(/VESSEL\|([^|]+)\|0/g);
    for (const m of vesselMatches) {
      availableTargets.vessels.push(m[1].trim());
    }

    lines.push('', '=== Available Targets ===');
    lines.push(`Bodies: ${availableTargets.bodies.join(', ')}`);
    if (availableTargets.vessels.length > 0) {
      lines.push(`Vessels: ${availableTargets.vessels.join(', ')}`);
    }
  }

  return {
    vessel,
    orbit,
    maneuver,
    encounter,
    target,
    availableTargets,
    formatted: lines.join('\n'),
  };
}

/**
 * Format target encounter info for display in tool outputs.
 *
 * @param info Target encounter info from queryTargetEncounterInfo
 * @returns Formatted string with target-specific details
 */
export function formatTargetEncounterInfo(info: TargetEncounterInfo): string {
  const lines: string[] = [];

  if (info.targetType === 'body') {
    const bodyInfo = info as BodyEncounterInfo;
    const atmHeight = bodyInfo.atmosphereHeight ?? 0;

    // Check for crash trajectory (negative periapsis = below surface)
    const isCrash = bodyInfo.periapsisInTargetSOI !== undefined && bodyInfo.periapsisInTargetSOI < 0;
    // Check for reentry trajectory (periapsis below atmosphere but above surface)
    const isReentry = !isCrash && atmHeight > 0 &&
      bodyInfo.periapsisInTargetSOI !== undefined &&
      bodyInfo.periapsisInTargetSOI < atmHeight;

    if (isCrash) {
      lines.push('⚠️ CRASH TRAJECTORY');
    } else if (isReentry) {
      lines.push('⚠️ REENTRY TRAJECTORY');
    }
    lines.push(`=== ${bodyInfo.targetName} Encounter ===`);

    if (bodyInfo.periapsisInTargetSOI !== undefined) {
      const peKm = bodyInfo.periapsisInTargetSOI / 1000;
      if (isCrash) {
        lines.push(`Periapsis: ${peKm.toFixed(1)} km (below surface!)`);
      } else if (isReentry) {
        lines.push(`Periapsis: ${peKm.toFixed(1)} km (in atmosphere)`);
      } else {
        lines.push(`Periapsis: ${peKm.toFixed(1)} km`);
      }
    }

    if (bodyInfo.timeToClosestApproach !== undefined) {
      if (isCrash) {
        lines.push(`Time to impact: ${formatTime(bodyInfo.timeToClosestApproach)}`);
      } else if (isReentry) {
        lines.push(`Time to reentry: ${formatTime(bodyInfo.timeToClosestApproach)}`);
      } else {
        lines.push(`Time to closest approach: ${formatTime(bodyInfo.timeToClosestApproach)}`);
      }
    }

    if (bodyInfo.captureDeltaV !== undefined && !isCrash && !isReentry) {
      lines.push(`Capture ΔV: ${bodyInfo.captureDeltaV.toFixed(1)} m/s`);
    } else if (isCrash) {
      lines.push(`Capture ΔV: N/A (no safe orbit)`);
    } else if (isReentry) {
      lines.push(`Capture ΔV: N/A (aerobraking trajectory)`);
    }
  } else {
    const vesselInfo = info as VesselEncounterInfo;

    lines.push(`=== Target: ${vesselInfo.targetName} ===`);

    if (vesselInfo.closestApproachDistance !== undefined) {
      const distKm = vesselInfo.closestApproachDistance / 1000;
      if (distKm < 1) {
        lines.push(`Closest approach: ${(vesselInfo.closestApproachDistance).toFixed(0)} m`);
      } else {
        lines.push(`Closest approach: ${distKm.toFixed(1)} km`);
      }
    }

    if (vesselInfo.timeToClosestApproach !== undefined) {
      lines.push(`Time to closest: ${formatTime(vesselInfo.timeToClosestApproach)}`);
    }

    if (vesselInfo.closestApproachRelVel !== undefined) {
      lines.push(`Rel. velocity at CA: ${vesselInfo.closestApproachRelVel.toFixed(1)} m/s`);
    }
  }

  return lines.join('\n');
}
