/**
 * Execute Maneuver Node - Library implementation
 *
 * Executes the next maneuver node using MechJeb's node executor autopilot.
 * Includes delta-v validation, auto-staging, time warp kicks, and retry logic.
 */

import type { KosConnection } from '../../transport/kos-connection.js';
import { delay, queryNumber, unlockControls } from './shared.js';
import { areWorkaroundsEnabled } from '../../config/workarounds.js';

export interface ExecuteNodeResult {
  success: boolean;
  nodesExecuted: number;
  error?: string;
  deltaV?: {
    required: number;
    available: number;
    remaining?: number;
  };
  attempts?: number;
}

export interface ExecuteNodeProgress {
  nodesRemaining: number;
  etaToNode: number;
  throttle: number;
  executing: boolean;
}

// Configuration
const MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
const DEFAULT_POLL_INTERVAL_MS = 10_000; // 10 seconds
const DV_THRESHOLD = 0.5; // m/s - consider burn complete below this

// Alignment configuration
const ALIGN_THRESHOLD = 3; // degrees - consider aligned below this
const RCS_TRIGGER_TIME = 3000; // ms - enable RCS if no progress after this
const MAX_ALIGN_TIME = 60_000; // ms - maximum time to wait for alignment

/**
 * Align ship to maneuver node using kOS LOCK STEERING before MechJeb takes over.
 * Enables RCS if no angular progress is made after 3 seconds.
 *
 * @param conn kOS connection
 */
async function alignToNode(conn: KosConnection): Promise<boolean> {
  // Check initial angle
  const initialAngle = await queryNumber(conn, 'VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR)');
  console.error(`[AlignToNode] Initial angle: ${initialAngle.toFixed(1)}°`);

  // Save RCS state
  const rcsState = await conn.execute('PRINT RCS.');
  const wasRcsOn = rcsState.output.includes('True');

  // Use SAS MANEUVER mode - handles node removal gracefully (unlike LOCK STEERING)
  // Must wait for SAS to initialize before setting mode
  await conn.execute('SAS ON. WAIT 1. SET SASMODE TO "MANEUVER". WAIT 0.5.');
  console.error('[AlignToNode] SAS set to MANEUVER mode, aligning...');

  let lastAngle = 180;
  let noProgressSince = Date.now();
  const startTime = Date.now();
  let aligned = false;

  while (Date.now() - startTime < MAX_ALIGN_TIME) {
    const angle = await queryNumber(conn, 'VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR)');
    console.error(`[AlignToNode] Angle: ${angle.toFixed(1)}°`);

    if (angle < ALIGN_THRESHOLD) {
      console.error(`[AlignToNode] Aligned! (${angle.toFixed(2)}°)`);
      aligned = true;
      break;
    }

    // Check for progress (improvement of at least 0.5 degrees)
    if (angle < lastAngle - 0.5) {
      noProgressSince = Date.now();
      lastAngle = angle;
    } else if (Date.now() - noProgressSince > RCS_TRIGGER_TIME) {
      // No progress for 3s - enable RCS to help rotation
      await conn.execute('RCS ON.');
      console.error(`[AlignToNode] No progress, enabled RCS (${angle.toFixed(1)}°)`);
      noProgressSince = Date.now(); // Reset timer after enabling RCS
    }

    await delay(500);
  }

  // Keep SAS in MANEUVER mode - MechJeb will take over when enabled
  // Restore RCS state only
  if (!wasRcsOn) {
    await conn.execute('RCS OFF.');
  }

  // Final verification
  const finalAngle = await queryNumber(conn, 'VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR)');
  console.error(`[AlignToNode] Final angle: ${finalAngle.toFixed(1)}°, aligned: ${aligned}`);

  return finalAngle < ALIGN_THRESHOLD;
}

interface ExecuteNodeOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  async?: boolean; // If true, return immediately after starting executor
}

/**
 * Execute the next maneuver node using MechJeb autopilot.
 *
 * Features:
 * - Delta-v validation before burn
 * - Auto-staging setup if needed
 * - Time warp kicks to unstick MechJeb alignment
 * - Retry logic for incomplete burns
 *
 * @param conn kOS connection
 * @param options Execution options (timeoutMs, pollIntervalMs, async)
 * @returns ExecuteNodeResult with success status and delta-v info
 */
export async function executeNode(
  conn: KosConnection,
  options: ExecuteNodeOptions = {}
): Promise<ExecuteNodeResult> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    async: asyncMode = false,
  } = options;
  // Check if a node exists
  const nodeCheck = await conn.execute('PRINT HASNODE.', 2000);
  if (!nodeCheck.output.includes('True')) {
    return { success: false, nodesExecuted: 0, error: 'No maneuver node found' };
  }

  // Get initial node count
  const initialCountResult = await conn.execute('PRINT ALLNODES:LENGTH.', 2000);
  const initialNodeCount = Number.parseInt(initialCountResult.output.match(/\d+/)?.[0] || '1');

  // Delta-v validation - use total ship delta-v for reliability
  const dvRequired = await queryNumber(conn, 'NEXTNODE:DELTAV:MAG');
  const dvShipTotal = await queryNumber(conn, 'SHIP:DELTAV:CURRENT');
  const dvCurrentStage = await queryNumber(conn, 'STAGE:DELTAV:CURRENT');

  // Determine if staging will be needed during burn
  const needsStaging = dvCurrentStage < dvRequired && dvShipTotal >= dvRequired;

  if (needsStaging) {
    console.error(`[ExecuteNode] Required: ${dvRequired.toFixed(1)} m/s, Current stage: ${dvCurrentStage.toFixed(1)} m/s, Ship total: ${dvShipTotal.toFixed(1)} m/s (will stage)`);
  } else {
    console.error(`[ExecuteNode] Required: ${dvRequired.toFixed(1)} m/s, Current stage: ${dvCurrentStage.toFixed(1)} m/s, Ship total: ${dvShipTotal.toFixed(1)} m/s`);
  }

  if (dvShipTotal < dvRequired) {
    const deficit = dvRequired - dvShipTotal;
    return {
      success: false,
      nodesExecuted: 0,
      error: `Insufficient delta-v: need ${dvRequired.toFixed(1)} m/s, have ${dvShipTotal.toFixed(1)} m/s (deficit: ${deficit.toFixed(1)} m/s). Consider adding more fuel or splitting the maneuver.`,
      deltaV: { required: dvRequired, available: dvShipTotal }
    };
  }

  // Get estimated burn duration from MechJeb INFO wrapper
  const burnDuration = await queryNumber(conn, 'ADDONS:MJ:INFO:NEXTMANEUVERNODEBURNTIME');
  const halfBurn = burnDuration / 2;
  console.error(`[ExecuteNode] Estimated burn: ${burnDuration.toFixed(1)}s, will shift node by ${halfBurn.toFixed(1)}s`);

  // Set up auto-staging if burn will require staging
  if (needsStaging) {
    console.error('[ExecuteNode] Setting up auto-staging trigger');
    await conn.execute('WHEN STAGE:DELTAV:CURRENT < 1 THEN { STAGE. PRINT "Auto-staged during burn". }');
  }

  // Align ship to maneuver node BEFORE warping
  const isAligned = await alignToNode(conn);
  if (!isAligned) {
    await conn.execute('SAS OFF.');
    const angle = await queryNumber(conn, 'VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR)');
    return {
      success: false,
      nodesExecuted: 0,
      error: `Failed to align ship to maneuver node. Current angle: ${angle.toFixed(1)}°`,
      deltaV: { required: dvRequired, available: dvShipTotal }
    };
  }

  // Warp to node if it's far away (more than 60s)
  const nodeEta = await queryNumber(conn, 'NEXTNODE:ETA');
  if (nodeEta > 60) {
    const warpLeadTime = 30; // Stop warping 30s before node
    console.error(`[ExecuteNode] Node is ${nodeEta.toFixed(0)}s away, warping to T-${warpLeadTime}s`);

    // Use KUNIVERSE:TIMEWARP:WARPTO which doesn't block
    await conn.execute(`KUNIVERSE:TIMEWARP:WARPTO(TIME:SECONDS + ${nodeEta - warpLeadTime}).`, 5000);

    // Wait for warp to complete (poll until ETA is close)
    let warpAttempts = 0;
    const maxWarpAttempts = 600; // Max 10 minutes of warp checking (1s poll interval)
    while (warpAttempts < maxWarpAttempts) {
      await delay(1000);
      const currentEta = await queryNumber(conn, 'NEXTNODE:ETA');
      if (currentEta <= warpLeadTime + 5) {
        console.error(`[ExecuteNode] Warp complete, ETA: ${currentEta.toFixed(0)}s`);
        break;
      }
      warpAttempts++;
      if (warpAttempts % 30 === 0) {
        console.error(`[ExecuteNode] Still warping, ETA: ${currentEta.toFixed(0)}s`);
      }
    }
  }

  // Retry loop for incomplete burns
  let lastAttempt = 0;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    lastAttempt = attempt;
    console.error(`[ExecuteNode] Attempt ${attempt}/${MAX_RETRIES}`);

    // Workaround: Shift node time earlier by half burn duration
    // MechJeb fires at node time instead of centering the burn
    if (areWorkaroundsEnabled() && halfBurn > 0) {
      await conn.execute(`SET nd TO NEXTNODE. SET nd:ETA TO nd:ETA - ${halfBurn.toFixed(1)}.`, 3000);
    }

    // Enable MechJeb node executor
    await conn.execute('SET ADDONS:MJ:NODE:ENABLED TO TRUE.', 5000);

    // Turn off SAS - MechJeb handles its own steering now
    await conn.execute('SAS OFF.');

    // Warp assist: if node > 30s away, briefly trigger 2x warp to help MechJeb take over steering
    // Only cancel warp if we actually set it (avoids interfering when warp wasn't needed)
    const warpCheckResult = await conn.execute('IF HASNODE { PRINT NEXTNODE:ETA. } ELSE { PRINT 0. }', 3000);
    const nodeEtaForWarp = Number.parseFloat(warpCheckResult.output.match(/\d[\d.]*/)?.[0] || '0');
    if (nodeEtaForWarp > 30) {
      await delay(3000);
      await conn.execute('SET WARP TO 1.');
      console.error('[ExecuteNode] Warp assist: triggered 2x warp for MechJeb takeover');

      // Brief delay then cancel - only runs if we set warp
      await delay(500);
      await conn.execute('SET WARP TO 0.');
    }

    // In async mode, return immediately after starting executor
    if (asyncMode) {
      return {
        success: true,
        nodesExecuted: 0, // Not yet executed, just started
        deltaV: { required: dvRequired, available: dvShipTotal },
        attempts: 1
      };
    }

    // Wait for execution with timeout
    const maxIterations = Math.ceil(timeoutMs / pollIntervalMs);
    let lastDvRemaining = dvRequired;

    for (let i = 0; i < maxIterations; i++) {
      await delay(pollIntervalMs);

      // Query progress - when MechJeb completes the burn, it removes the node
      // Using sentinel pattern via execute() ensures we get complete response
      const progressResult = await conn.execute(
        'IF HASNODE { PRINT NEXTNODE:DELTAV:MAG + "|" + ADDONS:MJ:NODE:ENABLED. } ELSE { PRINT "NONODE". }',
        3000
      );

      // Node removed = burn complete (MechJeb removes node when done)
      // IMPORTANT: Check for NONODE as actual output, not in command echo (which has "NONODE" in quotes)
      // The kOS output format after cleanOutput is like: `...PRINT "".NONODE` where NONODE is the actual result
      // We look for NONODE at end of string, after newline, or after the sentinel marker (PRINT "".)
      const isNoNode = /(?:^|\n|PRINT ""\.)NONODE(?:\n|$|")/i.test(progressResult.output);
      if (isNoNode) {
        return {
          success: true,
          nodesExecuted: initialNodeCount,
          deltaV: { required: dvRequired, available: dvShipTotal, remaining: 0 },
          attempts: attempt
        };
      }

      // Parse "dv|enabled" format
      // IMPORTANT: Use \d[\d.]* to require starting with a digit, not [\d.]+
      // Otherwise the sentinel's trailing dot (PRINT "".) gets matched as ".25.48..."
      // which parseFloat interprets as 0.25 instead of 25.48!
      const progressMatch = progressResult.output.match(/(\d[\d.]*)\|(True|False)/i);
      if (progressMatch) {
        const dvRemaining = Number.parseFloat(progressMatch[1]);
        const executorEnabled = progressMatch[2].toLowerCase() === 'true';
        lastDvRemaining = dvRemaining;

        // Log progress every poll (every 10s)
        console.error(`[ExecuteNode] Progress: ${dvRemaining.toFixed(1)} m/s remaining, executor: ${executorEnabled ? 'ON' : 'OFF'}`);

        // If dV is below threshold, burn is complete - clear node and return success
        if (dvRemaining < DV_THRESHOLD) {
          console.error(`[ExecuteNode] Burn complete! (${dvRemaining.toFixed(2)} m/s remaining < ${DV_THRESHOLD} m/s threshold)`);
          // Clear the residual node to avoid "No maneuver nodes present!" errors
          await conn.execute('IF HASNODE { REMOVE NEXTNODE. }', 3000);
          return {
            success: true,
            nodesExecuted: initialNodeCount,
            deltaV: { required: dvRequired, available: dvShipTotal, remaining: dvRemaining },
            attempts: attempt
          };
        }

        // If executor stopped but burn incomplete, check if we should retry
        if (!executorEnabled && dvRemaining > DV_THRESHOLD) {
          console.error(`[ExecuteNode] Executor stopped with ${dvRemaining.toFixed(1)} m/s remaining`);

          if (attempt < MAX_RETRIES) {
            console.error(`[ExecuteNode] Will retry (attempt ${attempt + 1}/${MAX_RETRIES})`);
            await delay(2000);
            break; // Break inner loop to retry
          } else {
            await unlockControls(conn);
            return {
              success: false,
              nodesExecuted: 0,
              error: `Burn incomplete after ${MAX_RETRIES} attempts. ${dvRemaining.toFixed(1)} m/s remaining.`,
              deltaV: { required: dvRequired, available: dvShipTotal, remaining: dvRemaining },
              attempts: attempt
            };
          }
        }
      }
    }

    // Timeout in this attempt
    if (attempt === MAX_RETRIES) {
      // Disable executor on final timeout
      await conn.execute('SET ADDONS:MJ:NODE:ENABLED TO FALSE.', 2000);
      await unlockControls(conn);

      return {
        success: false,
        nodesExecuted: 0,
        error: `Execution timeout after ${timeoutMs / 1000} seconds.`,
        deltaV: { required: dvRequired, available: dvShipTotal, remaining: lastDvRemaining },
        attempts: attempt
      };
    }
  }

  // Should not reach here, but just in case
  await unlockControls(conn);
  return {
    success: false,
    nodesExecuted: 0,
    error: 'Unexpected execution flow',
    attempts: lastAttempt
  };
}

/**
 * Get current node execution progress.
 *
 * @param conn kOS connection
 * @returns ExecuteNodeProgress with current status
 */
export async function getNodeProgress(conn: KosConnection): Promise<ExecuteNodeProgress> {
  const countResult = await conn.execute('PRINT ALLNODES:LENGTH.', 2000);
  const nodesRemaining = Number.parseInt(countResult.output.match(/\d+/)?.[0] || '0');

  if (nodesRemaining === 0) {
    return {
      nodesRemaining: 0,
      etaToNode: 0,
      throttle: 0,
      executing: false
    };
  }

  // Get ETA and throttle
  const statusResult = await conn.execute(
    'PRINT "ETA:" + ROUND(NEXTNODE:ETA) + " THR:" + ROUND(THROTTLE * 100).',
    2000
  );

  const etaMatch = statusResult.output.match(/ETA:(\d+)/);
  const thrMatch = statusResult.output.match(/THR:(\d+)/);

  return {
    nodesRemaining,
    etaToNode: etaMatch ? Number.parseInt(etaMatch[1]) : 0,
    throttle: thrMatch ? Number.parseInt(thrMatch[1]) : 0,
    executing: true
  };
}

/**
 * Check if MechJeb node executor is currently enabled.
 *
 * @param conn kOS connection
 * @returns true if executor is enabled
 */
export async function isNodeExecutorEnabled(conn: KosConnection): Promise<boolean> {
  const result = await conn.execute('PRINT ADDONS:MJ:NODE:ENABLED.', 2000);
  return result.output.includes('True');
}

/**
 * Disable the MechJeb node executor.
 *
 * @param conn kOS connection
 */
export async function disableNodeExecutor(conn: KosConnection): Promise<void> {
  await conn.execute('SET ADDONS:MJ:NODE:ENABLED TO FALSE.', 2000);
}
