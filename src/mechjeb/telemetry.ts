/**
 * MechJeb Telemetry Wrappers
 *
 * Provides structured access to vessel state and MechJeb info
 */

import type { KosConnection } from '../transport/kos-connection.js';
import type { VesselState, OrbitInfo, MechJebInfo } from './types.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse a numeric value from kOS output
 */
function parseNumber(output: string): number {
  const match = output.match(/-?[\d.]+(?:E[+-]?\d+)?/i);
  return match ? parseFloat(match[0]) : 0;
}

/**
 * Execute a query and parse the numeric result
 */
async function queryNumber(conn: KosConnection, suffix: string): Promise<number> {
  const result = await conn.execute(`PRINT ${suffix}.`);
  return parseNumber(result.output);
}

/**
 * Query multiple values in a batch (comma-separated)
 * Returns array of numbers in order
 */
async function queryNumbers(conn: KosConnection, suffixes: string[]): Promise<number[]> {
  const expr = suffixes.map(s => s).join(' + "," + ');
  const result = await conn.execute(`PRINT ${expr}.`);

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

  await delay(500);
  const [heading, pitch, roll] = await queryNumbers(conn, [
    'ADDONS:MJ:VESSEL:VESSELHEADING',
    'ADDONS:MJ:VESSEL:VESSELPITCH',
    'ADDONS:MJ:VESSEL:VESSELROLL'
  ]);

  await delay(500);
  const [dynPressure, aoa, mach] = await queryNumbers(conn, [
    'ADDONS:MJ:VESSEL:DYNAMICPRESSURE',
    'ADDONS:MJ:VESSEL:AOA',
    'ADDONS:MJ:VESSEL:MACH'
  ]);

  await delay(500);
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
  await delay(500);
  const localTwr = await safeQueryNumber(conn, 'ADDONS:MJ:INFO:LOCALTWR');
  await delay(500);
  const thrust = await safeQueryNumber(conn, 'ADDONS:MJ:INFO:CURRENTTHRUST');
  await delay(500);
  const maxThrust = await safeQueryNumber(conn, 'ADDONS:MJ:INFO:MAXTHRUST');
  await delay(500);
  const accel = await safeQueryNumber(conn, 'ADDONS:MJ:INFO:ACCELERATION');

  // Optional values
  await delay(500);
  const nextNodeDeltaV = await safeQueryNumber(conn, 'ADDONS:MJ:INFO:NEXTMANEUVERNODEDELTAV') || undefined;
  await delay(500);
  const timeToNode = await safeQueryNumber(conn, 'ADDONS:MJ:INFO:TIMETOMANEUVERNODE') || undefined;
  await delay(500);
  const timeToImpact = await safeQueryNumber(conn, 'ADDONS:MJ:INFO:TIMETOIMPACT') || undefined;
  await delay(500);
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

  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  } else {
    return `${minutes}m ${secs}s`;
  }
}

/**
 * Comprehensive ship telemetry for operation outputs
 * Includes orbit, SOI, maneuver info, and encounter data
 *
 * Note: This is an opt-in tool, so minimal delays are used.
 * Users explicitly request this and expect to wait.
 */
export async function getShipTelemetry(conn: KosConnection): Promise<string> {
  const lines: string[] = [];

  // Current SOI and basic stats - batch query for speed
  const soiResult = await conn.execute('PRINT SHIP:ORBIT:BODY:NAME.');
  // Output includes command echo, extract just the body name (last word)
  const soiParts = soiResult.output.trim().replace(/"/g, '').split(/\s+/);
  const soi = soiParts[soiParts.length - 1] || 'Unknown';

  const [alt, apo, per, speed] = await queryNumbers(conn, [
    'ALTITUDE',
    'APOAPSIS',
    'PERIAPSIS',
    'VELOCITY:ORBIT:MAG'
  ]);

  lines.push('=== Ship Status ===');
  lines.push(`SOI: ${soi}`);
  lines.push(`Altitude: ${(alt / 1000).toFixed(1)} km`);
  lines.push(`Apoapsis: ${(apo / 1000).toFixed(1)} km`);
  lines.push(`Periapsis: ${(per / 1000).toFixed(1)} km`);
  lines.push(`Orbital Speed: ${speed.toFixed(1)} m/s`);

  // Check for maneuver node
  const hasNodeResult = await conn.execute('PRINT HASNODE.');
  if (hasNodeResult.output.includes('True')) {
    const [nodeDv, nodeEta] = await queryNumbers(conn, [
      'NEXTNODE:DELTAV:MAG',
      'NEXTNODE:ETA'
    ]);

    // Estimate burn time (rough): dV / (TWR * 9.81) assuming average TWR of 1.5
    const estimatedBurnTime = nodeDv / (1.5 * 9.81);

    lines.push('');
    lines.push('=== Next Maneuver ===');
    lines.push(`Delta-V: ${nodeDv.toFixed(1)} m/s`);
    lines.push(`Time to node: ${formatTime(nodeEta)}`);
    lines.push(`Est. burn time: ${formatTime(estimatedBurnTime)}`);
  }

  // Check for encounter
  const hasEncounterResult = await conn.execute('PRINT ORBIT:HASNEXTPATCH.');
  if (hasEncounterResult.output.includes('True')) {
    const encounterBodyResult = await conn.execute('PRINT ORBIT:NEXTPATCH:BODY:NAME.');
    // Output includes command echo, extract just the body name (last word)
    const encounterParts = encounterBodyResult.output.trim().replace(/"/g, '').split(/\s+/);
    const encounterBody = encounterParts[encounterParts.length - 1] || 'Unknown';

    const [encounterPe, encounterEta] = await queryNumbers(conn, [
      'ORBIT:NEXTPATCH:PERIAPSIS',
      'ORBIT:NEXTPATCH:ETA'
    ]);

    lines.push('');
    lines.push('=== Encounter ===');
    lines.push(`Target: ${encounterBody}`);
    lines.push(`Periapsis: ${(encounterPe / 1000).toFixed(1)} km`);
    lines.push(`Time to encounter: ${formatTime(encounterEta)}`);
  }

  return lines.join('\n');
}
