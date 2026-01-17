/**
 * MechJeb Telemetry Wrappers
 *
 * Provides structured access to vessel state and MechJeb info
 */

import type { KosConnection } from '../../transport/kos-connection.js';
import type { VesselState, OrbitInfo, MechJebInfo } from '../types.js';
import type { TargetEncounterInfo, BodyEncounterInfo, VesselEncounterInfo } from './shared.js';
import type { StatusData } from '../../utils/mcp-status.js';
import { parseNumber } from './shared.js';
import { config } from '../../config/index.js';
import { ensureConnected } from '../../transport/connection-tools.js';
import { delay } from '../utils/progress.js';
import { formatTime, formatOrbit, fmtNum, fmtDist, fmtVel } from '../utils/format.js';

// Delay between query batches - set to 0 since all telemetry queries are read-only
const TELEMETRY_DELAY_MS = 0;

// TypeScript-side telemetry cache
// - Avoids kOS limitations (CONFIG: only for built-in settings, GLOBAL clears on Ctrl+C)
// - Benefits MCP server (long-lived process) with rapid repeated status calls
// - CLI runs are separate processes, so they don't benefit from this cache
let telemetryCache: { result: ShipTelemetry; timestamp: number } | null = null;
const TELEMETRY_CACHE_TTL_MS = 5000; // 5 seconds

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

  // Flush any stale data - reduced from 100ms to 10ms for performance
  await conn.flushStaleData(10);

  // ============================================================================
  // TypeScript-side caching - return cached telemetry if fresh
  // ============================================================================
  const now = Date.now();
  if (telemetryCache && (now - telemetryCache.timestamp) < TELEMETRY_CACHE_TTL_MS) {
    return telemetryCache.result;
  }

  // ============================================================================
  // SINGLE STATUS QUERY: kOS writes JSON to file, copies to archive if connected
  // ============================================================================
  // Run status script from local volume (extensionless - kOS prefers .ksm, falls back to .ks)
  // Retry up to 3 times due to intermittent kOS string handling bug
  let data: StatusData | null = null;
  let lastError = '';

  for (let attempt = 1; attempt <= 3; attempt++) {
    // Run status script - kOS builds status data and prints as JSON
    const statusResult = await conn.execute(
      'RUNPATH("1:/boot/mcp_status").',
      timeoutMs
    );

    // Parse STATUS_COMPACT from terminal output (standard JSON built from lexicon)
    const compactMatch = statusResult.output.match(/STATUS_COMPACT:(\{[^}]+\})/);
    if (compactMatch) {
      try {
        // kOS uses True/False, JSON requires true/false
        const jsonStr = compactMatch[1].replaceAll(/:True([,}])/g, ':true$1').replaceAll(/:False([,}])/g, ':false$1');
        data = JSON.parse(jsonStr) as StatusData;
        break; // Success
      } catch (e) {
        lastError = `Compact JSON parse error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    // Check if kOS threw the known string index error
    if (statusResult.output.includes('Start index cannot be')) {
      lastError = 'kOS string handling bug - retrying';
      await new Promise(r => setTimeout(r, 100)); // Brief pause before retry
      continue;
    }

    if (!compactMatch) {
      lastError = 'no STATUS_COMPACT in output';
    }
  }

  if (!data) {
    throw new Error(`Telemetry error: status script failed (${lastError})`);
  }

  // Map JSON fields to local variables for existing code compatibility
  const soi = data.soi;
  const soiParent = data.soiParent;
  const apoRaw = data.apo;
  const per = data.per;
  const periodRaw = data.period;
  const inc = data.inc;
  const ecc = data.ecc;
  const lan = data.lan;
  const vesselName = data.shipName;
  const vesselType = data.shipType;
  const vesselStatus = data.status;
  const altitude = data.alt;
  const latitude = data.lat;
  const longitude = data.lng;
  const nodeDv = data.nodeDv;
  const nodeEta = data.nodeEta;
  const shipDeltaV = data.deltaV;
  const slopeDegrees = data.slope;

  const hasNode = nodeDv > 0;
  const isEscapeTrajectory = apoRaw < 0 || periodRaw === -1;
  const isImpactTrajectory = periodRaw < -1;
  const apo = isEscapeTrajectory ? Infinity : apoRaw;
  const period = isEscapeTrajectory ? Infinity : periodRaw;

  // Build structured data
  const vessel: VesselInfo = { name: vesselName, type: vesselType, status: vesselStatus };
  const orbit: OrbitTelemetry = { body: soi, apoapsis: apo, periapsis: per, period, inclination: inc, eccentricity: ecc, lan };
  let maneuver: ManeuverInfo | undefined;
  let encounter: EncounterInfo | undefined;
  let target: TargetInfo | undefined;

  const isMoon = soiParent.toLowerCase() !== 'sun' && soiParent.toLowerCase() !== 'kerbol';
  const soiDisplay = isMoon ? `${soi}, a moon of ${soiParent}` : soi;

  // ============================================================================
  // GROUP 2: Timing (from JSON data)
  // ============================================================================
  interface OrbitalEvent { name: string; eta: number; }
  const orbitalEvents: OrbitalEvent[] = [];
  const atmHeight = data.atmHeight;
  const hasNextPatch = data.hasNextPatch;
  const orbitalSpeed = data.speed;
  const etaTransition = data.etaTrans;
  const etaApoapsis = data.etaApo;
  const etaPeriapsis = data.etaPer;
  const hasAtmosphere = data.hasAtm;
  const timeToImpact = data.tti;

  // Build orbital events (body names added, encounter body updated after target processing)
  if (etaApoapsis > 0 && etaApoapsis < 1e10 && !isEscapeTrajectory) {
    orbitalEvents.push({ name: `${soi} Apoapsis`, eta: etaApoapsis });
  }
  if (etaPeriapsis > 0 && etaPeriapsis < 1e10) {
    orbitalEvents.push({ name: `${soi} Periapsis`, eta: etaPeriapsis });
  }
  if (hasNextPatch && etaTransition > 0 && etaTransition < 1e10) {
    // Placeholder - encounter body name will be prepended after target processing
    const transitionType = isEscapeTrajectory ? 'SOI Escape' : 'SOI Change';
    orbitalEvents.push({ name: `_ENC_ ${transitionType}`, eta: etaTransition });
  }
  if (hasAtmosphere && atmHeight > 0 && per < atmHeight && altitude > atmHeight) {
    const atmEntryEta = Math.max(0, etaPeriapsis * 0.7);
    orbitalEvents.push({ name: 'Atmosphere Entry', eta: atmEntryEta });
  }
  if (timeToImpact > 0 && timeToImpact < 1e10) {
    orbitalEvents.push({ name: '⚠️ IMPACT', eta: timeToImpact });
  }

  orbitalEvents.sort((a, b) => a.eta - b.eta);
  const nextEvents = orbitalEvents.slice(0, 2);

  // ============================================================================
  // BUILD FORMATTED OUTPUT (Ship State + Timing)
  // ============================================================================
  const isSurface = ['LANDED', 'SPLASHED', 'PRELAUNCH'].includes(vesselStatus.toUpperCase());
  let nextLineIndex = -1;  // Index for "Next:" line (updated after G3 with encounter body)

  if (isSurface) {
    lines.push(`Location: ${soiDisplay} (${vesselStatus.toUpperCase()}) on surface`);
    lines.push(`Longitude: ${longitude.toFixed(4)}°`);
    lines.push(`Latitude: ${latitude.toFixed(4)}°`);
    const altKm = altitude / 1000;
    lines.push(`Altitude: ${altKm >= 1 ? altKm.toFixed(1) + 'km' : altitude.toFixed(0) + 'm'}`);
    lines.push(`Slope: ${slopeDegrees.toFixed(1)}°`);
    const dvPart = shipDeltaV > 0 ? ` (delta-v: ${fmtVel(shipDeltaV)})` : '';
    lines.push(`${vesselType}: ${vesselName}${dvPart}`);
  } else {
    // Show TRANSFERRING when on course for SOI transition
    const displayStatus = hasNextPatch ? 'TRANSFERRING' : vesselStatus.toUpperCase();
    lines.push(`SOI: ${soiDisplay} (${displayStatus})`);
    // Store index for "Next:" line - will be populated after G3 with encounter body name
    nextLineIndex = lines.length;
    lines.push('');  // Placeholder
    if (isEscapeTrajectory) {
      lines.push(`Orbit: Hyperbolic, Periapsis: ${fmtDist(per)}, Inclination: ${inc.toFixed(1)}°`);
    } else if (isImpactTrajectory) {
      lines.push(`Orbit: Impact trajectory, Periapsis: ${fmtDist(per)}, Inclination: ${inc.toFixed(1)}°`);
    } else {
      const orbitType = (apo - per) < 5000 ? 'Circular' : 'Elliptical';
      lines.push(`Orbit: ${orbitType}, ${formatOrbit(apo, per)}, Inclination: ${inc.toFixed(1)}°`);
    }
    const speedInfo = orbitalSpeed > 0 ? `speed: ${fmtVel(orbitalSpeed)}` : '';
    const dvInfo = shipDeltaV > 0 ? `delta-v: ${fmtVel(shipDeltaV)}` : '';
    const shipDetails = [speedInfo, dvInfo].filter(Boolean).join(', ');
    lines.push(`Ship: ${vesselName}${shipDetails ? ` (${shipDetails})` : ''}`);
  }

  if (hasNode) {
    const estimatedBurnTime = nodeDv / (1.5 * 9.81);
    maneuver = { deltaV: nodeDv, timeToNode: nodeEta, estimatedBurnTime };
    lines.push('', 'NEXT MANEUVER:');
    lines.push(`Delta-V: ${fmtVel(nodeDv)}`);
    lines.push(`Time to node: ${formatTime(nodeEta)}`);
    lines.push(`Est. burn time: ${formatTime(estimatedBurnTime)}`);
  }

  // ============================================================================
  // GROUP 3: Targeting (from JSON data)
  // ============================================================================
  const encounterBody = data.encBody || '';
  const encounterPe = data.encPe;

  // Update "Next:" line with encounter body name (replace _ENC_ placeholder)
  if (encounterBody && encounterBody !== soi) {
    for (const event of nextEvents) {
      if (event.name.startsWith('_ENC_')) {
        event.name = event.name.replace('_ENC_', encounterBody);
      }
    }
  }
  // Build "Next:" line now that we have encounter body name
  if (nextLineIndex >= 0 && nextEvents.length > 0) {
    const eventStrs = nextEvents.map(e => `${e.name} in ${formatTime(e.eta)}`);
    lines[nextLineIndex] = `Next: ${eventStrs.join(', ')}`;
  }

  // Encounter section - show even for negative periapsis (crash trajectories)
  if (encounterBody && encounterBody !== soi) {
    encounter = { body: encounterBody, periapsis: encounterPe };
    // If we're at a planet (soiParent is Sun), encounter body is a moon of current SOI
    const atPlanet = soiParent.toLowerCase() === 'sun' || soiParent.toLowerCase() === 'kerbol';
    const encParentInfo = atPlanet ? ` (A moon of ${soi})` : '';

    lines.push('', 'ENCOUNTER:');
    lines.push(`Body: ${encounterBody}${encParentInfo}`);
    if (encounterPe < 0) {
      lines.push(`Periapsis: ${(encounterPe / 1000).toFixed(1)} km (CRASH TRAJECTORY!)`);
    } else if (encounterPe < 10_000) {
      lines.push(`Periapsis: ${(encounterPe / 1000).toFixed(1)} km (LOW - may need course_correct)`);
    } else {
      lines.push(`Periapsis: ${(encounterPe / 1000).toFixed(1)} km`);
    }
    // Show time to encounter
    if (etaTransition > 0 && etaTransition < 1e10) {
      lines.push(`Time: ${formatTime(etaTransition)}`);
    }
  }

  // Target section (from JSON data)
  if (data.hasTarget && data.tgtName) {
    const targetName = data.tgtName;
    const targetType = data.tgtType || 'Unknown';
    const targetDist = data.tgtDist || 0;
    const targetParent = data.tgtParent || '';
    const closeApproachTime = data.caTime || 0;
    const closeApproachDist = data.caDist || 0;
    const timeToAN = data.anTime || 0;
    const timeToDN = data.dnTime || 0;
    const anExists = data.anEx || false;
    const dnExists = data.dnEx || false;
    const relInc = data.relInc || 0;

    target = { name: targetName, type: targetType, distance: targetDist };
    lines.push('', 'TARGET:');
    if (targetType === 'Body' && targetParent) {
      const isSun = targetParent.toLowerCase() === 'sun' || targetParent.toLowerCase() === 'kerbol';
      lines.push(isSun ? `${targetName} (Planet)` : `${targetName} (A moon of ${targetParent})`);
    } else {
      lines.push(`${targetName} (${targetType})`);
    }
    lines.push(`Distance: ${formatDistance(targetDist)}`);

    // Rendezvous info
    if (closeApproachTime > 0 && closeApproachTime < 864_000 && closeApproachDist < 1e9) {
      lines.push(`Close approach: ${formatDistance(closeApproachDist)} in ${formatTime(closeApproachTime)}`);
    }
    if (relInc > 0.1) {
      lines.push(`Relative inclination: ${relInc.toFixed(1)}°`);
      const nodeInfo: string[] = [];
      if (anExists && timeToAN > 0 && timeToAN < 1e10) nodeInfo.push(`AN: ${formatTime(timeToAN)}`);
      if (dnExists && timeToDN > 0 && timeToDN < 1e10) nodeInfo.push(`DN: ${formatTime(timeToDN)}`);
      if (nodeInfo.length > 0) lines.push(`Nodes: ${nodeInfo.join(', ')}`);
    }
  }

  // Fallback: Build "Next:" line if G3 didn't provide encounter body
  // Remove _ENC_ placeholder if still present (no encounter found)
  if (nextLineIndex >= 0 && lines[nextLineIndex] === '') {
    for (const event of nextEvents) {
      if (event.name.startsWith('_ENC_')) {
        event.name = event.name.replace('_ENC_ ', '');  // Remove placeholder
      }
    }
    if (nextEvents.length > 0) {
      const eventStrs = nextEvents.map(e => `${e.name} in ${formatTime(e.eta)}`);
      lines[nextLineIndex] = `Next: ${eventStrs.join(', ')}`;
    } else {
      lines.splice(nextLineIndex, 1);  // Remove empty placeholder
    }
  }

  // ============================================================================
  // AVAILABLE TARGETS (with SOI-based caching)
  // ============================================================================
  const availableTargets: AvailableTargets = { moons: [], planets: [], vessels: [] };
  try {
    const { getCachedTargets, setCachedTargets } = await import('../cache/targets-cache.js');
    const cachedTargets = getCachedTargets(soi);

    if (cachedTargets) {
      // Use cached data
      availableTargets.moons = cachedTargets.moons.map(m => m.name);
      availableTargets.planets = cachedTargets.planets
        .map(p => p.name)
        .filter(name => name.toLowerCase() !== soiParent.toLowerCase());
      availableTargets.vessels = cachedTargets.vessels.map(v => v.name);
    } else {
      // Fresh query and cache
      const { listTargets } = await import('../kos/target/get-targets.js');
      const targets = await listTargets(conn);
      setCachedTargets(soi, targets);

      availableTargets.moons = targets.moons.map((m: { name: string }) => m.name);
      availableTargets.planets = targets.planets
        .map((p: { name: string }) => p.name)
        .filter((name: string) => name.toLowerCase() !== soiParent.toLowerCase());
      availableTargets.vessels = targets.vessels.map((v: { name: string }) => v.name);
    }

    lines.push('', 'AVAILABLE TARGETS:');
    if (availableTargets.moons.length > 0) lines.push(`Moons: ${availableTargets.moons.join(', ')}`);
    if (availableTargets.planets.length > 0) lines.push(`Planets: ${availableTargets.planets.join(', ')}`);
    if (availableTargets.vessels.length > 0) lines.push(`Vessels: ${availableTargets.vessels.join(', ')}`);
    if (isMoon) lines.push(`Parent Body: ${soiParent}`);
  } catch {
    // Silently skip if listTargets fails
  }

  const result: ShipTelemetry = {
    connected: true,
    vessel,
    orbit,
    maneuver,
    encounter,
    target,
    availableTargets,
    formatted: lines.join('\n'),
  };

  // Cache the result for rapid repeated calls
  telemetryCache = { result, timestamp: Date.now() };

  return result;
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
      lines.push(`Capture ΔV: ${fmtVel(bodyInfo.captureDeltaV)}`);
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
      lines.push(`Rel. velocity at CA: ${fmtVel(vesselInfo.closestApproachRelVel)}`);
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
          const status = match[2].trim() || 'Ascending';
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
          const detail = `Alt: ${(alt/1000).toFixed(1)}km, VSpeed: ${fmtVel(vspeed)}`;
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
          // Translate MechJeb states to plain English
          let status = state;
          switch (state.toUpperCase()) {
            case 'WARPALIGN': status = 'Aligning'; break;
            case 'LEAD': status = 'Coasting to burn'; break;
            case 'BURN': status = 'Burning'; break;
            case 'IDLE': status = 'Idle'; break;
          }
          const detail = dvRemaining > 0 ? `ΔV remaining: ${fmtVel(dvRemaining)}` : undefined;
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
 *
 * Optimized: Single query checks all autopilots at once.
 * Only queries details if something is actually enabled.
 */
async function detectMechJebOperation(conn: KosConnection): Promise<{ opType: KosOperationType; status: string; detail?: string } | null> {
  try {
    // Single query to check all autopilot enabled states + node state
    const result = await conn.execute(
      'PRINT "MJ:" + ADDONS:MJ:ASCENT:ENABLED + "|" + ADDONS:MJ:LANDING:ENABLED + "|" + ADDONS:MJ:NODE:ENABLED + "|" + ADDONS:MJ:NODE:STATE + "|" + (CHOOSE ROUND(NEXTNODE:DELTAV:MAG,1) IF HASNODE ELSE 0).',
      2000
    );
    const match = result.output.match(/MJ:(True|False)\|(True|False)\|(True|False)\|(\w+)\|([\d.]+)/i);
    if (!match) return null;

    const ascentEnabled = match[1].toLowerCase() === 'true';
    const landingEnabled = match[2].toLowerCase() === 'true';
    const nodeEnabled = match[3].toLowerCase() === 'true';
    const nodeState = match[4];
    const nodeDv = parseNumber(match[5]);

    // Check ascent (most likely during launch)
    if (ascentEnabled) {
      // Query ascent details only when needed
      const statusResult = await conn.execute(
        'PRINT ADDONS:MJ:ASCENT:STATUS + "|" + ROUND(APOAPSIS) + "|" + ROUND(ALTITUDE).',
        2000
      );
      const detailMatch = statusResult.output.match(/([^|]*)\|(-?[\d.]+)\|(-?[\d.]+)/);
      if (detailMatch) {
        const status = detailMatch[1].trim() || 'Ascending';
        const apo = parseNumber(detailMatch[2]);
        const alt = parseNumber(detailMatch[3]);
        return { opType: 'ascent', status, detail: `Alt: ${(alt/1000).toFixed(1)}km, Apo: ${(apo/1000).toFixed(1)}km` };
      }
      return { opType: 'ascent', status: 'Ascending' };
    }

    // Check landing
    if (landingEnabled) {
      // Query landing details only when needed
      const statusResult = await conn.execute(
        'PRINT ROUND(ALTITUDE) + "|" + ROUND(SHIP:VERTICALSPEED).',
        2000
      );
      const detailMatch = statusResult.output.match(/(-?[\d.]+)\|(-?[\d.]+)/);
      if (detailMatch) {
        const alt = parseNumber(detailMatch[1]);
        const vspeed = parseNumber(detailMatch[2]);
        return { opType: 'landing', status: 'Landing', detail: `Alt: ${(alt/1000).toFixed(1)}km, VSpeed: ${fmtVel(vspeed)}` };
      }
      return { opType: 'landing', status: 'Landing' };
    }

    // Check node executor (already have state and dv from combined query)
    if (nodeEnabled) {
      let status = nodeState;
      switch (nodeState.toUpperCase()) {
        case 'WARPALIGN': status = 'Aligning'; break;
        case 'LEAD': status = 'Coasting to burn'; break;
        case 'BURN': status = 'Burning'; break;
        case 'IDLE': status = 'Idle'; break;
      }
      return { opType: 'node', status, detail: nodeDv > 0 ? `ΔV remaining: ${fmtVel(nodeDv)}` : undefined };
    }

    return null;
  } catch {
    return null;
  }
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
  const lines: string[] = ['ACTIVE OPERATION:', `Tool: ${progress.toolName}`, `Phase: ${progress.phase}`];
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
  description: 'Get ship info: position, fuel, targets.',
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
