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

  // Split into smaller queries for robustness - each can fail independently
  // But if critical queries fail, we throw an error rather than showing misleading defaults
  let soi = '';
  let soiParent = 'Sun';
  let apoRaw = 0;
  let per = 0;
  let periodRaw = 0;
  let inc = 0;
  let ecc = 0;
  let lan = 0;
  let vesselName = '';
  let vesselType = '';
  let vesselStatus = '';
  let nodeDv = 0;
  let nodeEta = 0;
  let hasEncounter = false;
  let altitude = 0;
  let latitude = 0;
  let longitude = 0;

  let orbitQueryFailed = true;
  let vesselQueryFailed = true;

  // Query 1: Orbit basics (8 fields)
  const parentBodyExpr = '(CHOOSE "Sun" IF SHIP:BODY:NAME = "Sun" ELSE SHIP:BODY:BODY:NAME)';
  try {
    const orbitResult = await conn.execute(
      `PRINT "ORB|" + SHIP:ORBIT:BODY:NAME + "${SEP}" + ${parentBodyExpr} + "${SEP}" + ` +
      `(CHOOSE -1 IF ORBIT:ECCENTRICITY >= 1 ELSE ROUND(APOAPSIS)) + "${SEP}" + ROUND(PERIAPSIS) + "${SEP}" + ` +
      `(CHOOSE -1 IF ORBIT:ECCENTRICITY >= 1 ELSE ROUND(ORBIT:PERIOD)) + "${SEP}" + ` +
      `ROUND(ORBIT:INCLINATION,2) + "${SEP}" + ROUND(ORBIT:ECCENTRICITY,4) + "${SEP}" + ROUND(ORBIT:LAN,2).`,
      timeoutMs
    );
    const orbitMatch = orbitResult.output.match(/ORB\|([^|]+)\|~\|([^|]+)\|~\|(-?[\d.]+)\|~\|(-?[\d.]+)\|~\|(-?[\d.]+)\|~\|([\d.]+)\|~\|([\d.]+)\|~\|([\d.]+)/i);
    if (orbitMatch) {
      soi = orbitMatch[1].replaceAll(/^Body\(|\)$/g, '').replaceAll('"', '');
      soiParent = orbitMatch[2].replaceAll(/^Body\(|\)$/g, '').replaceAll('"', '');
      apoRaw = parseNumber(orbitMatch[3]);
      per = parseNumber(orbitMatch[4]);
      periodRaw = parseNumber(orbitMatch[5]);
      inc = parseNumber(orbitMatch[6]);
      ecc = parseNumber(orbitMatch[7]);
      lan = parseNumber(orbitMatch[8]);
      orbitQueryFailed = false;
    }
  } catch {
    // Will throw error below if both queries fail
  }

  // Query 2: Vessel info (6 fields)
  try {
    const vesselResult = await conn.execute(
      `PRINT "VES|" + SHIP:NAME + "${SEP}" + SHIP:TYPE + "${SEP}" + SHIP:STATUS + "${SEP}" + ` +
      `ROUND(ALTITUDE) + "${SEP}" + ROUND(SHIP:LATITUDE,4) + "${SEP}" + ROUND(SHIP:LONGITUDE,4).`,
      timeoutMs
    );
    const vesselMatch = vesselResult.output.match(/VES\|([^|]+)\|~\|([^|]+)\|~\|([^|]+)\|~\|(-?[\d.]+)\|~\|(-?[\d.]+)\|~\|(-?[\d.]+)/i);
    if (vesselMatch) {
      vesselName = vesselMatch[1].trim().replaceAll('"', '');
      vesselType = vesselMatch[2].trim();
      vesselStatus = vesselMatch[3].trim();
      altitude = parseNumber(vesselMatch[4]);
      latitude = parseNumber(vesselMatch[5]);
      longitude = parseNumber(vesselMatch[6]);
      vesselQueryFailed = false;
    }
  } catch {
    // Will throw error below if both queries fail
  }

  // If both critical queries failed, throw an error - don't show misleading data
  if (orbitQueryFailed && vesselQueryFailed) {
    throw new Error('Telemetry error: failed to query ship data');
  }

  // Query 3: Node info (optional - 3 fields)
  try {
    const nodeResult = await conn.execute(
      `IF HASNODE { PRINT "NODE|" + ROUND(NEXTNODE:DELTAV:MAG,1) + "${SEP}" + ROUND(NEXTNODE:ETA) + "${SEP}" + NEXTNODE:ORBIT:HASNEXTPATCH. } ` +
      `ELSE { PRINT "NODE|0${SEP}0${SEP}" + ORBIT:HASNEXTPATCH. }`,
      timeoutMs
    );
    const nodeMatch = nodeResult.output.match(/NODE\|([\d.]+)\|~\|(-?[\d.]+)\|~\|(True|False)/i);
    if (nodeMatch) {
      nodeDv = parseNumber(nodeMatch[1]);
      nodeEta = parseNumber(nodeMatch[2]);
      hasEncounter = parseBool(nodeMatch[3]);
    }
  } catch {
    // Node query is optional - continue without it
  }

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

  // Query ship delta-v and terrain height (separate queries for robustness)
  let shipDeltaV = 0;
  let terrainHeight = 0;
  try {
    const dvResult = await conn.execute('PRINT "DV:" + ROUND(SHIP:DELTAV:CURRENT) + " TER:" + ROUND(SHIP:GEOPOSITION:TERRAINHEIGHT).', 2000);
    const dvMatch = dvResult.output.match(/DV:(-?\d+)/);
    const terMatch = dvResult.output.match(/TER:(-?\d+)/);
    if (dvMatch) {
      shipDeltaV = parseInt(dvMatch[1]);
    }
    if (terMatch) {
      terrainHeight = parseInt(terMatch[1]);
    }
  } catch {
    // Ignore query failures - non-critical
  }

  // Check if on surface (LANDED, SPLASHED, PRELAUNCH)
  const isSurface = ['LANDED', 'SPLASHED', 'PRELAUNCH'].includes(vesselStatus.toUpperCase());

  if (isSurface) {
    // Surface status format
    lines.push(`Ship: ${vesselStatus.toUpperCase()}`);
    lines.push(`Surface of: ${soiDisplay}`);
    const altKm = altitude / 1000;
    lines.push(`Altitude: ${altKm >= 1 ? altKm.toFixed(1) + 'km' : altitude.toFixed(0) + 'm'}`);
    if (terrainHeight !== 0) {
      const terKm = terrainHeight / 1000;
      lines.push(`Terrain: ${terKm >= 1 ? terKm.toFixed(1) + 'km' : terrainHeight.toFixed(0) + 'm'} ASL`);
    }
    lines.push(`Latitude: ${latitude.toFixed(4)}°`);
    lines.push(`Longitude: ${longitude.toFixed(4)}°`);
    lines.push(`Vessel: ${vesselName}`);
    if (shipDeltaV > 0) {
      lines.push(`Delta-V: ${shipDeltaV} m/s`);
    }
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
    if (shipDeltaV > 0) {
      lines.push(`Delta-V: ${shipDeltaV} m/s`);
    }
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
// Operation Progress Tracking
// ============================================================================

import { getKosOperation, type KosOperationType } from '../../utils/kos-operation-state.js';

export interface OperationProgress {
  toolName: string;
  operationType: KosOperationType;
  phase: string;
  detail?: string;
  running: boolean;
  durationSeconds: number;
  target?: string;
}

/**
 * Query MechJeb autopilot status based on operation type.
 * Returns current phase/status from the appropriate MechJeb module.
 */
async function queryMechJebAutopilotStatus(
  conn: KosConnection,
  opType: KosOperationType
): Promise<{ enabled: boolean; status: string; detail?: string }> {
  try {
    switch (opType) {
      case 'ascent': {
        const result = await conn.execute(
          'PRINT ADDONS:MJ:ASCENT:ENABLED + "|" + ADDONS:MJ:ASCENT:STATUS + "|" + ROUND(APOAPSIS) + "|" + ROUND(ALTITUDE).',
          3000
        );
        const match = result.output.match(/(True|False)\|([^|]*)\|(-?[\d.]+)\|(-?[\d.]+)/i);
        if (match) {
          const enabled = match[1].toLowerCase() === 'true';
          const status = match[2].trim() || 'Unknown';
          const apo = parseNumber(match[3]);
          const alt = parseNumber(match[4]);
          const detail = `Alt: ${(alt/1000).toFixed(1)}km, Apo: ${(apo/1000).toFixed(1)}km`;
          return { enabled, status, detail };
        }
        break;
      }
      case 'landing': {
        const result = await conn.execute(
          'PRINT ADDONS:MJ:LANDING:ENABLED + "|" + ADDONS:MJ:LANDING:STATUS + "|" + ROUND(ALTITUDE) + "|" + ROUND(SHIP:VERTICALSPEED).',
          3000
        );
        const match = result.output.match(/(True|False)\|([^|]*)\|(-?[\d.]+)\|(-?[\d.]+)/i);
        if (match) {
          const enabled = match[1].toLowerCase() === 'true';
          const mjStatus = match[2].trim();
          const alt = parseNumber(match[3]);
          const vspeed = parseNumber(match[4]);
          // Use actual MechJeb status, fallback to generic if empty
          const status = mjStatus || (enabled ? 'Landing' : 'Idle');
          const detail = `Alt: ${(alt/1000).toFixed(1)}km, VSpeed: ${vspeed.toFixed(0)}m/s`;
          return { enabled, status, detail };
        }
        break;
      }
      case 'node': {
        const result = await conn.execute(
          'PRINT ADDONS:MJ:NODE:ENABLED + "|" + ADDONS:MJ:NODE:STATE + "|" + (CHOOSE ROUND(NEXTNODE:DELTAV:MAG,1) IF HASNODE ELSE 0).',
          3000
        );
        const match = result.output.match(/(True|False)\|(\w+)\|([\d.]+)/i);
        if (match) {
          const enabled = match[1].toLowerCase() === 'true';
          const state = match[2].trim();
          const dvRemaining = parseNumber(match[3]);
          // Translate MechJeb states
          let status = state;
          switch (state) {
          case 'WARPALIGN': {
          status = 'Aligning';
          break;
          }
          case 'LEAD': {
          status = 'Coasting to burn';
          break;
          }
          case 'BURN': {
          status = 'Burning';
          // No default
          }
          break;
          }
          const detail = dvRemaining > 0 ? `ΔV remaining: ${dvRemaining.toFixed(1)} m/s` : undefined;
          return { enabled, status, detail };
        }
        break;
      }
      default:
        return { enabled: false, status: 'Unknown', detail: undefined };
    }
  } catch {
    // Query failed - assume not running
  }
  return { enabled: false, status: 'Unknown', detail: undefined };
}

/**
 * Detect if MechJeb autopilot is running (without _MCP_OP set).
 * Used as fallback when operation wasn't started via our tools.
 */
async function detectMechJebOperation(conn: KosConnection): Promise<{ opType: KosOperationType; status: string; detail?: string } | null> {
  // Check ascent autopilot
  try {
    const ascentResult = await conn.execute('PRINT ADDONS:MJ:ASCENT:ENABLED.', 2000);
    if (ascentResult.output.toLowerCase().includes('true')) {
      const statusResult = await conn.execute(
        'PRINT ADDONS:MJ:ASCENT:STATUS + "|" + ROUND(APOAPSIS) + "|" + ROUND(ALTITUDE).',
        2000
      );
      const match = statusResult.output.match(/([^|]*)\|(-?[\d.]+)\|(-?[\d.]+)/);
      if (match) {
        const status = match[1].trim() || 'Ascending';
        const apo = parseNumber(match[2]);
        const alt = parseNumber(match[3]);
        return { opType: 'ascent', status, detail: `Alt: ${(alt/1000).toFixed(1)}km, Apo: ${(apo/1000).toFixed(1)}km` };
      }
      return { opType: 'ascent', status: 'Ascending' };
    }
  } catch { /* ignore */ }

  // Check landing autopilot
  try {
    const landResult = await conn.execute('PRINT ADDONS:MJ:LANDING:ENABLED.', 2000);
    if (landResult.output.toLowerCase().includes('true')) {
      const statusResult = await conn.execute(
        'PRINT ROUND(ALTITUDE) + "|" + ROUND(SHIP:VERTICALSPEED).',
        2000
      );
      const match = statusResult.output.match(/(-?[\d.]+)\|(-?[\d.]+)/);
      if (match) {
        const alt = parseNumber(match[1]);
        const vspeed = parseNumber(match[2]);
        return { opType: 'landing', status: 'Landing', detail: `Alt: ${(alt/1000).toFixed(1)}km, VSpeed: ${vspeed.toFixed(0)}m/s` };
      }
      return { opType: 'landing', status: 'Landing' };
    }
  } catch { /* ignore */ }

  // Check node executor
  try {
    const nodeResult = await conn.execute('PRINT ADDONS:MJ:NODE:ENABLED.', 2000);
    if (nodeResult.output.toLowerCase().includes('true')) {
      const statusResult = await conn.execute(
        'PRINT ADDONS:MJ:NODE:STATE + "|" + (CHOOSE ROUND(NEXTNODE:DELTAV:MAG,1) IF HASNODE ELSE 0).',
        2000
      );
      const match = statusResult.output.match(/(\w+)\|([\d.]+)/);
      if (match) {
        const state = match[1].trim();
        const dvRemaining = parseNumber(match[2]);
        let status = state;
        switch (state) {
        case 'WARPALIGN': {
        status = 'Aligning';
        break;
        }
        case 'LEAD': {
        status = 'Coasting to burn';
        break;
        }
        case 'BURN': {
        status = 'Burning';
        // No default
        }
        break;
        }
        return { opType: 'node', status, detail: dvRemaining > 0 ? `ΔV remaining: ${dvRemaining.toFixed(1)} m/s` : undefined };
      }
      return { opType: 'node', status: 'Executing node' };
    }
  } catch { /* ignore */ }

  return null;
}

/**
 * Get current operation progress, if any.
 *
 * Queries _MCP_OP from kOS first (persists across service restarts).
 * Falls back to MechJeb autopilot detection for operations started externally.
 *
 * Note: Safety monitor in kOS automatically clears _MCP_OP when operations complete.
 */
export async function getOperationProgress(conn: KosConnection): Promise<OperationProgress | null> {
  // First: Query _MCP_OP from kOS (persisted state)
  const kosOp = await getKosOperation(conn);

  if (kosOp) {
    // Query MechJeb for current autopilot status
    const mjStatus = await queryMechJebAutopilotStatus(conn, kosOp.opType);

    return {
      toolName: kosOp.toolName,
      operationType: kosOp.opType,
      phase: mjStatus.status,
      detail: mjStatus.detail,
      running: mjStatus.enabled,
      durationSeconds: Math.round(kosOp.duration),
      target: kosOp.target || undefined,
    };
  }

  // Fallback: Check if MechJeb autopilot is running without _MCP_OP
  // This handles operations started manually or from other tools
  const mjOp = await detectMechJebOperation(conn);
  if (mjOp) {
    return {
      toolName: 'unknown (MechJeb detected)',
      operationType: mjOp.opType,
      phase: mjOp.status,
      detail: mjOp.detail,
      running: true,
      durationSeconds: 0,
      target: undefined,
    };
  }

  return null;
}

/**
 * Format operation progress for display
 */
export function formatOperationProgress(progress: OperationProgress): string {
  const lines: string[] = ['=== Active Operation ===', `Tool: ${progress.toolName}`, `Phase: ${progress.phase}`];
  if (progress.detail) {
    lines.push(progress.detail);
  }
  if (progress.target) {
    lines.push(`Target: ${progress.target}`);
  }
  lines.push(`Running for: ${progress.durationSeconds}s`);
  if (!progress.running) {
    lines.push('⚠️ Autopilot not active - may be completing or failed');
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
  tier: 1,
  handler: async (_args, ctx) => {
    try {
      // Auto-connect if not connected (like other tools)
      const conn = await ctx.ensureConnected();

      // Check for active operation first
      const opProgress = await getOperationProgress(conn);

      // Get ship telemetry
      const telemetry = await getStatus(conn);

      if (telemetry.connected) {
        // Prepend operation progress if there's an active operation
        let output = telemetry.formatted;
        if (opProgress) {
          output = formatOperationProgress(opProgress) + '\n\n' + output;
        }
        return ctx.successResponse('status', output);
      } else {
        return ctx.errorResponse('status', telemetry.reason ?? 'Not connected');
      }
    } catch (error) {
      return ctx.errorResponse('status', error instanceof Error ? error.message : String(error));
    }
  },
};
