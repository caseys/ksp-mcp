/**
 * Execute Maneuver Node - Library implementation
 *
 * Executes the next maneuver node using MechJeb's node executor autopilot.
 * Includes delta-v validation, auto-staging, time warp kicks, and retry logic.
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { delay, parseNumber, queryNumber, queryTime } from '../shared.js';
import { immediateTimeWarpKick, installTimeWarpKickTrigger } from '../../../utils/time-warp-kick.js';

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
const DEFAULT_TIMEOUT_MS = 600000; // 10 minutes
const DEFAULT_POLL_INTERVAL_MS = 5000; // 5 seconds
const DV_THRESHOLD = 0.5; // m/s - consider burn complete below this

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
 * @param timeoutMs Maximum time to wait for node execution (default: 10 minutes)
 * @param pollIntervalMs How often to check progress (default: 5 seconds)
 * @returns ExecuteNodeResult with success status and delta-v info
 */
export async function executeNode(
  conn: KosConnection,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
): Promise<ExecuteNodeResult> {
  // Check if a node exists
  const nodeCheck = await conn.execute('PRINT HASNODE.', 2000);
  if (!nodeCheck.output.includes('True')) {
    return { success: false, nodesExecuted: 0, error: 'No maneuver node found' };
  }

  // Get initial node count
  const initialCountResult = await conn.execute('PRINT ALLNODES:LENGTH.', 2000);
  const initialNodeCount = parseInt(initialCountResult.output.match(/\d+/)?.[0] || '1');

  // Delta-v validation
  const dvRequired = await queryNumber(conn, 'NEXTNODE:DELTAV:MAG');
  const dvCurrent = await queryNumber(conn, 'STAGE:DELTAV:CURRENT');
  const stageNum = await queryNumber(conn, 'STAGE:NUMBER');

  console.error(`[ExecuteNode] Required: ${dvRequired.toFixed(1)} m/s, Current stage: ${dvCurrent.toFixed(1)} m/s, Stage: ${stageNum}`);

  // Check if we have enough delta-v (including next stage if needed)
  let totalDv = dvCurrent;
  let needsStaging = false;

  if (dvCurrent < dvRequired && stageNum > 0) {
    // Check next stage's delta-v
    const dvNextStage = await queryNumber(conn, `SHIP:STAGEDELTAV(${stageNum - 1}):CURRENT`);
    totalDv = dvCurrent + dvNextStage;
    needsStaging = true;
    console.error(`[ExecuteNode] Next stage adds ${dvNextStage.toFixed(1)} m/s, total: ${totalDv.toFixed(1)} m/s`);

    if (totalDv < dvRequired) {
      // Still not enough even with next stage
      const deficit = dvRequired - totalDv;
      return {
        success: false,
        nodesExecuted: 0,
        error: `Insufficient delta-v: need ${dvRequired.toFixed(1)} m/s, have ${totalDv.toFixed(1)} m/s (deficit: ${deficit.toFixed(1)} m/s). Consider adding more fuel or splitting the maneuver.`,
        deltaV: { required: dvRequired, available: totalDv }
      };
    }
  }

  // Set up auto-staging if burn will require staging
  if (needsStaging) {
    console.error('[ExecuteNode] Setting up auto-staging trigger');
    await conn.execute('WHEN STAGE:DELTAV:CURRENT < 1 THEN { STAGE. PRINT "Auto-staged during burn". }');
  }

  // Warp to node if it's far away (more than 120s)
  const nodeEta = await queryNumber(conn, 'NEXTNODE:ETA');
  if (nodeEta > 120) {
    const warpLeadTime = 60; // Stop warping 60s before node
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

    // Enable MechJeb node executor
    await conn.execute('SET ADDONS:MJ:NODE:ENABLED TO TRUE.', 5000);

    // Time warp kick to unstick alignment (brief delay for MechJeb to start aligning)
    await delay(500);
    await immediateTimeWarpKick(conn);

    // Install post-burn time warp kick trigger
    await installTimeWarpKickTrigger(conn, 'NOT HASNODE', 10);

    // Wait for execution with timeout
    const maxIterations = Math.ceil(timeoutMs / pollIntervalMs);
    let lastNodeCount = initialNodeCount;

    for (let i = 0; i < maxIterations; i++) {
      await delay(pollIntervalMs);

      // Single atomic query: node count, deltaV remaining, executor status
      const pollResult = await conn.execute(
        'IF ALLNODES:LENGTH > 0 { PRINT "POLL|" + ALLNODES:LENGTH + "|" + NEXTNODE:DELTAV:MAG + "|" + ADDONS:MJ:NODE:ENABLED. } ELSE { PRINT "POLL|0|0|False". }',
        3000
      );

      // Parse "POLL|count|dv|enabled" format
      const pollMatch = pollResult.output.match(/POLL\|(\d+)\|([\d.]+)\|(True|False)/i);

      // If parse fails, continue polling (transient error)
      if (!pollMatch) {
        console.error(`[ExecuteNode] Poll parse failed, continuing. Raw: ${pollResult.output.slice(0, 100)}`);
        continue;
      }

      const currentNodes = parseInt(pollMatch[1]);
      const dvRemaining = parseFloat(pollMatch[2]);
      const executorEnabled = pollMatch[3].toLowerCase() === 'true';

      if (currentNodes === 0) {
        // All nodes executed successfully
        return {
          success: true,
          nodesExecuted: initialNodeCount,
          deltaV: { required: dvRequired, available: totalDv, remaining: 0 },
          attempts: attempt
        };
      }

      // Log progress periodically
      if (i % 6 === 0) { // Every 30 seconds at 5s polling
        console.error(`[ExecuteNode] Progress: ${dvRemaining.toFixed(1)} m/s remaining, executor: ${executorEnabled ? 'ON' : 'OFF'}`);
      }

      // If executor stopped but burn incomplete, check if we should retry
      if (!executorEnabled && dvRemaining > DV_THRESHOLD) {
        console.error(`[ExecuteNode] Executor stopped with ${dvRemaining.toFixed(1)} m/s remaining`);

        if (attempt < MAX_RETRIES) {
          // Retry
          console.error(`[ExecuteNode] Will retry (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await delay(2000);
          break; // Break inner loop to retry
        } else {
          // Final attempt failed
          return {
            success: false,
            nodesExecuted: initialNodeCount - currentNodes,
            error: `Burn incomplete after ${MAX_RETRIES} attempts. ${dvRemaining.toFixed(1)} m/s remaining.`,
            deltaV: { required: dvRequired, available: totalDv, remaining: dvRemaining },
            attempts: attempt
          };
        }
      }

      lastNodeCount = currentNodes;
    }

    // Timeout in this attempt
    if (attempt === MAX_RETRIES) {
      // Disable executor on final timeout
      await conn.execute('SET ADDONS:MJ:NODE:ENABLED TO FALSE.', 2000);

      const dvRemaining = await queryNumber(conn, 'HASNODE ? NEXTNODE:DELTAV:MAG : 0');

      return {
        success: false,
        nodesExecuted: initialNodeCount - lastNodeCount,
        error: `Execution timeout after ${timeoutMs / 1000} seconds. ${lastNodeCount} node(s) remaining.`,
        deltaV: { required: dvRequired, available: totalDv, remaining: dvRemaining },
        attempts: attempt
      };
    }
  }

  // Should not reach here, but just in case
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
  const nodesRemaining = parseInt(countResult.output.match(/\d+/)?.[0] || '0');

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
    etaToNode: etaMatch ? parseInt(etaMatch[1]) : 0,
    throttle: thrMatch ? parseInt(thrMatch[1]) : 0,
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
