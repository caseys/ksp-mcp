/**
 * Execute Maneuver Node - Library implementation
 *
 * Executes the next maneuver node using MechJeb's node executor autopilot.
 * Includes delta-v validation, auto-staging, time warp kicks, and retry logic.
 */

import type { KosConnection } from '../../transport/kos-connection.js';
import { queryNumber, unlockControls, parseNumber } from './shared.js';
import { delay } from '../utils/progress.js';
import { formatTime, fmtNum, fmtVel } from '../utils/format.js';
import { config } from '../../config/index.js';
import { type McpLogger, nullLogger } from '../tool-types.js';
import { clearBroadcastLogger } from '../../utils/mcp-logger.js';
import { stopWarp } from '../kos/warp.js';
import { pollWithBlackoutResilience } from '../../utils/poll-with-resilience.js';
import { setKosOperation, clearKosOperation } from '../../utils/kos-operation-state.js';
import { invalidateStatusCache } from './telemetry.js';
import { clearNodes } from '../kos/nodes.js';
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
  /** MechJeb executor state: IDLE, WARPALIGN, LEAD, or BURN */
  executorState?: string;
  /** Whether MechJeb executor is enabled */
  executorEnabled?: boolean;
}

// ============================================================================
// Thrust Limiting for Small Burns
// ============================================================================

const SMALL_BURN_THRESHOLD = 10; // m/s - burns below this get thrust limiting
const SMALL_BURN_THRUST_LIMIT = 12; // percent - conservative limit for precision

// RCS pulse configuration constants
const RCS_PULSE_DV_THRESHOLD = 10; // m/s - burns below this get shorter/fewer RCS pulses
const RCS_PULSE_DURATION_MAX = 0.25; // seconds - maximum pulse duration
const RCS_PULSE_DURATION_MIN = 0.03; // seconds - minimum pulse duration
const RCS_PULSE_COUNT_MAX = 10; // max pulses per poll (large burns, large error)
const RCS_PULSE_COUNT_MIN = 1; // min pulses per poll (small burns, small error)
const RCS_PULSE_OFF_TIME = 0.3; // seconds - pause between pulses

// ============================================================================
// Alignment Target Types
// ============================================================================

/** Target direction for alignment */
export type AlignmentTarget = 'maneuver' | 'prograde' | 'retrograde';

/**
 * Get kOS expressions for alignment target.
 * Returns the vector expression for LOCK STEERING and angle check expression.
 */
function getAlignmentExpressions(target: AlignmentTarget): { vector: string; angleCheck: string } {
  switch (target) {
    case 'maneuver':
      return {
        vector: 'NEXTNODE:BURNVECTOR',
        angleCheck: 'VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR)',
      };
    case 'prograde':
      return {
        vector: 'SHIP:VELOCITY:ORBIT:NORMALIZED',
        angleCheck: 'VANG(SHIP:FACING:FOREVECTOR, SHIP:VELOCITY:ORBIT:NORMALIZED)',
      };
    case 'retrograde':
      return {
        vector: '-SHIP:VELOCITY:ORBIT:NORMALIZED',
        angleCheck: 'VANG(SHIP:FACING:FOREVECTOR, -SHIP:VELOCITY:ORBIT:NORMALIZED)',
      };
  }
}

/**
 * Limit engine thrust for small burns.
 * Prevents overshooting by reducing thrust output.
 */
async function limitEngineThrust(
  conn: KosConnection,
  targetPercent: number,
  logger?: McpLogger
): Promise<void> {
  // Limit ALL staged engines, not just ignited ones
  // (engines aren't running yet when this is called - MechJeb starts them later)
  const script = `
    LOCAL count IS 0.
    FOR eng IN SHIP:ENGINES {
      IF NOT eng:FLAMEOUT {
        SET eng:THRUSTLIMIT TO ${targetPercent}.
        SET count TO count + 1.
      }
    }
    PRINT count.
  `.trim().replaceAll('\n', ' ');

  const result = await conn.queue(script, 5000);
  const count = result.success ? parseInt(result.output) || 0 : 0;

  if (count > 0) {
    logger?.progress(`[Maneuver] Limited ${count} engine(s) to ${targetPercent}% thrust`);
  }
}

/**
 * Restore engine thrust limits to 100%.
 */
async function restoreEngineThrust(conn: KosConnection, logger?: McpLogger): Promise<void> {
  await conn.raw(`
    FOR eng IN SHIP:ENGINES {
      SET eng:THRUSTLIMIT TO 100.
    }
  `.trim().replaceAll('\n', ' '), 3000);
  logger?.progress('[Maneuver] Restored engine thrust to 100%');
}

// ============================================================================
// RCS Pulse Duration for Small Burns
// ============================================================================

/**
 * Calculate RCS pulse duration based on burn delta-v and heading error.
 *
 * Shorter pulses = gentler RCS assist = less trajectory disturbance for small burns.
 *
 * Base duration (from dV):
 * - dV >= 10 m/s: 0.25s (full pulses)
 * - dV < 10 m/s: scales down to 0.03s at dV < 1 m/s
 *
 * Error reduction (when error < 15 degrees):
 * - Multiplies base by (error/15) to reduce pulse as we approach alignment
 * - Minimum 0.03s to maintain effectiveness
 */
function calculateRcsPulseDuration(burnDv: number, headingError: number): number {
  // Base duration from burn delta-v
  let baseDuration: number;
  if (burnDv >= RCS_PULSE_DV_THRESHOLD) {
    baseDuration = RCS_PULSE_DURATION_MAX;
  } else if (burnDv <= 1) {
    baseDuration = RCS_PULSE_DURATION_MIN;
  } else {
    // Linear scale: 10 m/s -> 0.25s, 1 m/s -> 0.03s
    const dvFactor = (burnDv - 1) / (RCS_PULSE_DV_THRESHOLD - 1);
    baseDuration = RCS_PULSE_DURATION_MIN + dvFactor * (RCS_PULSE_DURATION_MAX - RCS_PULSE_DURATION_MIN);
  }

  // Error-based reduction when < 45 degrees
  if (headingError < 45) {
    const errorFactor = Math.max(headingError / 45, 0.12); // Min 12% of base
    baseDuration *= errorFactor;
  }

  return Math.max(RCS_PULSE_DURATION_MIN, baseDuration);
}

/**
 * Calculate number of RCS pulses per poll based on heading error and burn delta-v.
 *
 * Fewer pulses = less aggressive pulsing = helps large ships settle.
 *
 * Heading error is the PRIMARY factor:
 * - error >= 45°: 5 pulses (aggressive turning)
 * - error <= 15°: 1 pulse (gentle settling)
 * - Linear scale between
 *
 * Burn dV is a SECONDARY factor that can further reduce pulses for small burns.
 */
function calculatePulseCount(burnDv: number, headingError: number): number {
  // Primary: scale by heading error (45° -> 5 pulses, 15° -> 1 pulse)
  let count: number;
  if (headingError >= 45) {
    count = RCS_PULSE_COUNT_MAX; // 5
  } else if (headingError <= 15) {
    count = RCS_PULSE_COUNT_MIN; // 1
  } else {
    // Linear scale: 45° -> 5, 15° -> 1
    const errorFactor = (headingError - 15) / (45 - 15);
    count = RCS_PULSE_COUNT_MIN + errorFactor * (RCS_PULSE_COUNT_MAX - RCS_PULSE_COUNT_MIN);
  }

  // Secondary: further reduce for small burns (< 10 m/s)
  if (burnDv < RCS_PULSE_DV_THRESHOLD) {
    const dvFactor = burnDv / RCS_PULSE_DV_THRESHOLD; // 0-1 range
    count *= Math.max(dvFactor, 0.4); // At minimum, keep 40% of error-based count
  }

  return Math.max(RCS_PULSE_COUNT_MIN, Math.round(count));
}

// Configuration
const MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
const DEFAULT_POLL_INTERVAL_MS = 2500; // 2.5 seconds - must be fast enough to catch short burns
const DV_THRESHOLD = 1; // m/s - consider burn complete below this

// Alignment configuration
const ALIGN_THRESHOLD = 5; // degrees - consider aligned below this

// WARPALIGN stuck detection configuration
const WARPALIGN_STUCK_THRESHOLD = 3; // Warn after 3 polls with no angle change (~6 seconds)

// Fine tune phase configuration
const FINE_TUNE_ENGINE_BURST_MS = 100;  // Short engine pulse duration
const FINE_TUNE_RCS_BURST_MS = 200;     // RCS pulse duration (increased for effectiveness)
const FINE_TUNE_MAX_ATTEMPTS = 15;      // Max attempts per direction (increased for far encounters)
const FINE_TUNE_THRUST_LIMIT = 15;      // Engine thrust limit %

/**
 * Align ship to a target direction using LOCK STEERING with RCS pulse assist.
 *
 * Features:
 * - 2x physics warp to speed up rotation
 * - Adaptive RCS pulse duration and count (scales with dV and heading error)
 * - Supports maneuver node, prograde, or retrograde alignment
 *
 * @param conn - kOS connection
 * @param target - Alignment target: 'maneuver', 'prograde', or 'retrograde'
 * @param targetError - Target alignment error in degrees (default 5)
 * @param timeout - Timeout in milliseconds (default 60000)
 * @param burnDv - Burn delta-v in m/s (for RCS scaling, optional)
 * @param logger - Logger for progress messages (optional)
 * @returns Alignment result with final error angle
 */
async function runAlignScript(
  conn: KosConnection,
  target: AlignmentTarget = 'maneuver',
  targetError = 5,
  timeout = 60_000,
  burnDv?: number,
  logger?: McpLogger
): Promise<{ success: boolean; method: 'SAS' | 'KOS'; errorAngle: number; output: string }> {
  const startTime = Date.now();
  const _log = logger ?? nullLogger; // Reserved for future progress logging

  // Get kOS expressions for the target direction
  const { vector, angleCheck } = getAlignmentExpressions(target);

  // Check if already aligned - skip alignment entirely if within target error
  const initialCheck = await conn.queue(`PRINT ROUND(${angleCheck}, 2).`, 3000);
  const initialAngle = parseFloat(initialCheck.output.trim());
  if (!isNaN(initialAngle) && initialAngle <= targetError) {
    return {
      success: true,
      method: 'KOS',
      errorAngle: initialAngle,
      output: `Already aligned (${initialAngle}°)`,
    };
  }

  // Enable 2x physics warp to speed up rotation (will drop to 1x when error < 30°)
  await conn.raw('SET KUNIVERSE:TIMEWARP:MODE TO "PHYSICS". SET WARP TO 1.', 3000);

  // Start alignment: LOCK STEERING only (no WHEN trigger)
  // RCS pulses are sent from TypeScript poll loop with calculated duration
  // Freeze the up vector once so roll doesn't fight during alignment
  const alignCmd = `SAS OFF. SET frozenUp TO SHIP:UP:VECTOR. LOCK STEERING TO LOOKDIRUP(${vector}, frozenUp).`;
  await conn.queue(alignCmd, 5000);

  // Poll until aligned or timeout
  let errorAngle = 180;
  let lastOutput = '';

  while (Date.now() - startTime < timeout) {
    const result = await conn.queue(
      `PRINT ROUND(${angleCheck}, 2).`,
      3000
    );
    lastOutput = result.output;

    const angle = parseFloat(result.output.trim());
    if (!isNaN(angle)) {
      errorAngle = angle;

      if (angle <= targetError) {
        // Aligned - cleanup: restore warp mode and unlock all controls
        await conn.raw('SET WARP TO 0. SET KUNIVERSE:TIMEWARP:MODE TO "RAILS". SET RCS TO FALSE. UNLOCK STEERING. UNLOCK THROTTLE.', 3000);
        return {
          success: true,
          method: 'KOS',
          errorAngle,
          output: `Aligned to ${errorAngle}°`,
        };
      }

      // Drop physics warp when close to aligned for more precise control
      if (angle < 30) {
        await conn.raw('SET WARP TO 0. SET KUNIVERSE:TIMEWARP:MODE TO "RAILS".', 2000);
      }

      // Skip RCS when error < 15° - let reaction wheels handle fine settling
      // RCS is too powerful and causes oscillation around target
      if (angle >= 15) {
        // Send RCS pulses with duration and count based on burn dV and heading error
        const pulseDuration = calculateRcsPulseDuration(burnDv ?? 100, angle);
        const pulseCount = calculatePulseCount(burnDv ?? 100, angle);

        // Build command for N pulses in one kOS execution (no round-trips between pulses)
        let pulseCmd = '';
        for (let i = 0; i < pulseCount; i++) {
          pulseCmd += `SET RCS TO TRUE. WAIT ${pulseDuration.toFixed(3)}. SET RCS TO FALSE.`;
          if (i < pulseCount - 1) {
            pulseCmd += ` WAIT ${RCS_PULSE_OFF_TIME}. `;
          }
        }
        await conn.raw(pulseCmd, 5000);
      }
      // else: reaction wheels only via LOCK STEERING
    }

    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }

  // Timeout - cleanup: restore warp mode and unlock all controls
  await conn.raw('SET WARP TO 0. SET KUNIVERSE:TIMEWARP:MODE TO "RAILS". SET RCS TO FALSE. UNLOCK STEERING. UNLOCK THROTTLE.', 3000);
  console.error(`[execute-node] Alignment timeout, final error: ${errorAngle}°`);
  return {
    success: false,
    method: 'KOS',
    errorAngle,
    output: lastOutput,
  };
}

/**
 * Align ship to maneuver node using LOCK STEERING + RCS pulse assist.
 *
 * Features:
 * - 2x physics warp for faster rotation
 * - Dynamic RCS pulse duration (shorter pulses for small burns/small errors)
 * - Watchdog for stuck steering
 *
 * @param conn kOS connection
 * @param logger Optional MCP logger for progress updates
 * @param logPrefix Prefix for log messages (e.g., '[Maneuver]')
 * @param rcsMode RCS mode for alignment (currently unused, kept for API compat)
 * @param burnDv Burn delta-v in m/s (smaller burns get shorter RCS pulses)
 */
async function alignToNode(conn: KosConnection, logger?: McpLogger, logPrefix = '[Maneuver]', _rcsMode = 1, burnDv?: number, target: AlignmentTarget = 'maneuver'): Promise<boolean> {
  const log = logger ?? nullLogger;

  // Verify node exists before trying to align (only for maneuver target)
  if (target === 'maneuver') {
    const nodeCheck = await conn.queue('PRINT HASNODE.', 2000);
    if (!nodeCheck.success || !nodeCheck.output.includes('True')) {
      log.error(`${logPrefix} No maneuver node exists!`);
      return false;
    }
  }

  // Check initial angle
  const { angleCheck } = getAlignmentExpressions(target);
  const initialAngle = await queryNumber(conn, angleCheck);
  const targetName = target === 'maneuver' ? 'burn vector' : target;
  log.progress(`${logPrefix} Aligning to ${targetName} (${fmtNum(initialAngle)}°)...`);

  // Run alignment script with RCS pulsing
  const result = await runAlignScript(conn, target, ALIGN_THRESHOLD, 60_000, burnDv, log);

  if (result.success) {
    log.progress(`${logPrefix} Aligned via ${result.method} (${fmtNum(result.errorAngle)}°)`);
    return result.errorAngle < ALIGN_THRESHOLD;
  } else {
    log.error(`${logPrefix} Alignment failed`);
    // Log any output for debugging
    if (result.output) {
      log.debug(`${logPrefix} Script output: ${result.output.slice(0, 200)}`);
    }
    return false;
  }
}

/**
 * Fine tune function type.
 * Returns a number representing distance from goal:
 * - < 0: Goal not met (undershoot), need prograde thrust
 * - = 0: Perfect, no action needed
 * - > 0: Overshot goal, need retrograde RCS
 */
export type FineTuneFunction = (conn: KosConnection) => Promise<number>;

export interface ExecuteNodeOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  async?: boolean; // If true, return immediately after starting executor
  logger?: McpLogger; // Logger for MCP notifications
  callerTool?: string; // Name of tool that initiated execution (for logging context)
  noRcsAlign?: boolean; // If true, don't use RCS during alignment (for small burns where RCS would affect trajectory)
  targetPeriapsis?: number; // Target periapsis in meters (for RCS fine-tuning mode)
  fineTuneFunction?: FineTuneFunction; // Optional post-burn fine-tuning function
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
    noRcsAlign = false,
    targetPeriapsis: _targetPeriapsis, // Unused until RCS refinement re-enabled
    fineTuneFunction,
  } = options;

  const log = logger ?? nullLogger;
  const logPrefix = callerTool ? `[${callerTool} Maneuver]` : '[Maneuver]';
  // Check if a node exists
  const nodeCheck = await conn.queue('PRINT HASNODE.', 2000);
  if (!nodeCheck.success || !nodeCheck.output.includes('True')) {
    return { success: false, nodesExecuted: 0, error: 'No maneuver node found' };
  }

  // Safety: reject nodes with negative periapsis (crash trajectory)
  // Only check on elliptical orbits — NEXTNODE:ORBIT:PERIAPSIS errors on hyperbolic
  const preNodeEcc = await queryNumber(conn, 'ORBIT:ECCENTRICITY');
  if (preNodeEcc < 1) {
    const nodePeResult = await conn.queue('PRINT ROUND(NEXTNODE:ORBIT:PERIAPSIS).', 3000);
    const nodePeM = Number.parseFloat(nodePeResult.success ? nodePeResult.output.match(/[-\d.]+/)?.[0] ?? '0' : '0');
    if (nodePeM < 0) {
      log.info(`${logPrefix} Node periapsis: ${Math.round(nodePeM / 1000)}km — clearing crash node`);
      await clearNodes(conn);
      return {
        success: false,
        nodesExecuted: 0,
        error: `Planned node results in periapsis ${Math.round(nodePeM / 1000)}km below surface. Aborting — node would crash into body.`,
      };
    }
  }

  // Get initial node count
  const initialCountResult = await conn.queue('PRINT ALLNODES:LENGTH.', 2000);
  const initialNodeCount = initialCountResult.success
    ? Number.parseInt(initialCountResult.output.match(/\d+/)?.[0] || '1')
    : 1;

  // Delta-v validation - use total ship delta-v for reliability
  const dvRequired = await queryNumber(conn, 'NEXTNODE:DELTAV:MAG');
  const dvShipTotal = await queryNumber(conn, 'SHIP:DELTAV:CURRENT');
  const dvCurrentStage = await queryNumber(conn, 'STAGE:DELTAV:CURRENT');
  const initialNodeEta = await queryNumber(conn, 'NEXTNODE:ETA');

  if (dvShipTotal < dvRequired) {
    const deficit = dvRequired - dvShipTotal;
    return {
      success: false,
      nodesExecuted: 0,
      error: `Insufficient delta-V: need ${fmtVel(dvRequired)}, have ${fmtVel(dvShipTotal)} (deficit: ${fmtVel(deficit)}). Consider adding more fuel or splitting the maneuver.`,
      deltaV: { required: dvRequired, available: dvShipTotal }
    };
  }

  log.progress(`${logPrefix} ${fmtVel(dvRequired)}, in ${formatTime(initialNodeEta)}`);

  // Set operation state in kOS (persists across restarts, auto-cleared by safety monitor)
  // This enables status tracking even if MCP client times out
  await setKosOperation(conn, 'node', callerTool ?? 'execute_node', fmtVel(dvRequired));

  // Determine if staging will be needed during burn
  const needsStaging = dvCurrentStage < dvRequired && dvShipTotal >= dvRequired;
  if (needsStaging) {
    log.progress(`${logPrefix} Multi-stage burn (staging automated)`);
    await conn.raw('WHEN STAGE:DELTAV:CURRENT < 1 THEN { STAGE. PRINT "Auto-staged during burn". }');
  }

  // Precision thrust limiting: halve thrust when dV remaining < 20% AND < 100m/s
  // This fires once during burn to reduce overshoot. Halves current limit (never increases).
  const precisionThreshold = Math.min(dvRequired * 0.2, 100);
  await conn.raw(`
    WHEN HASNODE AND NEXTNODE:DELTAV:MAG < ${precisionThreshold.toFixed(1)} THEN {
      FOR eng IN SHIP:ENGINES {
        IF NOT eng:FLAMEOUT { SET eng:THRUSTLIMIT TO eng:THRUSTLIMIT / 2. }
      }
      PRINT "Thrust halved for precision burn".
    }
  `.trim().replaceAll('\n', ' '));

  // Get estimated burn duration from MechJeb INFO wrapper
  const burnDuration = await queryNumber(conn, 'ADDONS:MJ:INFO:NEXTMANEUVERNODEBURNTIME');
  const halfBurn = burnDuration / 2;

  // RCS mode for alignment (ascending aggressiveness: 0=none, 1=burst, 2=pulsed, 3=continuous):
  // - Tiny burns (< 1 m/s): mode 0 (no RCS) - RCS would overpower the burn
  // - Small burns (< 10 m/s): mode 1 (burst) for light touch
  // - Normal burns (>= 10 m/s): mode 2 (pulsed + adaptive) for reliable alignment
  const isTinyBurn = dvRequired < 1;
  const isSmallBurn = dvRequired < 10;
  const rcsMode = noRcsAlign || isTinyBurn ? 0 : (isSmallBurn ? 1 : 2);

  // Align to node BEFORE enabling MechJeb executor
  // MechJeb's WARPALIGN can get stuck - we want to be aligned before starting
  const MAX_ALIGN_ATTEMPTS = 3;
  let aligned = false;

  for (let alignAttempt = 1; alignAttempt <= MAX_ALIGN_ATTEMPTS; alignAttempt++) {
    const alignResult = await alignToNode(conn, logger, logPrefix, rcsMode, dvRequired);

    if (alignResult) {
      aligned = true;
      break;
    }

    // Verify actual angle - script may have failed but vessel might be aligned
    const actualAngle = await queryNumber(conn, 'VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR)');
    if (actualAngle < ALIGN_THRESHOLD) {
      log.progress(`${logPrefix} Aligned (${fmtNum(actualAngle)}°)`);
      aligned = true;
      break;
    }

    if (alignAttempt < MAX_ALIGN_ATTEMPTS) {
      log.warn(`${logPrefix} Alignment incomplete (${fmtNum(actualAngle)}°), retrying...`);
      await delay(1000);
    } else {
      log.warn(`${logPrefix} Alignment failed after ${MAX_ALIGN_ATTEMPTS} attempts (${fmtNum(actualAngle)}°)`);
    }
  }

  // Final alignment gate - don't proceed until aligned
  if (!aligned) {
    const finalAngle = await queryNumber(conn, 'VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR)');
    if (finalAngle >= ALIGN_THRESHOLD) {
      // Query diagnostics to help understand why alignment failed
      let diagnostics = '';
      try {
        const diagResult = await conn.queue(
          'PRINT ROUND(SHIP:ANGULARVEL:MAG, 3) + "|" + SAS + "|" + RCS + "|" + ' +
          'ROUND(SHIP:ELECTRICCHARGE, 0) + "|" + SHIP:CONTROL:NEUTRAL.',
          3000
        );
        // Parse "angVel|sas|rcs|charge|neutral" format
        const diagMatch = diagResult.success
          ? diagResult.output.match(/([\d.]+)\|(True|False)\|(True|False)\|(\d+)\|(True|False)/i)
          : null;
        if (diagMatch) {
          const angVel = parseFloat(diagMatch[1]);
          const sasOn = diagMatch[2].toLowerCase() === 'true';
          const rcsOn = diagMatch[3].toLowerCase() === 'true';
          const elecCharge = parseInt(diagMatch[4]);
          const controlNeutral = diagMatch[5].toLowerCase() === 'true';

          const issues: string[] = [];
          if (angVel < 0.001 && finalAngle > 10) issues.push('not rotating (stuck?)');
          if (angVel > 0.5) issues.push(`spinning (${angVel.toFixed(2)} rad/s)`);
          if (!sasOn && !rcsOn) issues.push('no SAS or RCS');
          if (elecCharge < 5) issues.push('no electric charge');
          if (!controlNeutral) issues.push('controls not neutral');

          if (issues.length > 0) {
            diagnostics = ` [${issues.join(', ')}]`;
          }
        }
      } catch { /* ignore diagnostic failures */ }

      log.error(`${logPrefix} Cannot proceed - not aligned (${fmtNum(finalAngle)}°)${diagnostics}`);
      await clearKosOperation(conn);
      return {
        success: false,
        nodesExecuted: 0,
        error: `Alignment failed: ${fmtNum(finalAngle)}° off target (need < ${ALIGN_THRESHOLD}°)${diagnostics}`,
        deltaV: { required: dvRequired, available: dvShipTotal }
      };
    }
  }

  // Check for encounter (kept for future RCS refinement re-enablement)
  const _hasEncounter = await conn.queue('PRINT SHIP:ORBIT:HASNEXTPATCH.', 2000)
    .then(r => r.success && r.output.includes('True'))
    .catch(() => false);

  // For small burns, limit engine thrust to prevent overshooting
  // Note: Precision WHEN trigger above will halve thrust near end of ALL burns,
  // so we always restore thrust after completion
  const thrustWasLimited = true; // Always restore - WHEN trigger modifies all burns
  if (dvRequired < SMALL_BURN_THRESHOLD) {
    await limitEngineThrust(conn, SMALL_BURN_THRUST_LIMIT, log);
  }

  // Enable MechJeb executor BEFORE warp — vessel may enter radio blackout on arrival
  // Disable MechJeb's autowarp so it doesn't interfere with our WARPTO
  await conn.raw('SET ADDONS:MJ:NODE:AUTOWARP TO FALSE.', 3000);
  log.progress(`${logPrefix} Enabling MechJeb node executor...`);
  await conn.raw('SET ADDONS:MJ:NODE:ENABLED TO TRUE.', 5000);
  await delay(500);

  // Verify MechJeb is enabled
  const verifyEnable = await conn.queue('PRINT ADDONS:MJ:NODE:ENABLED.', 2000);
  if (!verifyEnable.output.includes('True')) {
    log.warn(`${logPrefix} MechJeb executor not enabled, retrying...`);
    await conn.raw('SET ADDONS:MJ:NODE:ENABLED TO TRUE.', 5000);
    await delay(500);
  }

  // Warp to node if it's far away and warp is enabled
  // Warp target: node time - (burn time / 2) - 15 seconds for alignment
  // This ensures we arrive 15s before the burn should START (not before node time)
  await stopWarp(conn);
  await conn.raw('UNLOCK STEERING. SAS OFF.', 3000);

  const nodeEta = await queryNumber(conn, 'NEXTNODE:ETA');
  const alignmentBuffer = 15; // Extra time for alignment before burn starts
  const warpLeadTime = halfBurn + alignmentBuffer;

  if (nodeEta > warpLeadTime + 10 && config.warp.onRails) {
    log.progress(`${logPrefix} Helm, course set for maneuver. Ignition in ${formatTime(nodeEta)}... Engage!`);
    log.info(`${logPrefix} Warp params: nodeEta=${Math.round(nodeEta)}s, halfBurn=${Math.round(halfBurn)}s, leadTime=${Math.round(warpLeadTime)}s, warpFor=${Math.round(nodeEta - warpLeadTime)}s`);

    const warpTargetSeconds = nodeEta - warpLeadTime;
    await conn.raw(`KUNIVERSE:TIMEWARP:WARPTO(TIME:SECONDS + ${warpTargetSeconds}).`, 5000);

    // Wait for warp to complete (poll until ETA is close or warp stops)
    let warpAttempts = 0;
    let consecutiveFailures = 0;
    let lastLoggedEta = nodeEta;
    let lastLogTime = Date.now();
    const maxWarpAttempts = 240; // Max 10 minutes of warp checking (2.5s poll interval)
    const maxConsecutiveFailures = 12; // Exit after 30s of failures (assume warp done or connection lost)

    while (warpAttempts < maxWarpAttempts) {
      await delay(2500);
      try {
        // Query node status and warp level (NOT MechJeb state - it's not enabled yet)
        const statusResult = await conn.queue(
          'PRINT HASNODE + "|" + WARP + "|" + (CHOOSE NEXTNODE:ETA IF HASNODE ELSE 0).',
          2000
        );
        const parts = statusResult.output.split('|');
        const hasNode = parts[0]?.toLowerCase().includes('true');
        const warpLevel = parseNumber(parts[1] || '0');
        const currentEta = parseNumber(parts[2] || '0');

        consecutiveFailures = 0; // Reset on successful query

        // If node is gone — but verify with a second check to avoid false negatives from garbled output
        if (!hasNode) {
          await delay(500);
          const recheck = await conn.queue('PRINT HASNODE.', 2000);
          if (!recheck.success || !recheck.output.includes('True')) {
            log.progress(`${logPrefix} Node gone during warp`);
            break;
          }
          // False negative — node still exists, continue warp loop
        }

        // Exit if ETA is low enough
        if (currentEta <= 0 || currentEta <= warpLeadTime + 5) {
          log.progress(`${logPrefix} Dropping out of warp, preparing for maneuver`);
          break;
        }

        // Exit if warp stopped (warp level = 0 means we've arrived)
        if (warpLevel === 0 && warpAttempts > 2) {
          log.progress(`${logPrefix} Warp complete, ${formatTime(currentEta)} to ignition`);
          break;
        }

        // Log if ETA changed significantly OR every 15 seconds
        const now = Date.now();
        const etaChanged = Math.abs(currentEta - lastLoggedEta) > 30;
        const timeElapsed = now - lastLogTime >= 15_000;

        if (etaChanged || timeElapsed) {
          log.progress(`${logPrefix} Warping... ignition in ${formatTime(currentEta)}`);
          lastLoggedEta = currentEta;
          lastLogTime = now;
        }
      } catch {
        // May be in blackout during warp - that's fine
        consecutiveFailures++;
        if (consecutiveFailures >= maxConsecutiveFailures) {
          // Too many consecutive failures - assume warp complete or failed, proceed to burn phase
          log.progress(`${logPrefix} Warp query timeout - proceeding to burn phase`);
          break;
        }
        const now = Date.now();
        if (now - lastLogTime >= 15_000) {
          log.progress(`${logPrefix} Warp in progress (no signal)`);
          lastLogTime = now;
        }
      }
      warpAttempts++;
    }
  }

  // Best-effort post-warp cleanup (may fail in blackout — that's OK, MechJeb is already enabled)
  await conn.raw('RCS OFF.', 2000).catch(() => {});

  // Log MechJeb state (best-effort — may be in blackout)
  try {
    const initialState = await conn.queue('PRINT ADDONS:MJ:NODE:ENABLED + "|" + ADDONS:MJ:NODE:STATE.', 2000);
    if (initialState.success) {
      log.progress(`${logPrefix} MechJeb: ${initialState.output.trim()}`);
    }
  } catch { /* blackout */ }

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

    // For retries (attempt > 1), re-enable MechJeb and log retry
    // First attempt already enabled it before warp
    if (attempt > 1) {
      log.progress(`${logPrefix} Retry attempt ${attempt}/${MAX_RETRIES}`);
      try {
        await stopWarp(conn);
        // Unlock steering before re-enabling MechJeb - kOS steering can conflict
        await conn.raw('UNLOCK STEERING. SAS OFF. SET ADDONS:MJ:NODE:ENABLED TO TRUE.', 5000);
      } catch {
        // May be in blackout - MechJeb will continue executing autonomously
        log.progress(`${logPrefix} No signal - executing autonomously`);
      }
    }

    // Disabled: using kOS WARPTO instead of kickstart pulses
    // Warp assist: if node > 15s away, kickstart MechJeb warp handling
    // const warpCheckResult = await conn.raw('IF HASNODE { PRINT NEXTNODE:ETA. } ELSE { PRINT 0. }', 1500);
    // const nodeEtaForWarp = Number.parseFloat(warpCheckResult.output.match(/\d[\d.]*/)?.[0] || '0');
    // if (nodeEtaForWarp > 15) {
    //   await delay(3000); // Let MechJeb take over steering first
    //   await kickstartWarp(conn, log);
    // }

    // In async mode, return immediately after starting executor
    // Don't clear _MCP_OP - safety monitor will handle it when node completes
    if (asyncMode) {
      return {
        success: true,
        nodesExecuted: 0, // Not yet executed, just started
        deltaV: { required: dvRequired, available: dvShipTotal },
        attempts: 1
      };
    }

    // WARPALIGN stuck detection - track when MechJeb goes back to alignment after burn started
    let burnEverStarted = false;
    let warpAlignStartTime: number | null = null;
    let lastWarpAlignAngle: number | null = null;
    let warpAlignStuckCount = 0;
    let alignedWaitingCount = 0; // Count polls while aligned but MechJeb stuck in WARPALIGN

    // Wait for burn completion using pollWithBlackoutResilience
    const result = await pollWithBlackoutResilience<BurnPollState>({
      poll: async () => {
        // FIRST: Quick check if node still exists - this is the most reliable completion indicator
        // Do this as a separate query to avoid complex parsing issues
        const nodeCheck = await conn.queue('PRINT HASNODE.', 2000);
        if (nodeCheck.success && !nodeCheck.output.includes('True')) {
          // Node is gone - burn complete!
          return { noNode: true, dvRemaining: 0, executorEnabled: false, executorState: 'IDLE', burnComplete: true, executorStopped: false, nodeEta: 0 };
        }

        // Node exists - query full state for progress tracking
        const progressResult = await conn.queue(
          'PRINT ADDONS:MJ:NODE:ENABLED + "|" + ADDONS:MJ:NODE:STATE + "|" + ROUND(NEXTNODE:DELTAV:MAG,1) + "|" + ROUND(NEXTNODE:ETA).',
          3000
        );

        if (!progressResult.success) {
          throw new Error('MechJeb query failed');
        }

        // Parse "enabled|state|dv|eta" format
        const progressMatch = progressResult.output.match(/(True|False)\|(\w+)\|([\d.]+)\|(-?\d+)/i);
        if (!progressMatch) {
          throw new Error(`MechJeb parse failed: ${progressResult.output.slice(0, 80)}`);
        }

        const executorEnabled = progressMatch[1].toLowerCase() === 'true';
        const executorState = progressMatch[2];
        const dvRemaining = Number.parseFloat(progressMatch[3]);
        const nodeEta = Number.parseInt(progressMatch[4]);
        const burnComplete = dvRemaining < DV_THRESHOLD;
        // Executor stopped: either disabled, or IDLE state (MechJeb sets IDLE when done even if enabled)
        const executorIdle = executorState.toUpperCase() === 'IDLE';
        const executorStopped = (!executorEnabled || executorIdle) && dvRemaining >= DV_THRESHOLD;

        // Double-check: if MechJeb is IDLE, verify node still exists
        // (MechJeb may have completed and we just need to confirm)
        if (executorIdle) {
          const confirmNode = await conn.queue('PRINT HASNODE.', 1500);
          if (confirmNode.success && !confirmNode.output.includes('True')) {
            return { noNode: true, dvRemaining: 0, executorEnabled, executorState, burnComplete: true, executorStopped: false, nodeEta: 0 };
          }
        }

        return { noNode: false, dvRemaining, executorEnabled, executorState, burnComplete, executorStopped, nodeEta };
      },

      // Include executorIdle in isDone check - MechJeb going IDLE means it's done (for better or worse)
      isDone: (state) => state.noNode || state.burnComplete || state.executorStopped || state.executorState.toUpperCase() === 'IDLE',
      isSuccess: (state) => state.noNode || state.burnComplete,

      timeoutMs,
      pollIntervalMs,
      logger: log,
      context: 'ExecuteNode',
      connection: conn,

      onPoll: async (state) => {
        if (state.noNode) return;

        const now = Date.now();
        const execState = state.executorState.toUpperCase();

        // Track if burn has ever started (for WARPALIGN stuck detection)
        if (execState === 'BURN') {
          burnEverStarted = true;
          warpAlignStartTime = null; // Reset WARPALIGN tracking when burning
          warpAlignStuckCount = 0;
          alignedWaitingCount = 0;
        }

        // Space-themed status messages based on MechJeb executor state
        let statusMsg: string;
        switch (execState) {
        case 'LEAD': {
          statusMsg = `Ignition in ${formatTime(state.nodeEta)}`;
          warpAlignStartTime = null; // Reset when in LEAD
          alignedWaitingCount = 0;
          break;
        }
        case 'BURN': {
          statusMsg = `Burn: ${fmtVel(state.dvRemaining)} to go`;
          alignedWaitingCount = 0;
          break;
        }
        case 'WARPALIGN': {
          // Track WARPALIGN start time
          if (warpAlignStartTime === null) {
            warpAlignStartTime = now;
            lastWarpAlignAngle = null;
          }

          // Query current heading angle for stuck detection
          try {
            const angleResult = await conn.queue(
              'PRINT ROUND(VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR), 1).',
              2000
            );
            const currentAngle = angleResult.success ? parseNumber(angleResult.output) : 0;

            // Check if dV is dropping (burn actually happening despite WARPALIGN state)
            const dvDropping = burnEverStarted && state.dvRemaining < dvRequired * 0.95;

            if (dvDropping) {
              // dV is dropping - burn is happening, don't interfere with stuck detection
              // Just let the normal polling continue until burnComplete
              statusMsg = `Burn: ${fmtVel(state.dvRemaining)} to go (realigning)`;
              warpAlignStuckCount = 0; // Reset stuck counter
            } else if (currentAngle < ALIGN_THRESHOLD) {
              // Aligned but MechJeb still in WARPALIGN state
              alignedWaitingCount++;
              warpAlignStuckCount = 0;

              if (alignedWaitingCount >= 4) {
                // Been aligned for too long (~10s) but MechJeb won't start - try to kick it
                log.warn(`${logPrefix} Aligned but MechJeb not starting - attempting recovery`);
                try {
                  // Disable and re-enable MechJeb executor to reset its state
                  await conn.raw('SET ADDONS:MJ:NODE:ENABLED TO FALSE. WAIT 0.5. SET ADDONS:MJ:NODE:ENABLED TO TRUE.', 5000);
                } catch { /* ignore */ }
                alignedWaitingCount = 0;
                statusMsg = `Aligned, restarting executor`;
              } else {
                statusMsg = `Aligned, awaiting ignition`;
              }
            } else {
              alignedWaitingCount = 0; // Reset when not aligned
              // Check for stuck alignment (angle not changing)
              if (lastWarpAlignAngle !== null) {
                const angleChange = Math.abs(currentAngle - lastWarpAlignAngle);
                if (angleChange < 0.5) {
                  warpAlignStuckCount++;
                  if (warpAlignStuckCount >= WARPALIGN_STUCK_THRESHOLD) {
                    log.warn(`${logPrefix} Alignment stuck at ${currentAngle.toFixed(1)}° - attempting recovery`);
                    // Try to unstick by clearing steering and resetting
                    try {
                      await conn.raw('UNLOCK STEERING. SAS OFF. WAIT 0.3. SAS ON. SET SASMODE TO "MANEUVER".', 5000);
                    } catch { /* ignore */ }
                    warpAlignStuckCount = 0;
                  }
                } else {
                  warpAlignStuckCount = 0;
                }
              }
              statusMsg = `Aligning: ${currentAngle.toFixed(0)}°`;
            }
            lastWarpAlignAngle = currentAngle;
          } catch {
            statusMsg = 'Aligning...';
          }
          break;
        }
        default: {
          statusMsg = execState.toLowerCase();
        }
        }

        if (execState !== lastStatus) {
          log.progress(`${logPrefix} ${statusMsg}`);
          lastStatus = execState;
          lastLogTime = now;
        } else if (now - lastLogTime >= 20_000) {
          // Log progress every 20 seconds at least
          log.progress(`${logPrefix} ${statusMsg}`);
          lastLogTime = now;
        }
      },
    });

    // Handle poll result
    if (result.success && result.result) {
      const state = result.result;

      if (state.noNode || state.burnComplete) {
        // All cleanup commands wrapped in try/catch to prevent stalls if connection dies
        try { await stopWarp(conn); } catch { /* ignore */ }

        // Log completion
        log.progress(`${logPrefix} Burn complete`);

        // Unlock steering and turn off RCS BEFORE removing node (steering references NEXTNODE:BURNVECTOR)
        try { await conn.raw('UNLOCK STEERING. UNLOCK THROTTLE. RCS OFF.', 2000); } catch { /* ignore */ }

        // Log burn error (residual dV) and clear node
        if (state.dvRemaining > 0.1) {
          log.progress(`${logPrefix} Burn error: ${fmtVel(state.dvRemaining)}`);
        }
        try { await conn.raw('IF HASNODE { REMOVE NEXTNODE. }', 3000); } catch { /* ignore */ }

        // Restore thrust if it was limited for small burns
        if (thrustWasLimited) {
          try { await restoreEngineThrust(conn, log); } catch { /* ignore */ }
        }

        // Fine tune phase - optional precision adjustment using engine + RCS
        if (fineTuneFunction) {
          try {
            log.progress(`${logPrefix} Fine tune phase...`);

            // Step 1: Align prograde using same RCS pulse logic as pre-burn alignment
            log.progress(`${logPrefix} Aligning prograde for fine-tune...`);
            const alignResult = await runAlignScript(conn, 'prograde', ALIGN_THRESHOLD, 30_000, dvRequired, log);
            if (!alignResult.success) {
              log.warn(`${logPrefix} Prograde alignment incomplete: ${alignResult.errorAngle}°`);
            }

            // Enable SAS prograde to maintain heading during fine-tune burns
            await conn.raw('SAS ON. WAIT 0.1. SET SASMODE TO "PROGRADE". RCS OFF.', 3000);

            // Step 2: Set engine thrust to low limit for precision
            await conn.raw(`FOR eng IN SHIP:ENGINES { SET eng:THRUSTLIMIT TO ${FINE_TUNE_THRUST_LIMIT}. }`, 3000);

            // Step 3: Query initial error
            // For transfer orbits: positive = periapsis too high, negative = too low
            // Orbital mechanics for transfers:
            //   - Prograde → arrive faster → LOWER periapsis (deeper approach)
            //   - Retrograde → arrive slower → HIGHER periapsis (shallower approach)
            let fineTuneResult = await fineTuneFunction(conn);
            let engineAttempts = 0;

            // Step 4: Prograde engine bursts for FAR ENCOUNTER (result > 0, periapsis too high)
            // Speed up to arrive faster and penetrate deeper into target's gravity well
            while (fineTuneResult > 0 && engineAttempts < FINE_TUNE_MAX_ATTEMPTS) {
              engineAttempts++;
              log.progress(`${logPrefix} Engine burst ${engineAttempts}/${FINE_TUNE_MAX_ATTEMPTS} (error: +${Math.round(fineTuneResult / 1000)}km)`);

              // Brief engine burn while aligned prograde
              await conn.raw(`LOCK THROTTLE TO 1. WAIT ${FINE_TUNE_ENGINE_BURST_MS / 1000}. LOCK THROTTLE TO 0.`, 3000);
              await delay(500);

              fineTuneResult = await fineTuneFunction(conn);
            }

            // Step 5: Retrograde RCS bursts for IMPACT/LOW PERIAPSIS (result < 0, periapsis too low)
            // Slow down to arrive slower and have shallower approach
            let rcsAttempts = 0;
            while (fineTuneResult < 0 && rcsAttempts < FINE_TUNE_MAX_ATTEMPTS) {
              rcsAttempts++;
              log.progress(`${logPrefix} RCS burst ${rcsAttempts}/${FINE_TUNE_MAX_ATTEMPTS} (error: ${Math.round(fineTuneResult / 1000)}km)`);

              // RCS burst retrograde - ensure RCS is on, then fire backward
              // Use SHIP:CONTROL:FORE with value well above deadband (0.05)
              await conn.raw(`RCS ON. SET SHIP:CONTROL:FORE TO -1. WAIT ${FINE_TUNE_RCS_BURST_MS / 1000}. SET SHIP:CONTROL:FORE TO 0.`, 3000);
              await delay(300);

              fineTuneResult = await fineTuneFunction(conn);
            }

            // Cleanup RCS controls
            await conn.raw('SET SHIP:CONTROL:FORE TO 0. RCS OFF.', 2000);

            const finalErrorKm = Math.round(fineTuneResult / 1000);
            log.progress(`${logPrefix} Fine tune complete (error: ${finalErrorKm >= 0 ? '+' : ''}${finalErrorKm}km)`);

          } catch (err) {
            log.warn(`${logPrefix} Fine tune error: ${err instanceof Error ? err.message : err}`);
          }

          // Restore engine thrust to 100%
          try {
            await conn.raw('FOR eng IN SHIP:ENGINES { SET eng:THRUSTLIMIT TO 100. }', 3000);
          } catch { /* ignore */ }
        }

        // Enable SAS prograde to maintain heading and avoid RCS drift affecting trajectory
        try {
          await conn.raw('SAS ON. WAIT 0.1. SET SASMODE TO "PROGRADE".');
        } catch { /* ignore SAS errors */ }
        // Clear operation state on success (safety monitor may have already cleared)
        try { await clearKosOperation(conn); } catch { /* ignore */ }
        // Invalidate status cache - orbit changed after burn
        invalidateStatusCache();
        return {
          success: true,
          nodesExecuted: initialNodeCount,
          deltaV: { required: dvRequired, available: dvShipTotal, remaining: state.dvRemaining },
          attempts: attempt
        };
      }

      // Executor stopped but burn incomplete - retry if possible
      if (state.executorStopped) {
        log.progress(`${logPrefix} Executor stopped with ${fmtVel(state.dvRemaining)} remaining`);
        if (attempt < MAX_RETRIES) {
          log.progress(`${logPrefix} Will retry (attempt ${attempt + 1}/${MAX_RETRIES})`);
          await delay(2000);
          continue; // Continue to next retry attempt
        } else {
          // Restore thrust before returning failure
          if (thrustWasLimited) {
            try { await restoreEngineThrust(conn, log); } catch { /* ignore */ }
          }
          await unlockControls(conn);
          try { await clearKosOperation(conn); } catch { /* ignore */ }
          return {
            success: false,
            nodesExecuted: 0,
            error: `Burn incomplete after ${MAX_RETRIES} attempts. ${fmtVel(state.dvRemaining)} remaining.`,
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
        await conn.raw('SET ADDONS:MJ:NODE:ENABLED TO FALSE.', 2000);
        // Restore thrust before returning failure
        if (thrustWasLimited) {
          try { await restoreEngineThrust(conn, log); } catch { /* ignore */ }
        }
        await unlockControls(conn);
        try { await clearKosOperation(conn); } catch { /* ignore */ }

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
  // Restore thrust before returning failure
  if (thrustWasLimited) {
    try { await restoreEngineThrust(conn, log); } catch { /* ignore */ }
  }
  await unlockControls(conn);
  try { await clearKosOperation(conn); } catch { /* ignore */ }
  return {
    success: false,
    nodesExecuted: 0,
    error: 'Unexpected execution flow',
    attempts: lastAttempt
  };
}

/**
 * Get current node execution progress.
 * Uses MechJeb NODE:STATE and NODE:ENABLED for accurate status.
 *
 * @param conn kOS connection
 * @returns ExecuteNodeProgress with current status
 */
export async function getNodeProgress(conn: KosConnection): Promise<ExecuteNodeProgress> {
  // Single atomic query for all progress values including MechJeb state
  // Using queue() for clean output extraction
  const result = await conn.queue(
    'PRINT ALLNODES:LENGTH + "|" + ' +
    '(CHOOSE ROUND(NEXTNODE:ETA) IF HASNODE ELSE 0) + "|" + ' +
    'ROUND(THROTTLE * 100) + "|" + ' +
    'ADDONS:MJ:NODE:ENABLED + "|" + ADDONS:MJ:NODE:STATE.',
    3000
  );

  // Parse "count|eta|throttle|enabled|state" format
  const match = result.success
    ? result.output.match(/(\d+)\|(-?\d+)\|(\d+)\|(True|False)\|(\w+)/i)
    : null;

  if (!match) {
    // Fallback if parsing fails
    return {
      nodesRemaining: 0,
      etaToNode: 0,
      throttle: 0,
      executing: false,
      executorState: 'IDLE',
      executorEnabled: false,
    };
  }

  const nodesRemaining = Number.parseInt(match[1]);
  const etaToNode = Number.parseInt(match[2]);
  const throttle = Number.parseInt(match[3]);
  const executorEnabled = match[4].toLowerCase() === 'true';
  const executorState = match[5];

  // executing = MechJeb executor is enabled and not idle
  const executing = executorEnabled && executorState !== 'IDLE';

  return {
    nodesRemaining,
    etaToNode,
    throttle,
    executing,
    executorState,
    executorEnabled,
  };
}

/**
 * Check if MechJeb node executor is currently enabled.
 *
 * @param conn kOS connection
 * @returns true if executor is enabled
 */
export async function isNodeExecutorEnabled(conn: KosConnection): Promise<boolean> {
  const result = await conn.queue('PRINT ADDONS:MJ:NODE:ENABLED.', 2000);
  return result.success && result.output.includes('True');
}

/**
 * Disable the MechJeb node executor.
 *
 * @param conn kOS connection
 */
export async function disableNodeExecutor(conn: KosConnection): Promise<void> {
  await conn.raw('SET ADDONS:MJ:NODE:ENABLED TO FALSE.', 2000);
}

// ============================================================================
// Tool Definition
// ============================================================================

import { z } from 'zod';
import type { ToolDefinition } from '../tool-types.js';

/**
 * Execute node tool definition
 */
export const executeNodeTool: ToolDefinition = {
  name: 'execute_node',
  description: 'Execute next maneuver.',
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
  tier: 2,
  handler: async (args, ctx, extra) => {
    const conn = await ctx.ensureConnected();
    const logger = ctx.createLogger(extra);
    const asyncMode = args.async as boolean;

    try {
      // executeNode() handles validation and operation state tracking internally
      const result = await executeNode(conn, {
        async: asyncMode,
        timeoutMs: (args.timeoutSeconds as number) * 1000,
        logger,
        callerTool: 'execute_node',
      });

      if (result.success) {
        // For async mode, return simple message
        if (asyncMode) {
          return ctx.successResponse('execute_node',
            `Node execution started. Poll status for progress.\n` +
            `Delta-V required: ${result.deltaV?.required ? fmtVel(result.deltaV.required) : '?'}`);
        }

        // Sync mode - build detailed response
        let text = `Executed ${result.nodesExecuted} node(s)`;
        if (result.deltaV) {
          text += `, ${result.deltaV.remaining != null ? fmtVel(result.deltaV.remaining) : '@0m/sec'} remaining`;
        }

        // Check for encounter to provide context-aware next step
        const { queryTargetEncounterInfo } = await import('./shared.js');
        const encounterInfo = await queryTargetEncounterInfo(conn);
        if (encounterInfo && encounterInfo.targetType === 'body') {
          const peAlt = encounterInfo.periapsisInTargetSOI ?? 0;
          const atmHeight = encounterInfo.atmosphereHeight ?? 0;
          const minSafePe = atmHeight > 0 ? atmHeight + 40_000 : 40_000;
          const optimalMaxPe = minSafePe + 50_000;

          if (peAlt < minSafePe && peAlt > 0) {
            text += `\nNext: course_correct to fix low periapsis`;
          } else if (peAlt <= optimalMaxPe) {
            text += `\nNext: warp to ${encounterInfo.targetName} SOI, then circularize`;
          } else if (peAlt <= 500_000) {
            text += `\nNext: course_correct to tighten approach, or warp to SOI`;
          } else {
            text += `\nNext: course_correct to reduce periapsis before warping`;
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
      clearBroadcastLogger();
      return ctx.errorResponse('execute_node', error instanceof Error ? error.message : String(error));
    }
  },
};
