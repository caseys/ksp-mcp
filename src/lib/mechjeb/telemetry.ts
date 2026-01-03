/**
 * MechJeb Telemetry Wrappers
 *
 * Provides structured access to vessel state and MechJeb info
 */

import type { KosConnection } from '../../transport/kos-connection.js';
import type { VesselState, OrbitInfo, MechJebInfo } from '../types.js';
import type { TargetEncounterInfo, BodyEncounterInfo, VesselEncounterInfo } from './shared.js';
import { parseNumber } from './shared.js';
import { config } from '../../config/index.js';
import { ensureConnected } from '../../transport/connection-tools.js';
import { delay } from '../utils/progress.js';
import { formatTime, formatOrbit, fmtNum } from '../utils/format.js';

const TELEMETRY_DELAY_MS = 100;

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
 * Includes altitude and speed for convenience (supersedes getQuickStatus)
 */
export async function getOrbitInfo(conn: KosConnection): Promise<OrbitInfo> {
  const [apo, per, period, inc, ecc, lan, alt, spd] = await queryNumbers(conn, [
    'APOAPSIS',
    'PERIAPSIS',
    'ORBIT:PERIOD',
    'ORBIT:INCLINATION',
    'ORBIT:ECCENTRICITY',
    'ORBIT:LAN',
    'ALTITUDE',
    'VELOCITY:SURFACE:MAG'
  ]);

  return {
    apoapsis: apo,
    periapsis: per,
    period,
    inclination: inc,
    eccentricity: ecc,
    lan,
    altitude: alt,
    speed: spd
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
  moons: string[];
  planets: string[];
  vessels: string[];
}

/**
 * Complete ship telemetry with structured data and formatted output
 */
export interface ShipTelemetry {
  /** Whether kOS is connected and responding */
  connected: boolean;
  /** Error reason if not connected */
  reason?: string;
  vessel?: VesselInfo;
  orbit?: OrbitTelemetry;
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

  // Query 1: Combined base + orbital params + vessel info + node check + encounter check + surface info
  // This single query gets everything we need to know what additional data to fetch
  // Note: On escape trajectories (ecc >= 1), APOAPSIS and PERIOD are infinity which breaks ROUND()
  // We use CHOOSE to output -1 as a sentinel value for these cases
  // Note: Use CHOOSE to safely handle solar orbit (Sun has no parent body)
  // Added: altitude, latitude, longitude for surface status display
  const parentBodyExpr = '(CHOOSE "Sun" IF SHIP:BODY:NAME = "Sun" ELSE SHIP:BODY:BODY:NAME)';
  const baseResult = await conn.execute(
    'IF HASNODE { ' +
      `PRINT "BASE|" + SHIP:ORBIT:BODY:NAME + "${SEP}" + ${parentBodyExpr} + "${SEP}" + (CHOOSE -1 IF ORBIT:ECCENTRICITY >= 1 ELSE ROUND(APOAPSIS)) + "${SEP}" + ROUND(PERIAPSIS) + "${SEP}" + (CHOOSE -1 IF ORBIT:ECCENTRICITY >= 1 ELSE ROUND(ORBIT:PERIOD)) + "${SEP}" + ROUND(ORBIT:INCLINATION,2) + "${SEP}" + ROUND(ORBIT:ECCENTRICITY,4) + "${SEP}" + ROUND(ORBIT:LAN,2) + "${SEP}" + SHIP:NAME + "${SEP}" + SHIP:TYPE + "${SEP}" + SHIP:STATUS + "${SEP}" + NEXTNODE:DELTAV:MAG + "${SEP}" + NEXTNODE:ETA + "${SEP}" + NEXTNODE:ORBIT:HASNEXTPATCH + "${SEP}" + ROUND(ALTITUDE) + "${SEP}" + ROUND(SHIP:LATITUDE,4) + "${SEP}" + ROUND(SHIP:LONGITUDE,4). ` +
    '} ELSE { ' +
      `PRINT "BASE|" + SHIP:ORBIT:BODY:NAME + "${SEP}" + ${parentBodyExpr} + "${SEP}" + (CHOOSE -1 IF ORBIT:ECCENTRICITY >= 1 ELSE ROUND(APOAPSIS)) + "${SEP}" + ROUND(PERIAPSIS) + "${SEP}" + (CHOOSE -1 IF ORBIT:ECCENTRICITY >= 1 ELSE ROUND(ORBIT:PERIOD)) + "${SEP}" + ROUND(ORBIT:INCLINATION,2) + "${SEP}" + ROUND(ORBIT:ECCENTRICITY,4) + "${SEP}" + ROUND(ORBIT:LAN,2) + "${SEP}" + SHIP:NAME + "${SEP}" + SHIP:TYPE + "${SEP}" + SHIP:STATUS + "${SEP}0${SEP}0${SEP}" + ORBIT:HASNEXTPATCH + "${SEP}" + ROUND(ALTITUDE) + "${SEP}" + ROUND(SHIP:LATITUDE,4) + "${SEP}" + ROUND(SHIP:LONGITUDE,4). ` +
    '}',
    timeoutMs
  );

  if (baseResult.error) {
    throw new Error(`Telemetry error: ${baseResult.error}`);
  }

  // Parse "BASE|soi|soiParent|apo|per|period|inc|ecc|lan|name|type|status|dv|eta|hasEnc|alt|lat|lon"
  // Note: ETA can be negative if node is in the past, deltaV is always positive
  // Note: SHIP:NAME can contain spaces/special chars, SHIP:TYPE and SHIP:STATUS are single words
  const baseMatch = baseResult.output.match(/BASE\|([^|]+)\|~\|([^|]+)\|~\|(-?[\d.]+)\|~\|(-?[\d.]+)\|~\|([\d.]+)\|~\|([\d.]+)\|~\|([\d.]+)\|~\|([\d.]+)\|~\|([^|]+)\|~\|([^|]+)\|~\|([^|]+)\|~\|([\d.]+)\|~\|(-?[\d.]+)\|~\|(True|False)\|~\|(-?[\d.]+)\|~\|(-?[\d.]+)\|~\|(-?[\d.]+)/i);
  if (!baseMatch) {
    // Include raw output for debugging parse failures
    const preview = baseResult.output.slice(0, 200);
    throw new Error(`Telemetry error: parse failed. Raw: ${preview}`);
  }

  const soi = baseMatch[1].replaceAll(/^Body\(|\)$/g, '').replaceAll('"', '');
  const soiParent = baseMatch[2].replaceAll(/^Body\(|\)$/g, '').replaceAll('"', '');
  const apoRaw = parseNumber(baseMatch[3]);
  const per = parseNumber(baseMatch[4]);
  const periodRaw = parseNumber(baseMatch[5]);
  const inc = parseNumber(baseMatch[6]);
  const ecc = parseNumber(baseMatch[7]);
  const lan = parseNumber(baseMatch[8]);
  const vesselName = baseMatch[9].trim().replaceAll('"', '');
  const vesselType = baseMatch[10].trim();
  const vesselStatus = baseMatch[11].trim();
  const nodeDv = parseNumber(baseMatch[12]);
  const nodeEta = parseNumber(baseMatch[13]);
  const hasEncounter = parseBool(baseMatch[14]);
  const altitude = parseNumber(baseMatch[15]);
  const latitude = parseNumber(baseMatch[16]);
  const longitude = parseNumber(baseMatch[17]);
  const hasNode = nodeDv > 0;

  // Handle escape trajectory sentinel values (-1 means infinity)
  const isEscapeTrajectory = apoRaw < 0 || periodRaw === -1;
  const isImpactTrajectory = periodRaw < -1;
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
  // Show "a moon of [parent]" if SOI is a moon (parent is not Sun/Kerbol)
  const isMoon = soiParent.toLowerCase() !== 'sun' && soiParent.toLowerCase() !== 'kerbol';
  const soiDisplay = isMoon ? `${soi}, a moon of ${soiParent}` : soi;

  // Check if on surface (LANDED, SPLASHED, PRELAUNCH)
  const isSurface = ['LANDED', 'SPLASHED', 'PRELAUNCH'].includes(vesselStatus.toUpperCase());

  if (isSurface) {
    // Surface status format
    lines.push(`Ship: ${vesselStatus.toUpperCase()}`);
    lines.push(`Surface of: ${soiDisplay}`);
    const altKm = altitude / 1000;
    lines.push(`Altitude: ${altKm >= 1 ? altKm.toFixed(1) + 'km' : altitude.toFixed(0) + 'm'}`);
    lines.push(`Latitude: ${latitude.toFixed(4)}°`);
    lines.push(`Longitude: ${longitude.toFixed(4)}°`);
    lines.push(`Vessel: ${vesselName}`);
  } else {
    // Orbit status format
    lines.push(`Ship: ${vesselStatus.toUpperCase()}`);
    lines.push(`SOI Body: ${soiDisplay}`);
    // Orbit display (Ap by Pe format)
    if (isEscapeTrajectory || isImpactTrajectory) {
      const fmtAlt = (m: number) => { const km = m / 1000; return (km % 1 === 0 ? km.toFixed(0) : km.toFixed(1)) + 'km'; };
      const apoStr = isEscapeTrajectory ? 'Escape' : fmtAlt(apo);
      const peStr = isImpactTrajectory ? 'Impact' : fmtAlt(per);
      lines.push(`Orbit: ${apoStr} by ${peStr}`);
    } else {
      lines.push(`Orbit: ${formatOrbit(apo, per)}`);
    }
    lines.push(`Period: ${isEscapeTrajectory ? 'N/A' : formatTime(period)} | Inc: ${inc.toFixed(1)}° | Ecc: ${ecc.toFixed(4)} | LAN: ${lan.toFixed(1)}°`);
    lines.push(`Vessel: ${vesselName}`);
  }

  if (hasNode) {
    const estimatedBurnTime = nodeDv / (1.5 * 9.81);
    maneuver = {
      deltaV: nodeDv,
      timeToNode: nodeEta,
      estimatedBurnTime,
    };
    lines.push('', '=== Next Maneuver ===');
    lines.push(`Delta-V: ${fmtNum(nodeDv)} m/sec`);
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
  // For body targets, also get the parent body to show "A moon of X"
  const targetParentExpr = '(CHOOSE "Sun" IF TARGET:BODY:NAME = "Sun" ELSE TARGET:BODY:BODY:NAME)';
  const targetResult = await conn.execute(
    'IF HASTARGET { ' +
      'IF TARGET:TYPENAME = "Body" { ' +
        `PRINT "TGT|" + TARGET:NAME + "${SEP}" + TARGET:TYPENAME + "${SEP}" + ROUND(TARGET:DISTANCE) + "${SEP}" + ${targetParentExpr}. ` +
      '} ELSE { ' +
        `PRINT "TGT|" + TARGET:NAME + "${SEP}" + TARGET:TYPENAME + "${SEP}" + ROUND(TARGET:DISTANCE) + "${SEP}NONE". ` +
      '}. ' +
    '} ELSE { PRINT "NOTGT". }',
    timeoutMs
  );

  if (!targetResult.error && !targetResult.output.includes('NOTGT')) {
    const tgtMatch = targetResult.output.match(/TGT\|([^|]+)\|~\|([^|]+)\|~\|(-?[\d.]+)\|~\|([^\s]+)/);
    if (tgtMatch) {
      const targetName = tgtMatch[1].replaceAll(/^Body\(|\)$/g, '').replaceAll('"', '').trim();
      const targetType = tgtMatch[2].trim();
      const targetDist = parseNumber(tgtMatch[3]);
      const targetParent = tgtMatch[4].replaceAll(/^Body\(|\)$/g, '').replaceAll('"', '').trim();

      target = {
        name: targetName,
        type: targetType,
        distance: targetDist,
      };

      lines.push('', '=== Target ===');
      // Format target description based on type
      if (targetType === 'Body' && targetParent && targetParent !== 'NONE') {
        const isSun = targetParent.toLowerCase() === 'sun' || targetParent.toLowerCase() === 'kerbol';
        if (isSun) {
          lines.push(`${targetName} (Planet)`);
        } else {
          lines.push(`${targetName} (A moon of ${targetParent})`);
        }
      } else {
        lines.push(`${targetName} (${targetType})`);
      }
      lines.push(`Distance: ${formatDistance(targetDist)}`);
    }
  }

  // Query 4: Get available targets using listTargets()
  const availableTargets: AvailableTargets = { moons: [], planets: [], vessels: [] };
  try {
    const { listTargets } = await import('../kos/target/get-targets.js');
    const targets = await listTargets(conn);

    availableTargets.moons = targets.moons.map((m: { name: string }) => m.name);
    // Filter out the parent body from planets (it's shown separately as Parent Body)
    availableTargets.planets = targets.planets
      .map((p: { name: string }) => p.name)
      .filter((name: string) => name.toLowerCase() !== soiParent.toLowerCase());
    availableTargets.vessels = targets.vessels.map((v: { name: string }) => v.name);

    lines.push('', '=== Available Targets ===');
    if (availableTargets.moons.length > 0) {
      lines.push(`Moons: ${availableTargets.moons.join(', ')}`);
    }
    if (availableTargets.planets.length > 0) {
      lines.push(`Planets: ${availableTargets.planets.join(', ')}`);
    }
    if (availableTargets.vessels.length > 0) {
      lines.push(`Vessels: ${availableTargets.vessels.join(', ')}`);
    }
    // Show parent body if we're at a moon (not in solar orbit)
    if (isMoon) {
      lines.push(`Parent Body: ${soiParent}`);
    }
  } catch {
    // Silently skip if listTargets fails
  }

  return {
    connected: true,
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
 * Get ship status, handling connection automatically.
 *
 * This is a convenience wrapper around getShipTelemetry that handles
 * connection errors gracefully. Always returns a valid ShipTelemetry
 * object with `connected` field indicating accessibility.
 *
 * @param connection - Optional KosConnection. If not provided, auto-connects using shared connection.
 * @param options - Telemetry options
 * @returns Ship telemetry if connected, or disconnected status if not
 */
export async function getStatus(
  connection?: KosConnection,
  options?: ShipTelemetryOptions
): Promise<ShipTelemetry> {
  try {
    const conn = connection ?? await ensureConnected();
    return await getShipTelemetry(conn, options);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      connected: false,
      reason,
      availableTargets: { moons: [], planets: [], vessels: [] },
      formatted: `=== kOS Not Accessible ===\n${reason}`,
    };
  }
}

/**
 * Format target encounter info for display in tool outputs.
 *
 * TODO: This function is currently unused. Consider using it in tool outputs
 * that show encounter information (hohmann, interplanetary, course_correct).
 *
 * @param info Target encounter info from queryTargetEncounterInfo
 * @returns Formatted string with target-specific details
 */
function _formatTargetEncounterInfo(info: TargetEncounterInfo): string {
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
        lines.push(`Periapsis: ${fmtNum(peKm)} km (below surface!)`);
      } else if (isReentry) {
        lines.push(`Periapsis: ${fmtNum(peKm)} km (in atmosphere)`);
      } else {
        lines.push(`Periapsis: ${fmtNum(peKm)} km`);
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
      lines.push(`Capture ΔV: ${fmtNum(bodyInfo.captureDeltaV)} m/sec`);
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
        lines.push(`Closest approach: ${fmtNum(vesselInfo.closestApproachDistance)} m`);
      } else {
        lines.push(`Closest approach: ${fmtNum(distKm)} km`);
      }
    }

    if (vesselInfo.timeToClosestApproach !== undefined) {
      lines.push(`Time to closest: ${formatTime(vesselInfo.timeToClosestApproach)}`);
    }

    if (vesselInfo.closestApproachRelVel !== undefined) {
      lines.push(`Rel. velocity at CA: ${fmtNum(vesselInfo.closestApproachRelVel)} m/sec`);
    }
  }

  return lines.join('\n');
}

// ============================================================================
// Tool Definition
// ============================================================================

import type { ToolDefinition } from '../tool-types.js';

/**
 * Status tool definition
 */
export const statusTool: ToolDefinition = {
  name: 'status',
  description: 'Get ship info: orbit, fuel, position, encounters.',
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 3,
  handler: async (_args, ctx) => {
    try {
      const conn = ctx.getConnection();
      const telemetry = await getStatus(conn ?? undefined);

      if (telemetry.connected) {
        return ctx.successResponse('status', telemetry.formatted);
      } else {
        return ctx.errorResponse('status', telemetry.reason ?? 'Not connected');
      }
    } catch (error) {
      return ctx.errorResponse('status', error instanceof Error ? error.message : String(error));
    }
  },
};
