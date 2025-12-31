/**
 * Execute Maneuver Node - Library implementation
 *
 * Executes the next maneuver node using MechJeb's node executor autopilot.
 * Includes delta-v validation, auto-staging, time warp kicks, and retry logic.
 */

import type { KosConnection } from '../../transport/kos-connection.js';
import { queryNumber, unlockControls } from './shared.js';
import { delay } from '../utils/progress.js';
import { formatTime } from '../utils/format.js';
import { areWorkaroundsEnabled } from '../../config/workarounds.js';
import { type McpLogger, nullLogger } from '../tool-types.js';
import { kickstartWarp, stopWarp } from '../kos/warp.js';
import { pollWithBlackoutResilience } from '../../utils/poll-with-resilience.js';

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
const DV_THRESHOLD = 1; // m/s - consider burn complete below this

// Alignment configuration
const ALIGN_THRESHOLD = 3; // degrees - consider aligned below this
const RCS_TRIGGER_TIME = 3000; // ms - enable RCS if no progress after this
const MAX_ALIGN_TIME = 60_000; // ms - maximum time to wait for alignment

/**
 * Format MechJeb node executor state for display
 * States: IDLE, WARPALIGN, LEAD, BURN
 */
function formatExecutorState(state: string): string {
  switch (state.toUpperCase()) {
    case 'WARPALIGN': return 'Aligning to node';
    case 'LEAD': return 'Coasting to burn';
    case 'BURN': return 'Burning';
    case 'IDLE': return 'Idle';
    default: return state;
  }
}

/**
 * Align ship to maneuver node using kOS LOCK STEERING before MechJeb takes over.
 * Enables RCS if no angular progress is made after 3 seconds.
 *
 * @param conn kOS connection
 * @param logger Optional MCP logger for progress updates
 */
async function alignToNode(conn: KosConnection, logger?: McpLogger): Promise<boolean> {
  const log = logger ?? nullLogger;

  // Check initial angle
  const initialAngle = await queryNumber(conn, 'VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR)');
  log.progress(`[AlignToNode] Initial angle: ${initialAngle.toFixed(1)}°`);

  // Save RCS state
  const rcsState = await conn.execute('PRINT RCS.');
  const wasRcsOn = rcsState.output.includes('True');

  // Use SAS MANEUVER mode - handles node removal gracefully (unlike LOCK STEERING)
  // Must wait for SAS to initialize before setting mode
  await conn.execute('SAS ON. WAIT 1. SET SASMODE TO "MANEUVER". WAIT 0.5.');
  log.progress('[AlignToNode] SAS set to MANEUVER mode, aligning...');

  let lastAngle = 180;
  let noProgressSince = Date.now();

  interface AlignState {
    angle: number;
    aligned: boolean;
  }

  const result = await pollWithBlackoutResilience<AlignState>({
    poll: async () => {
      const angle = await queryNumber(conn, 'VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR)');
      return { angle, aligned: angle < ALIGN_THRESHOLD };
    },

    isDone: (state) => state.aligned,
    isSuccess: (state) => state.aligned,

    timeoutMs: MAX_ALIGN_TIME,
    pollIntervalMs: 750,
    logger: log,
    context: 'AlignToNode',
    connection: conn,

    onPoll: async (state) => {
      log.progress(`[AlignToNode] Angle: ${state.angle.toFixed(1)}°`);

      if (state.aligned) {
        log.progress(`[AlignToNode] Aligned! (${state.angle.toFixed(2)}°)`);
        return;
      }

      // Check for progress (improvement of at least 0.5 degrees)
      if (state.angle < lastAngle - 0.5) {
        noProgressSince = Date.now();
        lastAngle = state.angle;
      } else if (Date.now() - noProgressSince > RCS_TRIGGER_TIME) {
        // No progress for 3s - enable RCS to help rotation
        try {
          await conn.execute('RCS ON.');
          log.progress(`[AlignToNode] No progress, enabled RCS (${state.angle.toFixed(1)}°)`);
          noProgressSince = Date.now(); // Reset timer after enabling RCS
        } catch {
          // Ignore RCS enable errors during blackout
        }
      }
    },
  });

  // Keep SAS in MANEUVER mode - MechJeb will take over when enabled
  // Restore RCS state only
  try {
    if (!wasRcsOn) {
      await conn.execute('RCS OFF.');
    }
  } catch {
    // Ignore errors during cleanup
  }

  // Final verification
  try {
    const finalAngle = await queryNumber(conn, 'VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR)');
    log.progress(`[AlignToNode] Final angle: ${finalAngle.toFixed(1)}°, aligned: ${result.success}`);
    return finalAngle < ALIGN_THRESHOLD;
  } catch {
    // If we can't verify, trust the poll result
    return result.success;
  }
}

export interface ExecuteNodeOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  async?: boolean; // If true, return immediately after starting executor
  logger?: McpLogger; // Logger for MCP notifications
  callerTool?: string; // Name of tool that initiated execution (for logging context)
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
    logger,
    callerTool,
  } = options;

  const log = logger ?? nullLogger;
  const logPrefix = callerTool ? `[ExecuteNode:${callerTool}]` : '[ExecuteNode]';
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
    log.progress(`${logPrefix} Required: ${dvRequired.toFixed(1)} m/s, Current stage: ${dvCurrentStage.toFixed(1)} m/s, Ship total: ${dvShipTotal.toFixed(1)} m/s (will stage)`);
  } else {
    log.progress(`${logPrefix} Required: ${dvRequired.toFixed(1)} m/s, Current stage: ${dvCurrentStage.toFixed(1)} m/s, Ship total: ${dvShipTotal.toFixed(1)} m/s`);
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
  log.progress(`${logPrefix} Estimated burn: ${formatTime(burnDuration)}, will shift node by ${formatTime(halfBurn)}`);

  // Set up auto-staging if burn will require staging
  if (needsStaging) {
    log.progress(`${logPrefix} Setting up auto-staging trigger`);
    await conn.execute('WHEN STAGE:DELTAV:CURRENT < 1 THEN { STAGE. PRINT "Auto-staged during burn". }');
  }

  // Align ship to maneuver node BEFORE warping
  const isAligned = await alignToNode(conn, logger);
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
  if (nodeEta > 20) {
    const warpLeadTime = 10; // Stop warping 10s before node
    log.progress(`${logPrefix} Node is ${formatTime(nodeEta)} away, warping to T-${formatTime(warpLeadTime)}`);

    // Clear any existing warp state before starting new warp
    await stopWarp(conn);
    await conn.execute(`KUNIVERSE:TIMEWARP:WARPTO(TIME:SECONDS + ${nodeEta - warpLeadTime}).`, 5000);

    // Wait for warp to complete (poll until ETA is close)
    let warpAttempts = 0;
    const maxWarpAttempts = 600; // Max 10 minutes of warp checking (1s poll interval)
    while (warpAttempts < maxWarpAttempts) {
      await delay(1000);
      const currentEta = await queryNumber(conn, 'NEXTNODE:ETA');
      if (currentEta <= warpLeadTime + 5) {
        log.progress(`${logPrefix} Warp complete, ETA: ${formatTime(currentEta)}`);
        break;
      }
      warpAttempts++;
      if (warpAttempts % 30 === 0) {
        log.progress(`${logPrefix} Still warping, ETA: ${formatTime(currentEta)}`);
      }
    }
  }

  // Poll state interface for burn monitoring
  interface BurnPollState {
    noNode: boolean;
    dvRemaining: number;
    executorEnabled: boolean;
    executorState: string;
    burnComplete: boolean;
    executorStopped: boolean;
    nodeEta: number;
  }

  // Retry loop for incomplete burns
  let lastAttempt = 0;
  let lastStatus = '';
  let lastLogTime = 0;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    lastAttempt = attempt;
    log.progress(`${logPrefix} Attempt ${attempt}/${MAX_RETRIES}`);

    // Workaround: Shift node time earlier by half burn duration
    // MechJeb fires at node time instead of centering the burn
    if (areWorkaroundsEnabled() && halfBurn > 0) {
      // disabled for now
      //await conn.execute(`SET nd TO NEXTNODE. SET nd:ETA TO nd:ETA - ${halfBurn.toFixed(1)}.`, 3000);
    }

    // Stop any active warp before executing
    await stopWarp(conn);

    // Enable MechJeb node executor
    await conn.execute('SET ADDONS:MJ:NODE:ENABLED TO TRUE.', 5000);

    // Turn off SAS - MechJeb handles its own steering now
    await conn.execute('SAS OFF.');

    // Warp assist: if node > 15s away, kickstart MechJeb warp handling
    const warpCheckResult = await conn.execute('IF HASNODE { PRINT NEXTNODE:ETA. } ELSE { PRINT 0. }', 1500);
    const nodeEtaForWarp = Number.parseFloat(warpCheckResult.output.match(/\d[\d.]*/)?.[0] || '0');
    if (nodeEtaForWarp > 15) {
      await delay(3000); // Let MechJeb take over steering first
      await kickstartWarp(conn, log);
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

    // Wait for burn completion using pollWithBlackoutResilience
    const result = await pollWithBlackoutResilience<BurnPollState>({
      poll: async () => {
        // Query progress - when MechJeb completes the burn, it removes the node
        // Include ETA for coasting status display
        const progressResult = await conn.execute(
          'IF HASNODE { PRINT NEXTNODE:DELTAV:MAG + "|" + ADDONS:MJ:NODE:ENABLED + "|" + ADDONS:MJ:NODE:STATE + "|" + ROUND(NEXTNODE:ETA). } ELSE { PRINT "NONODE". }',
          3000
        );

        // Node removed = burn complete (MechJeb removes node when done)
        // IMPORTANT: Check for NONODE as actual output, not in command echo
        const noNode = /(?:^|\n|PRINT ""\.)NONODE(?:\n|$|")/i.test(progressResult.output);
        if (noNode) {
          return { noNode: true, dvRemaining: 0, executorEnabled: false, executorState: 'IDLE', burnComplete: true, executorStopped: false, nodeEta: 0 };
        }

        // Parse "dv|enabled|state|eta" format
        // IMPORTANT: Use \d[\d.]* to require starting with a digit
        const progressMatch = progressResult.output.match(/(\d[\d.]*)\|(True|False)\|(\w+)\|(-?\d+)/i);
        if (!progressMatch) {
          throw new Error('Failed to parse executor progress');
        }

        const dvRemaining = Number.parseFloat(progressMatch[1]);
        const executorEnabled = progressMatch[2].toLowerCase() === 'true';
        const executorState = progressMatch[3];
        const nodeEta = Number.parseInt(progressMatch[4]);
        const burnComplete = dvRemaining < DV_THRESHOLD;
        const executorStopped = !executorEnabled && dvRemaining >= DV_THRESHOLD;

        return { noNode: false, dvRemaining, executorEnabled, executorState, burnComplete, executorStopped, nodeEta };
      },

      isDone: (state) => state.noNode || state.burnComplete || state.executorStopped,
      isSuccess: (state) => state.noNode || state.burnComplete,

      timeoutMs,
      pollIntervalMs,
      logger: log,
      context: 'ExecuteNode',
      connection: conn,

      onPoll: async (state) => {
        if (state.noNode) return;

        // Log status changes using MechJeb's state (like ascent.ts pattern)
        const now = Date.now();
        const status = formatExecutorState(state.executorState);

        // Format status message based on state
        // LEAD (coasting): show time until burn
        // BURN: show dV remaining
        const isCoasting = state.executorState.toUpperCase() === 'LEAD';
        const statusDetail = isCoasting
          ? `in ${formatTime(state.nodeEta)}`
          : `${state.dvRemaining.toFixed(1)} m/s remaining`;

        if (status !== lastStatus) {
          log.progress(`${logPrefix} ${status}, ${statusDetail}`);
          lastStatus = status;
          lastLogTime = now;
        } else if (now - lastLogTime >= 20_000) {
          // Log progress every 20 seconds at least
          log.progress(`${logPrefix} ${status}, ${statusDetail}`);
          lastLogTime = now;
        }

        // Kickstart warp if coasting to node (high dV = not burning yet)
        if (state.dvRemaining > 10) {
          await kickstartWarp(conn, log);
        }
      },
    });

    // Handle poll result
    if (result.success && result.result) {
      const state = result.result;

      if (state.noNode || state.burnComplete) {
        await stopWarp(conn);
        if (state.burnComplete && !state.noNode) {
          log.progress(`${logPrefix} Burn complete! (${state.dvRemaining.toFixed(2)} m/s remaining < ${DV_THRESHOLD} m/s threshold)`);
          // Clear the residual node to avoid "No maneuver nodes present!" errors
          await conn.execute('IF HASNODE { REMOVE NEXTNODE. }', 3000);
        }
        return {
          success: true,
          nodesExecuted: initialNodeCount,
          deltaV: { required: dvRequired, available: dvShipTotal, remaining: state.dvRemaining },
          attempts: attempt
        };
      }

      // Executor stopped but burn incomplete - retry if possible
      if (state.executorStopped) {
        log.progress(`${logPrefix} Executor stopped with ${state.dvRemaining.toFixed(1)} m/s remaining`);
        if (attempt < MAX_RETRIES) {
          log.progress(`${logPrefix} Will retry (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await delay(2000);
          continue; // Continue to next retry attempt
        } else {
          await unlockControls(conn);
          return {
            success: false,
            nodesExecuted: 0,
            error: `Burn incomplete after ${MAX_RETRIES} attempts. ${state.dvRemaining.toFixed(1)} m/s remaining.`,
            deltaV: { required: dvRequired, available: dvShipTotal, remaining: state.dvRemaining },
            attempts: attempt
          };
        }
      }
    }

    // Timeout in this attempt
    if (result.timedOut) {
      if (attempt === MAX_RETRIES) {
        // Disable executor on final timeout
        await conn.execute('SET ADDONS:MJ:NODE:ENABLED TO FALSE.', 2000);
        await unlockControls(conn);

        const lastDvRemaining = result.result?.dvRemaining ?? dvRequired;
        return {
          success: false,
          nodesExecuted: 0,
          error: `Execution timeout after ${timeoutMs / 1000} seconds.`,
          deltaV: { required: dvRequired, available: dvShipTotal, remaining: lastDvRemaining },
          attempts: attempt
        };
      }
      // Non-final timeout - continue to retry
      continue;
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

// ============================================================================
// Tool Definition
// ============================================================================

import { z } from 'zod';
import type { ToolDefinition } from '../tool-types.js';
import { setActiveOperation, clearActiveOperation } from '../../utils/operation-state.js';

/**
 * Execute node tool definition
 */
export const executeNodeTool: ToolDefinition = {
  name: 'execute_node',
  description: 'Execute next maneuver. Prefer execute param on maneuver tools.',
  inputSchema: {
    async: z.boolean()
      .optional()
      .default(false)
      .describe('If true, return immediately after starting executor.'),
    timeoutSeconds: z.number()
      .optional()
      .default(240)
      .describe('Maximum time to wait for node execution in seconds (default: 240 = 4 minutes)'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 3,
  handler: async (args, ctx, extra) => {
    setActiveOperation('execute_node', 'Executing maneuver node');
    try {
      const conn = await ctx.ensureConnected();
      const logger = ctx.createLogger(extra);

      const result = await executeNode(conn, {
        async: args.async as boolean,
        timeoutMs: (args.timeoutSeconds as number) * 1000,
        logger,
      });

      if (result.success) {
        let text = `Executed ${result.nodesExecuted} node(s)`;
        if (result.deltaV) {
          text += `, ${result.deltaV.remaining?.toFixed(1) ?? '0'} m/s remaining`;
        }

        // Check for encounter to provide context-aware next step
        const { queryTargetEncounterInfo } = await import('./shared.js');
        const encounterInfo = await queryTargetEncounterInfo(conn);
        if (encounterInfo && encounterInfo.targetType === 'body') {
          const peAlt = encounterInfo.periapsisInTargetSOI ?? 0;
          if (peAlt < 10_000 && peAlt > 0) {
            text += `\nNext: course_correct to fix low periapsis`;
          } else if (peAlt >= 10_000) {
            text += `\nNext: warp to ${encounterInfo.targetName} SOI, then circularize`;
          }
        } else if (!encounterInfo) {
          // No encounter - generic hint
          text += `\nManeuver complete`;
        }

        return ctx.successResponse('execute_node', text);
      } else {
        return ctx.errorResponse('execute_node', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('execute_node', error instanceof Error ? error.message : String(error));
    } finally {
      clearActiveOperation();
    }
  },
};
