/**
 * Time Warp Kick Utility
 *
 * MechJeb often gets stuck during ship alignment and fails to start auto time warp.
 * This utility "kicks" time warp by starting it briefly (~1 second) then stopping,
 * which triggers MechJeb to properly take over time warp management.
 */

import type { KosConnection } from '../transport/kos-connection.js';

interface TimeWarpKickOptions {
  /** Duration to run time warp in milliseconds (default: 1000ms = 1 second) */
  duration?: number;

  /** Time warp rate to use (1-4 for physics warp, 5-7 for rails warp) */
  warpRate?: number;

  /** Delay after kick before continuing (default: 500ms) */
  postKickDelay?: number;
}

/**
 * Perform a time warp kick to trigger MechJeb's auto warp.
 *
 * This temporarily starts time warp, then stops it, which "kicks" MechJeb
 * into properly managing time warp when it gets stuck during alignment.
 *
 * @param conn kOS connection
 * @param options Time warp kick configuration
 */
async function timeWarpKick(
  conn: KosConnection,
  options: TimeWarpKickOptions = {}
): Promise<void> {
  const {
    duration = 1000,
    warpRate = 1,
    postKickDelay = 500,
  } = options;

  console.error(`[TimeWarpKick] Starting time warp kick (rate: ${warpRate}, duration: ${duration}ms)`);

  // Start time warp
  await conn.execute(`SET WARP TO ${warpRate}.`);

  // Wait for the kick duration
  await new Promise(resolve => setTimeout(resolve, duration));

  // Stop time warp
  await conn.execute('SET WARP TO 0.');

  // Small delay to let MechJeb react
  await new Promise(resolve => setTimeout(resolve, postKickDelay));

  console.error('[TimeWarpKick] Time warp kick complete');
}

/**
 * Perform an immediate time warp kick for situations where time warp should start right away.
 *
 * @param conn kOS connection
 */
export async function immediateTimeWarpKick(conn: KosConnection): Promise<void> {
  await timeWarpKick(conn, {
    duration: 1000,
    warpRate: 1,
    postKickDelay: 500,
  });
}

