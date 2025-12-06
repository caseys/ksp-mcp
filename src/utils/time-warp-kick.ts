/**
 * Time Warp Kick Utility
 *
 * MechJeb often gets stuck during ship alignment and fails to start auto time warp.
 * This utility "kicks" time warp by starting it briefly (~1 second) then stopping,
 * which triggers MechJeb to properly take over time warp management.
 */

import type { KosConnection } from '../transport/kos-connection.js';

export interface TimeWarpKickOptions {
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
export async function timeWarpKick(
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
 * Install a WHEN trigger to perform time warp kick after a condition is met.
 *
 * This is useful for triggering the kick when a burn completes or when
 * approaching a maneuver node.
 *
 * @param conn kOS connection
 * @param condition kOS condition expression (e.g., "NOT HASNODE")
 * @param bufferSeconds Additional delay in seconds before kick (default: 10)
 * @returns Cleanup function to remove the trigger
 */
export async function installTimeWarpKickTrigger(
  conn: KosConnection,
  condition: string,
  bufferSeconds: number = 10
): Promise<() => Promise<void>> {
  const triggerScript = `
    WHEN ${condition} THEN {
      PRINT "Time warp kick trigger activated, waiting ${bufferSeconds}s buffer...".
      WAIT ${bufferSeconds}.
      PRINT "Performing time warp kick...".
      SET WARP TO 1.
      WAIT 1.
      SET WARP TO 0.
      PRINT "Time warp kick complete.".
    }
  `.trim();

  await conn.execute(triggerScript);

  console.error(`[TimeWarpKick] Installed trigger: WHEN ${condition}`);

  // Return cleanup function (note: kOS doesn't have a way to remove WHEN triggers,
  // but they're one-shot by default unless PRESERVE is used)
  return async () => {
    console.error('[TimeWarpKick] Trigger will fire once and self-remove');
  };
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

/**
 * Install a delayed time warp kick trigger.
 *
 * Useful for post-burn scenarios where MechJeb needs to coast to next maneuver.
 *
 * @param conn kOS connection
 * @param delaySeconds Delay in seconds before performing kick
 */
export async function delayedTimeWarpKick(
  conn: KosConnection,
  delaySeconds: number
): Promise<void> {
  const script = `
    PRINT "Delayed time warp kick scheduled in ${delaySeconds}s...".
    WAIT ${delaySeconds}.
    PRINT "Performing time warp kick...".
    SET WARP TO 1.
    WAIT 1.
    SET WARP TO 0.
    PRINT "Time warp kick complete.".
  `.trim();

  await conn.execute(script);
  console.error(`[TimeWarpKick] Delayed kick scheduled for ${delaySeconds}s`);
}
