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
 * Optimized: max 2 queries for typical maneuver scenarios
 */
export interface ShipTelemetryOptions {
  /**
   * Timeout for each telemetry command (ms).
   */
  timeoutMs?: number;
}

// Separator for inline PRINT values
const SEP = '|~|';

export async function getShipTelemetry(
  conn: KosConnection,
  options: ShipTelemetryOptions = {}
): Promise<string> {
  const { timeoutMs = 2500 } = options;
  const lines: string[] = [];

  // Query 1: Combined base + orbital params + node check + encounter check
  // This single query gets everything we need to know what additional data to fetch
  const baseResult = await conn.execute(
    'IF HASNODE { ' +
      `PRINT "BASE|" + SHIP:ORBIT:BODY:NAME + "${SEP}" + ROUND(APOAPSIS) + "${SEP}" + ROUND(PERIAPSIS) + "${SEP}" + ROUND(ORBIT:PERIOD) + "${SEP}" + ROUND(ORBIT:INCLINATION,2) + "${SEP}" + ROUND(ORBIT:ECCENTRICITY,4) + "${SEP}" + ROUND(ORBIT:LAN,2) + "${SEP}" + NEXTNODE:DELTAV:MAG + "${SEP}" + NEXTNODE:ETA + "${SEP}" + NEXTNODE:ORBIT:HASNEXTPATCH. ` +
    '} ELSE { ' +
      `PRINT "BASE|" + SHIP:ORBIT:BODY:NAME + "${SEP}" + ROUND(APOAPSIS) + "${SEP}" + ROUND(PERIAPSIS) + "${SEP}" + ROUND(ORBIT:PERIOD) + "${SEP}" + ROUND(ORBIT:INCLINATION,2) + "${SEP}" + ROUND(ORBIT:ECCENTRICITY,4) + "${SEP}" + ROUND(ORBIT:LAN,2) + "${SEP}0${SEP}0${SEP}" + ORBIT:HASNEXTPATCH. ` +
    '}',
    timeoutMs
  );

  if (baseResult.error) {
    return `Telemetry error: ${baseResult.error}`;
  }

  // Parse "BASE|soi|apo|per|period|inc|ecc|lan|dv|eta|hasEnc"
  // Note: ETA can be negative if node is in the past, deltaV is always positive
  const baseMatch = baseResult.output.match(/BASE\|([^|]+)\|~\|(-?[\d.]+)\|~\|(-?[\d.]+)\|~\|([\d.]+)\|~\|([\d.]+)\|~\|([\d.]+)\|~\|([\d.]+)\|~\|([\d.]+)\|~\|(-?[\d.]+)\|~\|(True|False)/i);
  if (!baseMatch) {
    // Include raw output for debugging parse failures
    const preview = baseResult.output.slice(0, 200);
    return `Telemetry error: parse failed. Raw: ${preview}`;
  }

  const soi = baseMatch[1].replaceAll(/^Body\(|\)$/g, '').replaceAll('"', '');
  const apo = parseNumber(baseMatch[2]);
  const per = parseNumber(baseMatch[3]);
  const period = parseNumber(baseMatch[4]);
  const inc = parseNumber(baseMatch[5]);
  const ecc = parseNumber(baseMatch[6]);
  const lan = parseNumber(baseMatch[7]);
  const nodeDv = parseNumber(baseMatch[8]);
  const nodeEta = parseNumber(baseMatch[9]);
  const hasEncounter = parseBool(baseMatch[10]);
  const hasNode = nodeDv > 0;

  lines.push('=== Ship Status ===', `SOI: ${soi}`);
  lines.push(`Apoapsis: ${(apo / 1000).toFixed(1)} km`);
  lines.push(`Periapsis: ${(per / 1000).toFixed(1)} km`);
  lines.push(`Period: ${period.toFixed(0)}s | Inc: ${inc.toFixed(1)}° | Ecc: ${ecc.toFixed(4)} | LAN: ${lan.toFixed(1)}°`);

  if (hasNode) {
    const estimatedBurnTime = nodeDv / (1.5 * 9.81);
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

        lines.push('', '=== Encounter ===', `Target: ${encounterBody}`);
        lines.push(`Periapsis: ${(encounterPe / 1000).toFixed(1)} km`);
      }
    }
  }

  return lines.join('\n');
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
