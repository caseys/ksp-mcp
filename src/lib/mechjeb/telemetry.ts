/**
 * MechJeb Telemetry Wrappers
 *
 * Provides structured access to vessel state and MechJeb info
 */

import type { KosConnection } from '../../transport/kos-connection.js';
import type { VesselState, OrbitInfo, MechJebInfo } from '../types.js';
import type { TargetEncounterInfo, BodyEncounterInfo, VesselEncounterInfo } from './shared.js';
import type { StatusData } from '../../utils/mcp-status.js';
import type { KosOperationState } from '../../utils/kos-operation-state.js';
export type { StatusData } from '../../utils/mcp-status.js';
import { parseNumber } from './shared.js';
import { updateTargetCache } from '../tool-types.js';
import { config } from '../../config/index.js';
import { ensureConnected } from '../../transport/connection-tools.js';
import { delay } from '../utils/progress.js';
import { formatTime, formatOrbit, fmtNum, fmtDist, fmtVel } from '../utils/format.js';

// Delay between query batches - set to 0 since all telemetry queries are read-only
const TELEMETRY_DELAY_MS = 0;

// ==================== Status Data Cache ====================
// Cache with hysteresis: base timeout extends on hits, resets on miss
let cachedStatusData: StatusData | null = null;
let cacheTimestamp = 0;
let cacheTimeout = 10_000;  // Current timeout (varies with hysteresis)

const CACHE_BASE_TIMEOUT = 10_000;   // 10 seconds base
const CACHE_EXTENSION = 1000;        // +1 second per cache hit
const CACHE_MAX_TIMEOUT = 15_000;    // Cap at 15 seconds

/**
 * Invalidate the status data cache.
 * Call after operations that change vessel state (burns, target changes, etc.)
 */
export function invalidateStatusCache(): void {
  cachedStatusData = null;
  cacheTimestamp = 0;
  cacheTimeout = CACHE_BASE_TIMEOUT;
}

/**
 * Get smart display status for reentry/aerobraking trajectories.
 * Replaces generic "SUB_ORBITAL" with more descriptive states.
 *
 * For atmospheric bodies with periapsis below atmosphere:
 * - COASTING_TO_AEROBRAKE: Aerobraking trajectory, still above atmosphere
 * - AEROBRAKING: In atmosphere, aerobraking
 * - COASTING_TO_REENTRY: Reentry trajectory, still above atmosphere
 * - REENTRY_AEROBRAKE: In upper atmosphere, slowing down before steep reentry
 * - REENTRY: In lower atmosphere, steep reentry
 */
function getReentryDisplayStatus(
  vesselStatus: string,
  periapsis: number,
  altitude: number,
  atmHeight: number,
  hasAtmosphere: boolean
): string {
  // Only override for sub_orbital on atmospheric bodies
  if (vesselStatus.toLowerCase() !== 'sub_orbital' || !hasAtmosphere || atmHeight <= 0) {
    return vesselStatus.toUpperCase();
  }

  // Calculate shallow reentry threshold (e.g., 50km for Kerbin's 70km atmosphere)
  const shallowReentryHeight = atmHeight - 20_000;

  if (periapsis < shallowReentryHeight) {
    // Deep reentry trajectory (periapsis < 50km for Kerbin)
    if (altitude > atmHeight) {
      return 'COASTING_TO_REENTRY';
    } else if (altitude > shallowReentryHeight) {
      return 'REENTRY_AEROBRAKE';
    } else {
      return 'REENTRY';
    }
  } else if (periapsis < atmHeight) {
    // Aerobraking trajectory (periapsis 50-70km for Kerbin)
    if (altitude > atmHeight) {
      return 'COASTING_TO_AEROBRAKE';
    } else {
      return 'AEROBRAKING';
    }
  }

  // Shouldn't get here if vesselStatus is sub_orbital
  return vesselStatus.toUpperCase();
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
  // Use queue() for clean output - no echo interference with commas
  const result = await conn.queue(`PRINT ${expr}.`, timeoutMs);

  if (!result.success) {
    return suffixes.map(() => 0);
  }

  // Parse comma-separated values - clean output from queue()
  const parts = result.output.split(',');
  return parts.map(s => parseNumber(s.trim()));
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
    // Use queue() for clean output extraction
    const result = await conn.queue(`PRINT ${suffix}.`, 2000);
    if (!result.success) return 0;
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
 * Convert kOS JSON format to standard JSON structure.
 *
 * Handles both raw WRITEJSON format and stripped format:
 *   Raw:     {"entries": [{value: "key", $type: ...}, {value: val, $type: ...}], $type: ...}
 *   Stripped: {"entries": ["key", val, "key", val]}
 *   Output:  {"key": val, "key": val}
 *
 * Also handles Lists:
 *   Raw:     {"items": [{value: X}, ...], $type: "kOS...List"}
 *   Output:  [X, ...]
 */
function convertKosJson(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== 'object') return obj;

  const record = obj as Record<string, unknown>;

  // Handle kOS value wrapper: {value: X, $type: "..."}
  // This unwraps the inner value
  if ('value' in record && '$type' in record && Object.keys(record).length === 2) {
    return convertKosJson(record.value);
  }

  // Check if it's a kOS Lexicon (has entries array)
  if ('entries' in record && Array.isArray(record.entries)) {
    const entries = record.entries as unknown[];
    const result: Record<string, unknown> = {};
    // entries is [key, value, key, value, ...] where each might be wrapped
    for (let i = 0; i < entries.length; i += 2) {
      const key = convertKosJson(entries[i]) as string;
      const value = convertKosJson(entries[i + 1]);
      result[key] = value;
    }
    return result;
  }

  // Check if it's a kOS List (has items array)
  if ('items' in record && Array.isArray(record.items)) {
    return (record.items as unknown[]).map(item => convertKosJson(item));
  }

  // Regular array
  if (Array.isArray(obj)) {
    return obj.map(item => convertKosJson(item));
  }

  // Regular object - recurse into properties, skip $type
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === '$type') continue; // Skip type annotations
    result[key] = convertKosJson(value);
  }
  return result;
}

/**
 * Get raw status data from mcp_status.ks script.
 * Handles auto-redeploy of outdated scripts.
 * Results are cached with hysteresis timeout (5s base, extends on hits).
 *
 * @param conn kOS connection
 * @param timeoutMs Timeout for status script execution
 * @param forceRefresh Bypass cache and fetch fresh data
 * @returns Raw StatusData from the status script
 */
export async function getStatusData(
  conn: KosConnection,
  timeoutMs = 10_000,
  forceRefresh = false
): Promise<StatusData> {
  // Check cache (unless force refresh requested)
  const now = Date.now();
  if (!forceRefresh && cachedStatusData && (now - cacheTimestamp) < cacheTimeout) {
    // Cache HIT - extend timeout (hysteresis pattern)
    cacheTimeout = Math.min(cacheTimeout + CACHE_EXTENSION, CACHE_MAX_TIMEOUT);
    return cachedStatusData;
  }

  // Cache MISS or forced refresh - reset timeout to base
  cacheTimeout = CACHE_BASE_TIMEOUT;

  let data: StatusData | null = null;
  let lastError = '';
  let needsRedeploy = false;

  for (let attempt = 1; attempt <= 3; attempt++) {
    // Small delay between retries to let connection stabilize
    if (attempt > 1) {
      await new Promise(r => setTimeout(r, 50));
    }
    // Ensure terminal width before status — it can reset to 80 after reboot/reconnect.
    // Must be a separate raw() call: SET TERMINAL:WIDTH triggers {Please resize}
    // which redraws the screen and corrupts queue() output parsing.
    const widthResult = await conn.raw('SET TERMINAL:WIDTH TO 240.', 2000);
    if (!widthResult.success) {
      // raw() resets the connection on comsTest failure — propagate immediately
      throw new Error(widthResult.error || 'Connection lost before status');
    }
    // Run status script - try volume 1 first (faster, survives radio blackout)
    // If only on volume 0 (archive), copy to volume 1 for next time, then run from volume 0
    // Uses queue() because we need to parse the JSON output from the script
    const statusResult = await conn.queue(
      'IF EXISTS("1:/mcp_status.ks") { RUNPATH("1:/mcp_status.ks"). } ELSE IF EXISTS("0:/mcp_status.ks") { COPYPATH("0:/mcp_status.ks", "1:/mcp_status.ks"). RUNPATH("0:/mcp_status.ks"). }',
      timeoutMs
    );

    // Check for connection/radio errors - don't retry, fail immediately
    if (statusResult.error?.includes('Radio loss') ||
        statusResult.error?.includes('Not connected')) {
      throw new Error(statusResult.error);
    }

    // Check for missing script - needs deployment
    // With the new EXISTS-guarded command, if neither volume has the script,
    // there's no RUNPATH executed and no JSON output, just command echo
    const fileNotFound = /File.*mcp_status\.ks.*not found/i;
    const hasJsonOutput = statusResult.output.includes('"v"') || statusResult.output.includes('"entries"');
    if (fileNotFound.test(statusResult.output) ||
        fileNotFound.test(statusResult.error || '') ||
        (!hasJsonOutput && !statusResult.output.includes('[MCP_STATUS_END]'))) {
      const rawPreview = statusResult.output.slice(0, 200).replaceAll('\n', String.raw`\n`);
      console.error(`[status] No JSON in script output (attempt ${attempt}). Raw: "${rawPreview}"`);
      needsRedeploy = true;
      lastError = 'status script not found';
      break; // Don't retry, need deploy
    }

    // Check for outdated script (old STATUS_COMPACT format)
    if (statusResult.output.includes('STATUS_COMPACT:')) {
      needsRedeploy = true;
      lastError = 'outdated status script format';
      break; // Don't retry, need redeploy
    }

    // Parse JSON output - handles both:
    // 1. Raw WRITEJSON format: {"entries": [...], "$type": "..."}
    // 2. Stripped format: {"v":"...", "soi":"...", ...}
    const endMarkerIdx = statusResult.output.indexOf('[MCP_STATUS_END]');
    // Strip terminal line-wrap newlines BEFORE searching for JSON markers.
    // kOS terminal wraps at 80 chars inserting \n which can land between { and "v",
    // causing indexOf('{"v"') to fail. Status output is single-line JSON so any
    // embedded newlines are wrapping artifacts.
    const outputToParse = (endMarkerIdx > 0
      ? statusResult.output.slice(0, Math.max(0, endMarkerIdx))
      : statusResult.output
    ).replaceAll(/[\r\n]+/g, '');

    // Find the JSON object - try stripped format first (starts with {"v"), then raw kOS format
    let firstBrace = outputToParse.indexOf('{"v"');
    let isStripped = true;
    if (firstBrace < 0) {
      firstBrace = outputToParse.indexOf('{"entries"');
      isStripped = false;
    }
    const lastBrace = outputToParse.lastIndexOf('}');

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const jsonStr = outputToParse.slice(firstBrace, lastBrace + 1);
      try {
        const parsed = JSON.parse(jsonStr);
        // Convert kOS format if needed, or use directly if already stripped
        data = isStripped ? parsed as StatusData : convertKosJson(parsed) as StatusData;
        break; // Success
      } catch (e) {
        lastError = `JSON parse error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    // Check if kOS threw the known string index error
    if (statusResult.output.includes('Start index cannot be')) {
      lastError = 'kOS string handling bug - retrying';
      continue;
    }

    if (firstBrace < 0 || lastBrace <= firstBrace) {
      lastError = 'no JSON object in output';
    }
  }

  // If script is outdated, redeploy and retry
  if (needsRedeploy) {
    const { ensureStatusScript } = await import('../../utils/deploy.js');
    const deployed = await ensureStatusScript(conn);
    if (deployed) {
      // Retry with new script - try volume 1 first (faster), fall back to volume 0
      // ensureStatusScript deploys to volume 0 and tries to copy to volume 1,
      // but copy may fail, so we check both paths
      // Uses queue() because we need to parse script JSON output
      const retryWidth = await conn.raw('SET TERMINAL:WIDTH TO 240.', 2000);
      if (!retryWidth.success) {
        throw new Error(retryWidth.error || 'Connection lost before status retry');
      }
      const retryResult = await conn.queue(
        'IF EXISTS("1:/mcp_status.ks") { RUNPATH("1:/mcp_status.ks"). } ELSE IF EXISTS("0:/mcp_status.ks") { RUNPATH("0:/mcp_status.ks"). } ELSE { PRINT "ERROR: mcp_status.ks not found on any volume". }',
        timeoutMs
      );
      const endIdx = retryResult.output.indexOf('[MCP_STATUS_END]');
      const toParse = endIdx > 0 ? retryResult.output.slice(0, Math.max(0, endIdx)) : retryResult.output;
      // Try stripped format first, then raw kOS format
      let first = toParse.indexOf('{"v"');
      let stripped = true;
      if (first < 0) {
        first = toParse.indexOf('{"entries"');
        stripped = false;
      }
      const last = toParse.lastIndexOf('}');
      if (first >= 0 && last > first) {
        try {
          const parsed = JSON.parse(toParse.slice(first, last + 1));
          data = stripped ? parsed as StatusData : convertKosJson(parsed) as StatusData;
        } catch {
          // Fall through to error
        }
      }
    }
  }

  if (!data) {
    throw new Error(`Telemetry error: status script failed (${lastError})`);
  }

  // Update cache on successful fetch
  cachedStatusData = data;
  cacheTimestamp = Date.now();

  // Update target name cache for parseTarget fuzzy matching
  if (data.targets) {
    updateTargetCache(data.targets);
  }

  return data;
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
  const { timeoutMs = 10_000 } = options;
  const lines: string[] = [];

  const data = await getStatusData(conn, timeoutMs);

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
    if (isEscapeTrajectory) {
      // Escaping current SOI - use current body name (not encounter body)
      orbitalEvents.push({ name: `${soi} SOI Escape`, eta: etaTransition });
      // Add reentry placeholder - will be populated with time in G3 if encounter has atmosphere
      orbitalEvents.push({ name: '_ENC_REENTRY_', eta: 0 });
    } else {
      // Entering new SOI - placeholder for encounter body name
      orbitalEvents.push({ name: '_ENC_ SOI Change', eta: etaTransition });
    }
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
    // For sub_orbital, show smarter reentry/aerobraking status
    const baseStatus = hasNextPatch ? 'TRANSFERRING' : getReentryDisplayStatus(
      vesselStatus, per, altitude, atmHeight, hasAtmosphere
    );
    lines.push(`SOI: ${soiDisplay} (${baseStatus})`);
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
  const encDist = data.encDist || 0;
  const encAtmH = data.encAtmH || 0;
  const encPeTime = data.encPeTime || 0;
  const hasEncAtm = encAtmH > 0;

  // Update "Next:" line with encounter body name (replace _ENC_ placeholder)
  if (encounterBody && encounterBody !== soi) {
    // Update reentry event with actual time if encounter has atmosphere and crash trajectory
    if (hasEncAtm && encounterPe < 0 && encPeTime > 0) {
      // Atmosphere entry happens before periapsis - ~90% of the way there for steep trajectories
      const atmEntryTime = Math.round(encPeTime * 0.9);
      for (const event of orbitalEvents) {
        if (event.name === '_ENC_REENTRY_') {
          event.name = `${encounterBody} Reentry`;
          event.eta = atmEntryTime;
          break;
        }
      }
    } else {
      // Remove reentry placeholder if no atmosphere or not crash trajectory
      const idx = orbitalEvents.findIndex(e => e.name === '_ENC_REENTRY_');
      if (idx !== -1) orbitalEvents.splice(idx, 1);
    }

    // Update SOI Change placeholder with encounter body name
    for (const event of nextEvents) {
      if (event.name === '_ENC_ SOI Change') {
        event.name = `${encounterBody} SOI Change`;
      }
    }
  } else {
    // No encounter - remove reentry placeholder
    const idx = orbitalEvents.findIndex(e => e.name === '_ENC_REENTRY_');
    if (idx !== -1) orbitalEvents.splice(idx, 1);
  }

  // Re-sort and rebuild nextEvents after modifications
  orbitalEvents.sort((a, b) => a.eta - b.eta);
  const updatedNextEvents = orbitalEvents.filter(e => e.eta > 0).slice(0, 2);

  // Build "Next:" line now that we have encounter body name
  if (nextLineIndex >= 0 && updatedNextEvents.length > 0) {
    const eventStrs = updatedNextEvents.map(e => `${e.name} in ${formatTime(e.eta)}`);
    lines[nextLineIndex] = `Next: ${eventStrs.join(', ')}`;
  }

  // Encounter section - show even for negative periapsis (crash trajectories)
  if (encounterBody && encounterBody !== soi) {
    encounter = { body: encounterBody, periapsis: encounterPe };

    lines.push('', 'ENCOUNTER:');
    lines.push(`SOI: ${encounterBody}`);

    // Show ETA to SOI transition
    if (etaTransition > 0 && etaTransition < 1e10) {
      lines.push(`ETA: ${formatTime(etaTransition)}`);
    }

    // Show distance to atmosphere (or body if no atmosphere)
    if (encDist > 0) {
      const distToAtm = hasEncAtm ? encDist - encAtmH : encDist;
      lines.push(`Distance: ${fmtDist(distToAtm)}${hasEncAtm ? ' to atmosphere' : ''}`);
    }

    // Show periapsis with appropriate trajectory warning
    if (encounterPe < 0) {
      const belowSurface = Math.abs(encounterPe / 1000).toFixed(0);
      const trajectoryType = hasEncAtm ? 'REENTRY' : 'IMPACT';
      lines.push(`Periapsis: ${belowSurface}km below surface (${trajectoryType} TRAJECTORY)`);
    } else if (encounterPe < 10_000) {
      lines.push(`Periapsis: ${fmtDist(encounterPe)} (LOW)`);
    } else {
      lines.push(`Periapsis: ${fmtDist(encounterPe)}`);
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

  // Fallback: Build "Next:" line if G3 didn't populate it
  // Remove any remaining placeholders
  if (nextLineIndex >= 0 && lines[nextLineIndex] === '') {
    // Filter out placeholder events and clean up remaining placeholders
    const cleanedEvents = orbitalEvents
      .filter(e => e.eta > 0 && !e.name.startsWith('_ENC_'))
      .slice(0, 2);
    if (cleanedEvents.length > 0) {
      const eventStrs = cleanedEvents.map(e => `${e.name} in ${formatTime(e.eta)}`);
      lines[nextLineIndex] = `Next: ${eventStrs.join(', ')}`;
    } else {
      lines.splice(nextLineIndex, 1);  // Remove empty placeholder
    }
  }

  // ============================================================================
  // AVAILABLE TARGETS (from status data - no separate query needed)
  // ============================================================================
  const availableTargets: AvailableTargets = { moons: [], planets: [], vessels: [] };
  try {
    // Use targets from status data (already fetched)
    for (const t of data.targets || []) {
      if (t.type === 'moon') availableTargets.moons.push(t.name);
      else if (t.type === 'planet' && t.name.toLowerCase() !== soiParent.toLowerCase()) availableTargets.planets.push(t.name);
      else if (t.type === 'vessel') availableTargets.vessels.push(t.name);
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
        // Use queue() for clean output extraction
        const result = await conn.queue(
          'PRINT ADDONS:MJ:ASCENT:ENABLED + "|" + ADDONS:MJ:ASCENT:STATUS + "|" + ROUND(APOAPSIS) + "|" + ROUND(ALTITUDE).',
          3000
        );
        if (result.success) {
          const parts = result.output.split('|');
          if (parts.length >= 4) {
            const enabled = parts[0].toLowerCase() === 'true';
            const status = parts[1].trim() || 'Ascending';
            const apo = parseNumber(parts[2]);
            const alt = parseNumber(parts[3]);
            const detail = `Alt: ${(alt/1000).toFixed(1)}km, Apo: ${(apo/1000).toFixed(1)}km`;
            return { enabled, status, detail };
          }
        }
        break;
      }
      case 'landing': {
        // Use queue() for clean output extraction
        const result = await conn.queue(
          'PRINT ADDONS:MJ:LANDING:ENABLED + "|" + ADDONS:MJ:LANDING:STATUS + "|" + ROUND(ALTITUDE) + "|" + ROUND(SHIP:VERTICALSPEED).',
          3000
        );
        if (result.success) {
          const parts = result.output.split('|');
          if (parts.length >= 4) {
            const enabled = parts[0].toLowerCase() === 'true';
            const mjStatus = parts[1].trim();
            const alt = parseNumber(parts[2]);
            const vspeed = parseNumber(parts[3]);
            const status = mjStatus || (enabled ? 'Landing' : 'Idle');
            const detail = `Alt: ${(alt/1000).toFixed(1)}km, VSpeed: ${fmtVel(vspeed)}`;
            return { enabled, status, detail };
          }
        }
        break;
      }
      case 'node': {
        // Use queue() for clean output extraction
        const result = await conn.queue(
          'PRINT ADDONS:MJ:NODE:ENABLED + "|" + ADDONS:MJ:NODE:STATE + "|" + (CHOOSE ROUND(NEXTNODE:DELTAV:MAG,1) IF HASNODE ELSE 0).',
          3000
        );
        if (result.success) {
          const parts = result.output.split('|');
          if (parts.length >= 3) {
            const enabled = parts[0].toLowerCase() === 'true';
            const state = parts[1].trim();
            const dvRemaining = parseNumber(parts[2]);
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
    // Use queue() for clean output - single query checks all autopilot states
    const result = await conn.queue(
      'PRINT ADDONS:MJ:ASCENT:ENABLED + "|" + ADDONS:MJ:LANDING:ENABLED + "|" + ADDONS:MJ:NODE:ENABLED + "|" + ADDONS:MJ:NODE:STATE + "|" + (CHOOSE ROUND(NEXTNODE:DELTAV:MAG,1) IF HASNODE ELSE 0).',
      2000
    );
    if (!result.success) return null;

    const parts = result.output.split('|');
    if (parts.length < 5) return null;

    const ascentEnabled = parts[0].toLowerCase() === 'true';
    const landingEnabled = parts[1].toLowerCase() === 'true';
    const nodeEnabled = parts[2].toLowerCase() === 'true';
    const nodeState = parts[3];
    const nodeDv = parseNumber(parts[4]);

    // Check ascent (most likely during launch)
    if (ascentEnabled) {
      // Query ascent details only when needed
      const statusResult = await conn.queue(
        'PRINT ADDONS:MJ:ASCENT:STATUS + "|" + ROUND(APOAPSIS) + "|" + ROUND(ALTITUDE).',
        2000
      );
      if (statusResult.success) {
        const detailParts = statusResult.output.split('|');
        if (detailParts.length >= 3) {
          const status = detailParts[0].trim() || 'Ascending';
          const apo = parseNumber(detailParts[1]);
          const alt = parseNumber(detailParts[2]);
          return { opType: 'ascent', status, detail: `Alt: ${(alt/1000).toFixed(1)}km, Apo: ${(apo/1000).toFixed(1)}km` };
        }
      }
      return { opType: 'ascent', status: 'Ascending' };
    }

    // Check landing
    if (landingEnabled) {
      // Query landing details only when needed
      const statusResult = await conn.queue(
        'PRINT ROUND(ALTITUDE) + "|" + ROUND(SHIP:VERTICALSPEED).',
        2000
      );
      if (statusResult.success) {
        const detailParts = statusResult.output.split('|');
        if (detailParts.length >= 2) {
          const alt = parseNumber(detailParts[0]);
          const vspeed = parseNumber(detailParts[1]);
          return { opType: 'landing', status: 'Landing', detail: `Alt: ${(alt/1000).toFixed(1)}km, VSpeed: ${fmtVel(vspeed)}` };
        }
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
 * Get operation progress from a pre-fetched KosOperationState.
 * Use this variant when you already have the operation state to avoid
 * redundant status queries.
 */
export async function getOperationProgressFromKosOp(
  conn: KosConnection,
  kosOp: KosOperationState
): Promise<OperationProgress> {
  // Query MechJeb for current autopilot status (single query, no status script)
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
  description: 'Get simulation info: position, fuel, targets.',
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 2,
  handler: async (_args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const telemetry = await getStatus(conn);

      if (!telemetry.connected) {
        return ctx.errorResponse('status', telemetry.reason ?? 'Connection failed');
      }

      return ctx.successResponse('status', telemetry.formatted);
    } catch (error) {
      return ctx.errorResponse('status', error instanceof Error ? error.message : String(error));
    }
  },
};
