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
import { type McpLogger, nullLogger } from '../tool-types.js';
import { clearBroadcastLogger } from '../../utils/mcp-logger.js';
import { stopWarp } from '../kos/warp.js';
import { forceDisconnect, ensureConnected } from '../../transport/connection-tools.js';
import { pollWithBlackoutResilience, probeForRadioReturn } from '../../utils/poll-with-resilience.js';
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
const FINE_TUNE_MIN_BURST_MS = 50;     // Minimum burst duration
const FINE_TUNE_MAX_BURST_MS = 5000;   // Maximum burst duration (5 seconds)
const FINE_TUNE_MAX_ATTEMPTS = 15;     // Max attempts per direction (safety limit)
const FINE_TUNE_THRUST_LIMIT = 15;     // Engine thrust limit %
const FINE_TUNE_TARGET_REDUCTION = 0.25; // Target 25% error reduction per burst

/** Calculate initial burst duration based on error magnitude */
function initialBurstDuration(errorMeters: number): number {
  const absKm = Math.abs(errorMeters) / 1000;
  if (absKm > 500) return 1000;
  if (absKm > 100) return 500;
  if (absKm > 10) return 200;
  return 100;
}

/** Options for alignHeading() */
interface AlignHeadingOptions {
  iteration: 1 | 2 | 3;
  targetError?: number;  // Default: 5°
  burnDv?: number;
  logger?: McpLogger;
  logPrefix?: string;
}

/** Result from alignHeading() */
interface AlignHeadingResult {
  success: boolean;
  errorAngle: number;
  method: 'steering' | 'sas';
}

/**
 * Align ship heading to a target direction.
 *
 * Consolidated alignment function with iteration-based strategies:
 * - Iteration 1: LOCK STEERING + 2x physics warp + RCS pulses (15s timeout)
 * - Iteration 2: LOCK STEERING + RCS pulses, no warp (20s timeout)
 * - Iteration 3: SAS MANEUVER mode fallback (20s timeout)
 *
 * Supports maneuver node, prograde, or retrograde alignment.
 *
 * @param conn - kOS connection
 * @param target - Alignment target: 'maneuver', 'prograde', or 'retrograde'
 * @param options - Alignment options (iteration, targetError, burnDv, logger, logPrefix)
 * @returns Alignment result with success status, final error angle, and method used
 */
async function alignHeading(
  conn: KosConnection,
  target: AlignmentTarget,
  options: AlignHeadingOptions
): Promise<AlignHeadingResult> {
  const {
    iteration,
    targetError = ALIGN_THRESHOLD,
    burnDv,
    logger,
    logPrefix = '[Align]',
  } = options;

  const log = logger ?? nullLogger;

  // Timeouts per iteration
  const timeouts: Record<1 | 2 | 3, number> = {
    1: 15_000,  // 15s with warp
    2: 20_000,  // 20s without warp
    3: 20_000,  // 20s SAS fallback
  };
  const timeout = timeouts[iteration];

  // Get kOS expressions for the target direction
  const { vector, angleCheck } = getAlignmentExpressions(target);
  const targetName = target === 'maneuver' ? 'burn vector' : target;

  // Verify node exists before trying to align (only for maneuver target)
  if (target === 'maneuver') {
    const nodeCheck = await conn.queue('PRINT HASNODE.', 2000);
    if (!nodeCheck.success || !nodeCheck.output.includes('True')) {
      log.error(`${logPrefix} No maneuver node exists!`);
      return { success: false, errorAngle: 180, method: 'steering' };
    }
  }

  // Check initial angle
  const initialCheck = await conn.queue(`PRINT ROUND(${angleCheck}, 2).`, 3000);
  const initialAngle = parseFloat(initialCheck.output.trim());

  // Already aligned - early return
  if (!isNaN(initialAngle) && initialAngle <= targetError) {
    log.progress(`${logPrefix} Already aligned to ${targetName} (${fmtNum(initialAngle)}°)`);
    return { success: true, errorAngle: initialAngle, method: 'steering' };
  }

  // Log what we're doing
  const methodDesc = iteration === 3 ? 'SAS' : (iteration === 1 ? 'steering+warp' : 'steering');
  log.progress(`${logPrefix} Aligning to ${targetName} (${fmtNum(initialAngle)}°) via ${methodDesc}...`);

  // Cleanup function - comprehensive reset of all controls
  const cleanup = async () => {
    try {
      await conn.raw(
        'UNLOCK STEERING. UNLOCK THROTTLE. SET RCS TO FALSE. SAS OFF. ' +
        'SET WARP TO 0. SET KUNIVERSE:TIMEWARP:MODE TO "RAILS". ' +
        'SET SHIP:CONTROL:NEUTRALIZE TO TRUE.',
        3000
      );
    } catch { /* best effort */ }
  };

  const startTime = Date.now();
  let errorAngle = initialAngle;

  try {
    // Iteration 3: SAS MANEUVER mode fallback
    if (iteration === 3) {
      // Use SAS instead of LOCK STEERING
      const sasMode = target === 'maneuver' ? 'MANEUVER' : (target === 'prograde' ? 'PROGRADE' : 'RETROGRADE');
      await conn.raw(`UNLOCK STEERING. SAS ON. WAIT 0.1. SET SASMODE TO "${sasMode}".`, 3000);

      // Poll until aligned or timeout
      while (Date.now() - startTime < timeout) {
        const result = await conn.queue(`PRINT ROUND(${angleCheck}, 2).`, 3000);
        const angle = parseFloat(result.output.trim());

        if (!isNaN(angle)) {
          errorAngle = angle;
          if (angle <= targetError) {
            await cleanup();
            log.progress(`${logPrefix} Aligned via SAS (${fmtNum(errorAngle)}°)`);
            return { success: true, errorAngle, method: 'sas' };
          }
        }

        await delay(1500);
      }

      // Timeout
      await cleanup();
      return { success: false, errorAngle, method: 'sas' };
    }

    // Iterations 1 & 2: LOCK STEERING with optional warp and RCS

    // Iteration 1 only: Enable 2x physics warp
    if (iteration === 1) {
      await conn.raw('SET KUNIVERSE:TIMEWARP:MODE TO "PHYSICS". SET WARP TO 1.', 3000);
    }

    // Start alignment: LOCK STEERING with frozen up vector
    const alignCmd = `SAS OFF. SET frozenUp TO SHIP:UP:VECTOR. LOCK STEERING TO LOOKDIRUP(${vector}, frozenUp).`;
    await conn.queue(alignCmd, 5000);

    // Poll until aligned or timeout
    while (Date.now() - startTime < timeout) {
      const result = await conn.queue(`PRINT ROUND(${angleCheck}, 2).`, 3000);
      const angle = parseFloat(result.output.trim());

      if (!isNaN(angle)) {
        errorAngle = angle;

        if (angle <= targetError) {
          await cleanup();
          log.progress(`${logPrefix} Aligned via steering (${fmtNum(errorAngle)}°)`);
          return { success: true, errorAngle, method: 'steering' };
        }

        // Iteration 1 only: Drop physics warp when close to aligned
        if (iteration === 1 && angle < 30) {
          await conn.raw('SET WARP TO 0. SET KUNIVERSE:TIMEWARP:MODE TO "RAILS".', 2000);
        }

        // RCS pulses when error >= 15° (both iterations 1 & 2)
        if (angle >= 15) {
          const pulseDuration = calculateRcsPulseDuration(burnDv ?? 100, angle);
          const pulseCount = calculatePulseCount(burnDv ?? 100, angle);

          let pulseCmd = '';
          for (let i = 0; i < pulseCount; i++) {
            pulseCmd += `SET RCS TO TRUE. WAIT ${pulseDuration.toFixed(3)}. SET RCS TO FALSE.`;
            if (i < pulseCount - 1) {
              pulseCmd += ` WAIT ${RCS_PULSE_OFF_TIME}. `;
            }
          }
          await conn.raw(pulseCmd, 5000);
        }
      }

      await delay(1500);
    }

    // Timeout
    await cleanup();
    return { success: false, errorAngle, method: 'steering' };

  } catch (err) {
    await cleanup();
    log.warn(`${logPrefix} Alignment error: ${err instanceof Error ? err.message : err}`);
    return { success: false, errorAngle, method: iteration === 3 ? 'sas' : 'steering' };
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
  connParam: KosConnection,
  options: ExecuteNodeOptions = {}
): Promise<ExecuteNodeResult> {
  let conn = connParam;
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    async: asyncMode = false,
    logger,
    callerTool,
    targetPeriapsis: _targetPeriapsis, // Unused until RCS refinement re-enabled
    fineTuneFunction,
  } = options;

  const log = logger ?? nullLogger;
  const logPrefix = callerTool ? `[${callerTool} Maneuver]` : '[Maneuver]';
  // Clean slate: unlock any stuck controls from previous operations
  await unlockControls(conn);

  // Check if a node exists
  const nodeCheck = await conn.queue('PRINT HASNODE.', 2000);
  if (!nodeCheck.success || !nodeCheck.output.includes('True')) {
    return { success: false, nodesExecuted: 0, error: 'No maneuver node found' };
  }

  // Safety: reject nodes with negative periapsis (crash trajectory)
  // Only check on elliptical orbits — NEXTNODE:ORBIT:PERIAPSIS errors on hyperbolic
  // Skip check if node orbit has a next patch (SOI transition) — negative periapsis
  // around the current body is expected for escape/transfer trajectories.
  const preNodeEcc = await queryNumber(conn, 'ORBIT:ECCENTRICITY');
  if (preNodeEcc < 1) {
    const nodePeCheck = await conn.queue(
      'PRINT ROUND(NEXTNODE:ORBIT:PERIAPSIS) + "|" + NEXTNODE:ORBIT:HASNEXTPATCH.',
      3000
    );
    const peCheckMatch = nodePeCheck.success ? nodePeCheck.output.match(/([-\d.]+)\|(True|False)/i) : null;
    const nodePeM = peCheckMatch ? Number.parseFloat(peCheckMatch[1]) : 0;
    const hasNextPatch = peCheckMatch ? peCheckMatch[2].toLowerCase() === 'true' : false;
    if (nodePeM < 0 && !hasNextPatch) {
      log.info(`${logPrefix} Node periapsis: ${Math.round(nodePeM / 1000)}km — clearing crash node`);
      await clearNodes(conn);
      return {
        success: false,
        nodesExecuted: 0,
        error: `Planned node results in periapsis ${Math.round(nodePeM / 1000)}km below surface. Aborting — node would crash into body.`,
      };
    }
    if (nodePeM < 0 && hasNextPatch) {
      log.info(`${logPrefix} Node periapsis: ${Math.round(nodePeM / 1000)}km but has SOI transition — allowing escape trajectory`);
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

  // Align to node BEFORE enabling MechJeb executor
  // MechJeb's WARPALIGN can get stuck - we want to be aligned before starting
  // Uses iteration-based strategies:
  //   1: LOCK STEERING + physics warp + RCS (15s)
  //   2: LOCK STEERING + RCS, no warp (20s)
  //   3: SAS MANEUVER fallback (20s)
  const MAX_ALIGN_ATTEMPTS = 3;
  let aligned = false;

  for (let alignAttempt = 1; alignAttempt <= MAX_ALIGN_ATTEMPTS; alignAttempt++) {
    const result = await alignHeading(conn, 'maneuver', {
      iteration: alignAttempt as 1 | 2 | 3,
      targetError: ALIGN_THRESHOLD,
      burnDv: dvRequired,
      logger,
      logPrefix,
    });

    if (result.success) {
      aligned = true;
      break;
    }

    // Log failure and what we'll try next
    if (alignAttempt < MAX_ALIGN_ATTEMPTS) {
      const nextMethod = alignAttempt === 1 ? 'without warp' : 'SAS fallback';
      log.warn(`${logPrefix} Alignment attempt ${alignAttempt} failed (${fmtNum(result.errorAngle)}°), trying ${nextMethod}...`);
      await delay(1000);
    } else {
      log.warn(`${logPrefix} Alignment failed after ${MAX_ALIGN_ATTEMPTS} attempts (${fmtNum(result.errorAngle)}°)`);
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

  // Set up post-burn blackout recovery: warp forward after burn completes
  // so TypeScript can regain communication if vessel is behind a body.
  //
  // Detection: dV dropped (burn happened) AND MechJeb idle AND flag not cleared.
  // TypeScript clears _MCP_POST_BURN_WARP when it handles post-burn normally.
  // If TypeScript can't communicate (blackout), flag stays set and trigger warps.
  // 10-second delay lets TypeScript clear the flag if it has connection.
  await conn.raw(
    `SET _MCP_PRE_BURN_DV TO SHIP:DELTAV:CURRENT. ` +
    `SET _MCP_POST_BURN_WARP TO TRUE. ` +
    `WHEN SHIP:DELTAV:CURRENT < _MCP_PRE_BURN_DV - 10 AND ADDONS:MJ:NODE:STATE = "IDLE" AND _MCP_POST_BURN_WARP THEN { ` +
      `WAIT 10. ` +
      `IF _MCP_POST_BURN_WARP { ` +
        `PRINT "Post-burn warp to restore radio". ` +
        `SET _MCP_WARP_COUNT TO 0. ` +
        `UNTIL HOMECONNECTION:ISCONNECTED OR NOT _MCP_POST_BURN_WARP OR _MCP_WARP_COUNT > 20 { ` +
          `SET _MCP_WARP_COUNT TO _MCP_WARP_COUNT + 1. ` +
          `PRINT "Warp " + _MCP_WARP_COUNT + " - no radio contact". ` +
          `KUNIVERSE:TIMEWARP:WARPTO(TIME:SECONDS + 300). ` +
          `WAIT UNTIL KUNIVERSE:TIMEWARP:WARP = 0. ` +
          `WAIT 15. ` +
        `} ` +
        `IF HOMECONNECTION:ISCONNECTED { PRINT "Radio contact restored!". } ` +
        `SET _MCP_POST_BURN_WARP TO FALSE. ` +
      `} ` +
    `}`,
    3000
  );

  // Enable MechJeb executor BEFORE warp — vessel may enter radio blackout on arrival
  // Always disable MechJeb's autowarp — we handle warp ourselves via KUNIVERSE:TIMEWARP:WARPTO
  // MechJeb's autowarp is unreliable and can cause extra delays when it takes over
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
  let hadBlackoutRecovery = false;

  if (nodeEta > warpLeadTime + 10) {
    log.progress(`${logPrefix} Helm, course set for maneuver. Ignition in ${formatTime(nodeEta)}... Engage!`);
    log.info(`${logPrefix} Warp params: nodeEta=${Math.round(nodeEta)}s, halfBurn=${Math.round(halfBurn)}s, leadTime=${Math.round(warpLeadTime)}s, warpFor=${Math.round(nodeEta - warpLeadTime)}s`);

    const warpTargetSeconds = nodeEta - warpLeadTime;
    await conn.raw(`KUNIVERSE:TIMEWARP:WARPTO(TIME:SECONDS + ${warpTargetSeconds}).`, 5000);

    // Suppress resetConnection() during warp — blackout recovery needs the TCP
    // socket alive. Without this, queue() → comsTest() failure → resetConnection()
    // closes the socket and nulls the transport before we can watch for recovery.
    conn.suppressReset = true;
    const transport = conn.getTransport();

    // Wait for warp to complete (poll until ETA is close or warp stops)
    let warpAttempts = 0;
    let lastLoggedEta = nodeEta;
    let lastLogTime = Date.now();
    let signalLost = false;
    const maxWarpAttempts = 240;

    while (warpAttempts < maxWarpAttempts) {
      await delay(2500);

      // Early blackout detection: check buffer for "Signal lost" text
      // kOS sends this during blackout — appears in transport buffer automatically
      if (!signalLost && transport) {
        const buf = transport.peekBuffer();
        if (buf.includes('Signal lost')) {
          signalLost = true;
          log.progress(`${logPrefix} Blackout detected (Signal lost) — launching probe...`);
        }
      }

      // On signal loss: stop queue() calls, launch probe immediately
      if (signalLost) {
        const recovered = await probeForRadioReturn(conn, log, logPrefix);

        if (recovered) {
          log.progress(`${logPrefix} Signal reacquired`);
          hadBlackoutRecovery = true;
          try { await transport?.send?.('SET _MCP_POST_BURN_WARP TO FALSE.\n'); } catch { /* ignore */ }
        } else {
          log.warn(`${logPrefix} Could not reacquire signal after 5 minutes`);
        }
        break;
      }

      // Normal warp polling with queue()
      try {
        const statusResult = await conn.queue(
          'PRINT HASNODE + "|" + WARP + "|" + (CHOOSE NEXTNODE:ETA IF HASNODE ELSE 0).',
          2000
        );
        const parts = statusResult.output.split('|');
        const hasNode = parts[0]?.toLowerCase().includes('true');
        const warpLevel = parseNumber(parts[1] || '0');
        const currentEta = parseNumber(parts[2] || '0');

        // If node appears gone — verify with a second check
        if (!hasNode) {
          await delay(500);
          const recheck = await conn.queue('PRINT HASNODE.', 2000);
          if (recheck.success && recheck.output.includes('False')) {
            log.progress(`${logPrefix} Node gone during warp`);
            break;
          }
          if (!recheck.success) {
            throw new Error('Connection lost during HASNODE recheck');
          }
        }

        // Exit if ETA is low enough
        if (currentEta <= 0 || currentEta <= warpLeadTime + 5) {
          log.progress(`${logPrefix} Dropping out of warp, preparing for maneuver`);
          break;
        }

        // Exit if warp stopped
        if (warpLevel === 0 && warpAttempts > 2) {
          log.progress(`${logPrefix} Warp complete, ${formatTime(currentEta)} to ignition`);
          break;
        }

        // Log progress
        const now = Date.now();
        const etaChanged = Math.abs(currentEta - lastLoggedEta) > 30;
        const timeElapsed = now - lastLogTime >= 15_000;
        if (etaChanged || timeElapsed) {
          log.progress(`${logPrefix} Warping... ignition in ${formatTime(currentEta)}`);
          lastLoggedEta = currentEta;
          lastLogTime = now;
        }
      } catch {
        // queue() failed — signal lost, stop calling queue()
        signalLost = true;
        log.progress(`${logPrefix} Signal lost (queue failed) — launching probe...`);
        continue;
      }
      warpAttempts++;
    }
  }

  // Re-enable normal reset behavior
  conn.suppressReset = false;

  // After blackout recovery, original transport is broken — force fresh connection
  if (hadBlackoutRecovery) {
    try {
      await forceDisconnect();
      conn = await ensureConnected();
      log.progress(`${logPrefix} Reconnected after blackout`);
    } catch (err) {
      log.warn(`${logPrefix} Reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
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

    // Smart warp nudging - when status repeats, nudge warp forward
    let consecutiveSameStatusCount = 0;

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

        // Track consecutive same-status for warp nudging
        if (execState !== lastStatus) {
          consecutiveSameStatusCount = 0;
          log.progress(`${logPrefix} ${statusMsg}`);
          lastStatus = execState;
          lastLogTime = now;
        } else {
          consecutiveSameStatusCount++;

          // Debug: show counter progress for warp nudge candidates
          if ((execState === 'WARPALIGN' || execState === 'LEAD' || execState === 'BURN') && consecutiveSameStatusCount === 1) {
              log.progress(`${logPrefix} Waiting in ${execState} (1/2 for warp nudge)`);
            }

          // After 2+ same status polls, nudge warp forward
          // Nudge in WARPALIGN/LEAD (waiting states) and BURN (when dV remaining is large)
          const shouldNudgeWarp = consecutiveSameStatusCount >= 2 && (
            execState === 'WARPALIGN' ||
            execState === 'LEAD' ||
            (execState === 'BURN' && state.dvRemaining > 100)
          );
          if (shouldNudgeWarp) {
            try {
              // Check if thrusting or in atmosphere to choose warp mode
              // PHYSICS warp required when throttle active or in atmosphere
              // RAILS warp can be used in vacuum with no thrust
              const warpStateCheck = await conn.queue(
                'PRINT "WS|" + WARP + "|" + (THROTTLE > 0) + "|" + ' +
                '(SHIP:BODY:ATM:EXISTS AND ALTITUDE < SHIP:BODY:ATM:HEIGHT).',
                2000
              );
              const wsMatch = warpStateCheck.output.match(/WS\|(\d+)\|(True|False)\|(True|False)/i);
              if (wsMatch) {
                const currentWarp = parseInt(wsMatch[1]);
                const isThrusting = wsMatch[2].toLowerCase() === 'true';
                const inAtmosphere = wsMatch[3].toLowerCase() === 'true';

                if (currentWarp < 4) {
                  // Set appropriate warp mode before increasing
                  const warpMode = (isThrusting || inAtmosphere) ? 'PHYSICS' : 'RAILS';
                  await conn.raw(`SET WARPMODE TO "${warpMode}". SET WARP TO ${currentWarp + 1}.`, 2000);
                  log.progress(`${logPrefix} Nudging warp to ${currentWarp + 1}x ${warpMode}`);
                } else {
                  log.progress(`${logPrefix} Warp already at ${currentWarp}x, not nudging`);
                }
              }
            } catch { /* ignore warp errors */ }
            consecutiveSameStatusCount = 0; // Reset after nudge
          }

          // Log progress every 20 seconds at least
          if (now - lastLogTime >= 20_000) {
            log.progress(`${logPrefix} ${statusMsg}`);
            lastLogTime = now;
          }
        }
      },
    });

    // Handle poll result
    if (result.success && result.result) {
      const state = result.result;

      if (state.noNode || state.burnComplete) {
        // Clear post-burn warp flag — we have connection, no need for kOS WHEN trigger to warp
        try { await conn.raw('SET _MCP_POST_BURN_WARP TO FALSE.', 2000); } catch { /* ignore */ }

        // All cleanup commands wrapped in try/catch to prevent stalls if connection dies
        try { await stopWarp(conn); } catch { /* ignore */ }

        // Reset warp to RAILS mode
        try { await conn.raw('SET WARP TO 0. SET WARPMODE TO "RAILS".', 2000); } catch { /* ignore */ }

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

            // Step 1: Align prograde (iteration 1 only - 15s with warp)
            const alignResult = await alignHeading(conn, 'prograde', {
              iteration: 1,
              targetError: ALIGN_THRESHOLD,
              burnDv: dvRequired,
              logger: log,
              logPrefix,
            });
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
            // Burst duration adapts based on running average of error reduction
            let engineBurstMs = initialBurstDuration(fineTuneResult);
            const engineHistory: Array<{ delta: number; duration: number }> = [];

            while (fineTuneResult > 0 && engineAttempts < FINE_TUNE_MAX_ATTEMPTS) {
              engineAttempts++;
              log.progress(`${logPrefix} Engine burst ${engineAttempts}/${FINE_TUNE_MAX_ATTEMPTS} (error: +${Math.round(fineTuneResult / 1000)}km, ${engineBurstMs}ms)`);

              const errorBefore = fineTuneResult;
              await conn.raw(
                `LOCK THROTTLE TO 1. WAIT ${engineBurstMs / 1000}. LOCK THROTTLE TO 0.`,
                Math.max(3000, engineBurstMs + 2000)
              );
              await delay(500);

              fineTuneResult = await fineTuneFunction(conn);
              const errorDelta = errorBefore - fineTuneResult;

              // Adapt burst duration based on measured efficiency
              if (errorDelta > 0) {
                engineHistory.push({ delta: errorDelta, duration: engineBurstMs });
                const avgDelta = engineHistory.reduce((s, h) => s + h.delta, 0) / engineHistory.length;
                const avgDuration = engineHistory.reduce((s, h) => s + h.duration, 0) / engineHistory.length;
                const efficiency = avgDelta / avgDuration; // error-meters per ms
                const targetDelta = Math.abs(fineTuneResult) * FINE_TUNE_TARGET_REDUCTION;
                engineBurstMs = Math.round(Math.max(FINE_TUNE_MIN_BURST_MS, Math.min(FINE_TUNE_MAX_BURST_MS, targetDelta / efficiency)));
              }
            }

            // Step 5: Retrograde RCS bursts for IMPACT/LOW PERIAPSIS (result < 0, periapsis too low)
            // Slow down to arrive slower and have shallower approach
            let rcsAttempts = 0;
            let rcsBurstMs = initialBurstDuration(fineTuneResult);
            const rcsHistory: Array<{ delta: number; duration: number }> = [];

            while (fineTuneResult < 0 && rcsAttempts < FINE_TUNE_MAX_ATTEMPTS) {
              rcsAttempts++;
              log.progress(`${logPrefix} RCS burst ${rcsAttempts}/${FINE_TUNE_MAX_ATTEMPTS} (error: ${Math.round(fineTuneResult / 1000)}km, ${rcsBurstMs}ms)`);

              const errorBefore = fineTuneResult;
              await conn.queue(
                `RCS ON. WAIT 0.1. SET SHIP:CONTROL:FORE TO -1. WAIT ${rcsBurstMs / 1000}. SET SHIP:CONTROL:FORE TO 0.`,
                Math.max(5000, rcsBurstMs + 3000)
              );
              await delay(300);

              fineTuneResult = await fineTuneFunction(conn);
              const errorDelta = Math.abs(errorBefore) - Math.abs(fineTuneResult);

              // Adapt burst duration based on measured efficiency
              if (errorDelta > 0) {
                rcsHistory.push({ delta: errorDelta, duration: rcsBurstMs });
                const avgDelta = rcsHistory.reduce((s, h) => s + h.delta, 0) / rcsHistory.length;
                const avgDuration = rcsHistory.reduce((s, h) => s + h.duration, 0) / rcsHistory.length;
                const efficiency = avgDelta / avgDuration;
                const targetDelta = Math.abs(fineTuneResult) * FINE_TUNE_TARGET_REDUCTION;
                rcsBurstMs = Math.round(Math.max(FINE_TUNE_MIN_BURST_MS, Math.min(FINE_TUNE_MAX_BURST_MS, targetDelta / efficiency)));
              }
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
        const { queryTargetEncounterInfo, formatEncounterGuidance: fmtGuidance } = await import('./shared.js');
        const encounterInfo = await queryTargetEncounterInfo(conn);
        if (encounterInfo && encounterInfo.targetType === 'body') {
          const peAlt = encounterInfo.periapsisInTargetSOI ?? 0;
          const atmHeight = encounterInfo.atmosphereHeight ?? 0;
          text += fmtGuidance(encounterInfo.targetName, peAlt, atmHeight);
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
