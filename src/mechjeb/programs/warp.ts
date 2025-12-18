/**
 * Time warp library functions
 *
 * Uses outcome-based polling (similar to execute-node.ts pattern):
 * - Instead of polling WARP=0, poll the actual outcome (body change, ETA, etc.)
 * - This is more reliable during high time warp when kOS responses can be delayed
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { crashAvoidance } from './manual/index.js';

const POLL_INTERVAL_MS = 2000;  // Poll every 2s
const DEFAULT_TIMEOUT_MS = 300000; // 5 minutes for long warps

export type WarpTarget = 'node' | 'soi' | 'periapsis' | 'apoapsis';

export interface WarpOptions {
  /** Lead time in seconds before target (default: 0) */
  leadTime?: number;
  /** Timeout for warp completion in ms (default: 300000 = 5 minutes) */
  timeout?: number;
}

export interface WarpResult {
  success: boolean;
  error?: string;
  body?: string;
  altitude?: number;
  warning?: string;      // Warning message (e.g., crash trajectory)
  periapsis?: number;    // Periapsis in new SOI (meters)
  bodyRadius?: number;   // Body radius for context
  crashAvoidance?: {     // Crash avoidance results (if triggered)
    triggered: boolean;
    initialPeriapsis: number;
    finalPeriapsis: number;
    deltaVUsed: number;
  };
}

/**
 * Helper to query a value from kOS
 */
async function queryValue(conn: KosConnection, expr: string): Promise<string> {
  const result = await conn.execute(`PRINT ${expr}.`, 3000);
  return result.output.trim();
}

/**
 * Warp to a specific target (node, soi, periapsis, apoapsis)
 */
export async function warpTo(
  conn: KosConnection,
  target: WarpTarget,
  options: WarpOptions = {}
): Promise<WarpResult> {
  const leadTime = options.leadTime ?? 0;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;

  switch (target) {
    case 'node':
      return await warpToNode(conn, leadTime, timeout);
    case 'soi':
      return await warpToSOI(conn, leadTime, timeout);
    case 'periapsis':
      return await warpToOrbitalPoint(conn, 'PERIAPSIS', leadTime, timeout);
    case 'apoapsis':
      return await warpToOrbitalPoint(conn, 'APOAPSIS', leadTime, timeout);
  }
}

/**
 * Warp to maneuver node
 */
async function warpToNode(
  conn: KosConnection,
  leadTime: number,
  timeout: number
): Promise<WarpResult> {
  // Check if node exists
  const nodeCheck = await conn.execute('PRINT HASNODE.');
  if (!nodeCheck.output.toLowerCase().includes('true')) {
    return { success: false, error: 'No maneuver node found' };
  }

  // Get initial ETA
  const initialEta = parseFloat(await queryValue(conn, 'NEXTNODE:ETA'));
  if (initialEta <= leadTime) {
    // Already close enough
    return await getBasicStatus(conn);
  }

  console.error(`[Warp] Warping to node T-${leadTime}s (ETA: ${initialEta.toFixed(0)}s)`);

  // Start warp
  await conn.execute(`KUNIVERSE:TIMEWARP:WARPTO(NEXTNODE:TIME - ${leadTime}).`, 5000);

  // Poll ETA until we're close to target
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    const currentEta = parseFloat(await queryValue(conn, 'NEXTNODE:ETA'));
    console.error(`[Warp] Node ETA: ${currentEta.toFixed(0)}s`);

    if (currentEta <= leadTime + 5) {
      console.error('[Warp] Node warp complete');
      return await getBasicStatus(conn);
    }
  }

  return { success: false, error: 'Warp timeout' };
}

/**
 * Warp to SOI transition, then cross into new SOI
 */
async function warpToSOI(
  conn: KosConnection,
  leadTime: number,
  timeout: number
): Promise<WarpResult> {
  // Check for SOI transition
  const soiCheck = await conn.execute('PRINT SHIP:ORBIT:HASNEXTPATCH.');
  if (!soiCheck.output.toLowerCase().includes('true')) {
    return { success: false, error: 'No SOI transition in current trajectory' };
  }

  // Get current body and SOI transition ETA
  const currentBody = await queryValue(conn, 'SHIP:BODY:NAME');
  const soiEta = parseFloat(await queryValue(conn, 'SHIP:ORBIT:NEXTPATCHETA'));

  console.error(`[Warp] Current body: ${currentBody}, SOI transition in ${soiEta.toFixed(0)}s`);

  // Start warp to SOI transition
  await conn.execute(`KUNIVERSE:TIMEWARP:WARPTO(TIME:SECONDS + SHIP:ORBIT:NEXTPATCHETA - ${leadTime}).`, 5000);

  // Poll body name until it changes
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    const newBody = await queryValue(conn, 'SHIP:BODY:NAME');

    // Check if body changed (we crossed SOI)
    if (newBody.toLowerCase() !== currentBody.toLowerCase()) {
      console.error(`[Warp] Crossed into ${newBody} SOI`);

      // Wait for warp to fully stop and KSP to settle
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Get SOI info including periapsis check
      return await getSOIStatus(conn, newBody);
    }

    // Also check if we're getting close to transition (within leadTime)
    const remainingEta = parseFloat(await queryValue(conn, 'SHIP:ORBIT:NEXTPATCHETA'));
    if (remainingEta < 100000) { // Only log if ETA is reasonable
      console.error(`[Warp] SOI ETA: ${remainingEta.toFixed(0)}s`);
    }
  }

  return { success: false, error: 'SOI warp timeout' };
}

/**
 * Warp to periapsis or apoapsis
 */
async function warpToOrbitalPoint(
  conn: KosConnection,
  point: 'PERIAPSIS' | 'APOAPSIS',
  leadTime: number,
  timeout: number
): Promise<WarpResult> {
  // Get initial ETA
  const initialEta = parseFloat(await queryValue(conn, `ETA:${point}`));
  if (initialEta <= leadTime) {
    return await getBasicStatus(conn);
  }

  console.error(`[Warp] Warping to ${point.toLowerCase()} T-${leadTime}s (ETA: ${initialEta.toFixed(0)}s)`);

  // Start warp
  await conn.execute(`KUNIVERSE:TIMEWARP:WARPTO(TIME:SECONDS + ETA:${point} - ${leadTime}).`, 5000);

  // Poll ETA until we're close
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    const currentEta = parseFloat(await queryValue(conn, `ETA:${point}`));
    console.error(`[Warp] ${point} ETA: ${currentEta.toFixed(0)}s`);

    if (currentEta <= leadTime + 5) {
      console.error(`[Warp] ${point.toLowerCase()} warp complete`);
      return await getBasicStatus(conn);
    }
  }

  return { success: false, error: 'Warp timeout' };
}

/**
 * Get basic status (body and altitude)
 */
async function getBasicStatus(conn: KosConnection): Promise<WarpResult> {
  const statusResult = await conn.execute('PRINT SHIP:BODY:NAME + "," + ROUND(ALTITUDE).');
  const parts = statusResult.output.split(',');
  return {
    success: true,
    body: parts[0]?.trim(),
    altitude: parseInt(parts[1]?.trim() || '0'),
  };
}

/**
 * Get SOI status with crash trajectory check
 */
async function getSOIStatus(conn: KosConnection, body: string): Promise<WarpResult> {
  const soiInfo = await conn.execute(
    'PRINT "SOI:" + SHIP:BODY:NAME + "|" + ROUND(ALTITUDE) + "|" + ROUND(PERIAPSIS) + "|" + ROUND(SHIP:BODY:RADIUS).',
    5000
  );

  // Parse structured output
  const soiMatch = soiInfo.output.match(/SOI:([^|]+)\|(-?\d+)\|(-?\d+)\|(\d+)/);
  if (!soiMatch) {
    console.error(`[Warp] SOI info parse failed: ${soiInfo.output}`);
    return { success: true, body, altitude: 0 };
  }

  const newBody = soiMatch[1].trim();
  const altitude = parseInt(soiMatch[2]);
  const periapsis = parseInt(soiMatch[3]);
  const bodyRadius = parseInt(soiMatch[4]);

  console.error(`[Warp] In ${newBody} SOI: alt=${altitude}m, pe=${periapsis}m`);

  // Check for crash trajectory (periapsis below surface) - auto-trigger crash avoidance
  if (periapsis < 0) {
    console.error(`[Warp] ⚠️ CRASH TRAJECTORY DETECTED: Pe=${periapsis}m - triggering crash avoidance...`);

    const avoidanceResult = await crashAvoidance(conn);

    if (avoidanceResult.success) {
      return {
        success: true,
        body: newBody,
        altitude,
        periapsis: avoidanceResult.finalPeriapsis,
        bodyRadius,
        warning: `⚠️ Crash trajectory detected! Auto-avoided: Pe ${(periapsis / 1000).toFixed(1)}km → ${((avoidanceResult.finalPeriapsis ?? 0) / 1000).toFixed(1)}km (${avoidanceResult.deltaVUsed?.toFixed(1)} m/s)`,
        crashAvoidance: {
          triggered: true,
          initialPeriapsis: periapsis,
          finalPeriapsis: avoidanceResult.finalPeriapsis ?? 0,
          deltaVUsed: avoidanceResult.deltaVUsed ?? 0,
        },
      };
    } else {
      // Crash avoidance failed
      return {
        success: true,
        body: newBody,
        altitude,
        periapsis,
        bodyRadius,
        warning: `⚠️ CRASH TRAJECTORY: Periapsis ${(periapsis / 1000).toFixed(0)}km - crash avoidance FAILED: ${avoidanceResult.error}`,
        crashAvoidance: {
          triggered: true,
          initialPeriapsis: periapsis,
          finalPeriapsis: avoidanceResult.finalPeriapsis ?? periapsis,
          deltaVUsed: avoidanceResult.deltaVUsed ?? 0,
        },
      };
    }
  }

  return {
    success: true,
    body: newBody,
    altitude,
    periapsis,
    bodyRadius,
  };
}

/**
 * Warp forward by a specific number of seconds
 */
export async function warpForward(
  conn: KosConnection,
  seconds: number,
  timeout: number = DEFAULT_TIMEOUT_MS
): Promise<WarpResult> {
  console.error(`[Warp] Warping forward ${seconds}s...`);

  // Get target time
  const targetTime = Date.now() + (seconds * 1000);

  // Start warp
  await conn.execute(`KUNIVERSE:TIMEWARP:WARPTO(TIME:SECONDS + ${seconds}).`, 5000);

  // Wait for real time to pass (warp should complete before this)
  // Poll WARP status until it's 0
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    const warpResult = await conn.execute('PRINT WARP.', 3000);
    const warpMatch = warpResult.output.match(/^(\d+)/);
    const warpLevel = warpMatch ? parseInt(warpMatch[1], 10) : -1;

    if (warpLevel === 0) {
      console.error('[Warp] Forward warp complete');
      return await getBasicStatus(conn);
    }

    console.error(`[Warp] Warp level: ${warpLevel}`);
  }

  return { success: false, error: 'Warp timeout' };
}

/**
 * Stop any active time warp
 */
export async function stopWarp(conn: KosConnection): Promise<void> {
  await conn.execute('SET WARP TO 0.');
}
