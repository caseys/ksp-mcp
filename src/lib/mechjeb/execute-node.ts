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
import { areWorkaroundsEnabled } from '../../config/workarounds.js';
import { config } from '../../config/index.js';
import { type McpLogger, nullLogger } from '../tool-types.js';
import { clearBroadcastLogger } from '../../utils/mcp-logger.js';
import { stopWarp } from '../kos/warp.js';
import { pollWithBlackoutResilience } from '../../utils/poll-with-resilience.js';
import { setKosOperation, clearKosOperation } from '../../utils/kos-operation-state.js';

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
// RCS Fine-Tune System - Reusable orbital property adjustment via RCS pulses
// ============================================================================

/** Control axis for RCS pulses */
export type ControlAxis = 'fore' | 'starboard' | 'top';
// fore = prograde/retrograde
// starboard = normal (left/right)
// top = radial (up/down)

/** Property query function - returns current value or null if unavailable */
export type PropertyQuery = (conn: KosConnection) => Promise<number | null>;

/** Direction strategy for initial pulse direction */
export type DirectionStrategy =
  | 'higher-means-negative'  // If value > target, pulse negative (-1) - default for periapsis
  | 'higher-means-positive'  // If value > target, pulse positive (+1)
  | ((current: number, target: number) => 1 | -1);  // Custom function

/** Configuration for RCS fine-tuning */
export interface FineTuneConfig {
  /** Function to query current property value (returns meters/degrees/etc) */
  queryProperty: PropertyQuery;

  /** Target value in base units */
  targetValue: number;

  /** Control axis (default: 'fore') */
  controlAxis?: ControlAxis;

  /** How to determine initial pulse direction (default: 'higher-means-negative') */
  directionStrategy?: DirectionStrategy;

  /** Tolerance - property is "good enough" when within this */
  tolerance?: {
    absolute?: number;  // e.g., 1000 (meters)
    relative?: number;  // e.g., 0.25 (25% of target)
  };

  /** Limits for termination */
  limits?: {
    maxPulses?: number;      // Default: 20
    maxReversals?: number;   // Default: 3
  };

  /** Pulse duration tuning */
  pulse?: {
    initial?: number;   // Default: 0.05s (50ms)
    min?: number;       // Default: 0.01s (10ms)
    max?: number;       // Default: 0.25s (250ms)
  };

  /** Logger for progress messages */
  logger?: McpLogger;

  /** Prefix for log messages (default: 'FineTune') */
  logPrefix?: string;
}

/** Result from RCS fine-tuning */
export interface FineTuneResult {
  success: boolean;
  finalValue: number;
  targetValue: number;
  pulsesUsed: number;
  reason: 'tolerance' | 'maxPulses' | 'maxReversals' | 'lostProperty' | 'error';
  error?: string;
}

// ============================================================================
// Property Query Helpers - Pre-built queries for common orbital properties
// ============================================================================

/**
 * Parse a value with units (e.g., "214.1 km", "50000 m", "1.2 Mm")
 * Returns null if parsing fails.
 */
function parseUnitValue(output: string): number | null {
  const match = output.match(/([0-9.]+)\s*(m|km|Mm|Gm)?/i);
  if (!match) return null;

  let value = parseFloat(match[1]);
  const unit = (match[2] || 'm').toLowerCase();

  switch (unit) {
    case 'km': value *= 1000; break;
    case 'mm': value *= 1_000_000; break;
    case 'gm': value *= 1_000_000_000; break;
  }

  return value;
}

/** Query periapsis in target SOI (for body encounters) */
async function queryPeriapsis(conn: KosConnection): Promise<number | null> {
  const result = await conn.execute('PRINT ADDONS:MJ:INFO:TPERI.', 3000);
  return parseUnitValue(result.output);
}

/** Get a PropertyQuery for periapsis in target SOI */
export function createPeriapsisQuery(): PropertyQuery {
  return queryPeriapsis;
}

// ============================================================================
// RCS Fine-Tune Core Function
// ============================================================================

/**
 * Get the kOS control suffix for a control axis.
 */
function getControlSuffix(axis: ControlAxis): string {
  switch (axis) {
    case 'fore': return 'FORE';
    case 'starboard': return 'STARBOARD';
    case 'top': return 'TOP';
  }
}

/**
 * Fine-tune an orbital property using RCS pulses.
 *
 * Pre-requisites:
 * - RCS must be enabled before calling
 * - SAS should be ON and set appropriately for the control axis
 * - Any maneuver nodes should be removed (we're adjusting actual orbit)
 *
 * @param conn kOS connection
 * @param config Fine-tune configuration
 */
export async function rcsFineTune(
  conn: KosConnection,
  config: FineTuneConfig
): Promise<FineTuneResult> {
  const {
    queryProperty,
    targetValue,
    controlAxis = 'fore',
    directionStrategy = 'higher-means-negative',
    tolerance = { relative: 0.25 },
    limits = { maxPulses: 20, maxReversals: 3 },
    pulse = { initial: 0.05, min: 0.01, max: 0.25 },
    logger,
    logPrefix = 'FineTune',
  } = config;

  const log = logger ?? nullLogger;
  const controlSuffix = getControlSuffix(controlAxis);

  // Calculate tolerance value
  const toleranceValue = tolerance.absolute ?? (tolerance.relative ?? 0.25) * targetValue;

  // Get initial value
  let currentValue = await queryProperty(conn);
  if (currentValue === null) {
    return {
      success: false,
      finalValue: 0,
      targetValue,
      pulsesUsed: 0,
      reason: 'lostProperty',
      error: 'Could not read initial property value',
    };
  }

  // Determine initial direction
  let direction: 1 | -1;
  if (typeof directionStrategy === 'function') {
    direction = directionStrategy(currentValue, targetValue);
  } else if (directionStrategy === 'higher-means-positive') {
    direction = currentValue > targetValue ? 1 : -1;
  } else {
    // 'higher-means-negative' (default)
    direction = currentValue > targetValue ? -1 : 1;
  }

  let lastValue = currentValue;
  let wrongWayCount = 0;
  let pulseCount = 0;
  let pulseDuration = pulse.initial ?? 0.05;
  const minPulse = pulse.min ?? 0.01;
  const maxPulse = pulse.max ?? 0.25;
  const maxPulses = limits.maxPulses ?? 20;
  const maxReversals = limits.maxReversals ?? 3;

  while (pulseCount < maxPulses) {
    currentValue = await queryProperty(conn);

    // Check if we lost the property (returns null or invalid)
    if (currentValue === null || currentValue <= 0) {
      log.warn(`[${logPrefix}] Lost property! Reversing direction and retrying...`);
      direction = direction === 1 ? -1 : 1;
      wrongWayCount++;
      await delay(500);
      currentValue = await queryProperty(conn);
      if ((currentValue === null || currentValue <= 0) && wrongWayCount > 2) {
        log.warn(`[${logPrefix}] Property lost after ${wrongWayCount} reversals, stopping`);
        return {
          success: false,
          finalValue: lastValue,
          targetValue,
          pulsesUsed: pulseCount,
          reason: 'lostProperty',
        };
      }
      if (currentValue === null || currentValue <= 0) continue;
    }

    const error = Math.abs(currentValue - targetValue);

    // Check if within tolerance
    if (error <= toleranceValue) {
      log.progress(`[${logPrefix}] RCS done: ${(currentValue / 1000).toFixed(0)}km (${pulseCount} pulse${pulseCount !== 1 ? 's' : ''})`);
      return {
        success: true,
        finalValue: currentValue,
        targetValue,
        pulsesUsed: pulseCount,
        reason: 'tolerance',
      };
    }

    // Check if last pulse made things worse
    if (pulseCount > 0 && lastValue > 0) {
      const lastError = Math.abs(lastValue - targetValue);
      if (error > lastError + 1000) { // Got worse by more than 1km
        log.progress(`[${logPrefix}] RCS: wrong direction (${(lastValue / 1000).toFixed(0)}→${(currentValue / 1000).toFixed(0)}km), reversing`);
        direction = direction === 1 ? -1 : 1;
        wrongWayCount++;
        if (wrongWayCount > maxReversals) {
          log.warn(`[${logPrefix}] Too many direction reversals, stopping`);
          return {
            success: false,
            finalValue: currentValue,
            targetValue,
            pulsesUsed: pulseCount,
            reason: 'maxReversals',
          };
        }
      }
    }

    // Pulse RCS
    await conn.execute(`SET SHIP:CONTROL:${controlSuffix} TO ${direction}. WAIT ${pulseDuration.toFixed(3)}. SET SHIP:CONTROL:${controlSuffix} TO 0.`);
    pulseCount++;
    lastValue = currentValue;

    await delay(200);

    // Check new value and adjust pulse duration
    const newValue = await queryProperty(conn);
    if (newValue !== null && newValue > 0) {
      const changePerPulse = Math.abs(newValue - currentValue);

      // Log every few pulses
      if (pulseCount <= 2 || pulseCount % 3 === 0) {
        log.progress(`[${logPrefix}] RCS: ${(newValue / 1000).toFixed(0)}km (dir=${direction > 0 ? '+' : '-'})`);
      }

      // Adjust pulse duration based on change rate
      if (changePerPulse > error * 0.5) {
        pulseDuration = Math.max(minPulse, pulseDuration * 0.5);
      } else if (changePerPulse < error * 0.05 && pulseDuration < maxPulse) {
        pulseDuration = Math.min(maxPulse, pulseDuration * 1.5);
      }

      currentValue = newValue;
    }
  }

  // Max pulses reached
  log.warn(`[${logPrefix}] Max pulses (${maxPulses}) reached`);
  return {
    success: false,
    finalValue: currentValue ?? lastValue,
    targetValue,
    pulsesUsed: pulseCount,
    reason: 'maxPulses',
  };
}

// Configuration
const MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
const DEFAULT_POLL_INTERVAL_MS = 10_000; // 10 seconds
const DV_THRESHOLD = 1; // m/s - consider burn complete below this

// Alignment configuration
const ALIGN_THRESHOLD = 3; // degrees - consider aligned below this
const STEERING_RESET_TRIGGER_TIME = 5000; // ms - unlock and re-lock steering if still stuck
const MAX_ALIGN_TIME = 300_000; // ms - 5 minutes, keep trying (warn after 30s)

/**
 * Format executor state for display.
 * MechJeb states: WARPALIGN, LEAD, BURN, IDLE
 */
function formatExecutorState(state: string): string {
  switch (state.toUpperCase()) {
    case 'WARPALIGN': return 'Checking heading';
    case 'LEAD': return 'Coasting to burn';
    case 'BURN': return 'Burning';
    case 'IDLE': return 'Idle';
    default: return state;
  }
}

/**
 * Align ship to maneuver node using kOS LOCK STEERING before MechJeb takes over.
 *
 * Fallback sequence if no progress:
 * 1. Start with LOCK STEERING (kOS control)
 * 2. After 2s no progress: enable RCS
 * 3. After 5s no progress: switch to SAS MANEUVER mode (if vessel supports it)
 *
 * @param conn kOS connection
 * @param logger Optional MCP logger for progress updates
 * @param logPrefix Prefix for log messages (e.g., '[Maneuver]')
 * @param noRcs If true, don't use RCS during alignment (for small burns)
 */
async function alignToNode(conn: KosConnection, logger?: McpLogger, logPrefix = '[Maneuver]', noRcs = false): Promise<boolean> {
  const log = logger ?? nullLogger;

  // Verify node exists before trying to align
  const nodeCheck = await conn.execute('PRINT HASNODE.');
  if (!nodeCheck.output.includes('True')) {
    log.error(`${logPrefix} No maneuver node exists!`);
    return false;
  }

  // Check initial angle
  const initialAngle = await queryNumber(conn, 'VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR)');
  log.progress(`${logPrefix} Align: initial angle ${fmtNum(initialAngle)}°`);

  // Save RCS state (prefixed with _ as we disable but don't restore)
  const rcsState = await conn.execute('PRINT RCS.');
  const _wasRcsOn = rcsState.output.includes('True');

  // If noRcs mode, ensure RCS is off to prevent trajectory changes during alignment
  if (noRcs) {
    await conn.execute('RCS OFF.');
  }

  // Try SAS MANEUVER mode first (preferred - uses game's autopilot)
  let usingSasMode = false;
  try {
    const sasResult = await conn.execute('SAS ON. WAIT 0.2. SET SASMODE TO "MANEUVER". PRINT SASMODE.', 3000);
    if (sasResult.output.includes('MANEUVER')) {
      log.progress(`${logPrefix} Aligning with SAS MANEUVER...`);
      usingSasMode = true;
    } else {
      // SAS MANEUVER not available - use LOCK STEERING
      log.progress(`${logPrefix} SAS MANEUVER not available, using LOCK STEERING...`);
      await conn.execute('SAS OFF. WAIT 0.1. LOCK STEERING TO NEXTNODE:BURNVECTOR.');
    }
  } catch {
    // Error setting SAS - fall back to LOCK STEERING
    log.progress(`${logPrefix} Aligning with LOCK STEERING...`);
    await conn.execute('SAS OFF. WAIT 0.1. LOCK STEERING TO NEXTNODE:BURNVECTOR.');
  }

  const alignStartTime = Date.now();
  let warnedSlow = false;

  let lastAngle = 180;
  let noProgressSince = Date.now();
  let triedLockSteering = false;

  interface AlignState {
    angle: number;
    aligned: boolean;
  }

  const result = await pollWithBlackoutResilience<AlignState>({
    poll: async () => {
      // Query angle - if parsing fails, return last known angle to avoid false blackout
      const result = await conn.execute('PRINT VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR).', 2000);
      const angle = parseNumber(result.output);
      // If parsing returned 0 but we expect a real angle, use lastAngle as fallback
      // (0 is valid only if we're nearly aligned, which would mean angle < 3)
      const effectiveAngle = (angle === 0 && lastAngle > 10) ? lastAngle : angle;
      return { angle: effectiveAngle, aligned: effectiveAngle < ALIGN_THRESHOLD };
    },

    isDone: (state) => state.aligned,
    isSuccess: (state) => state.aligned,

    timeoutMs: MAX_ALIGN_TIME,
    pollIntervalMs: 750,
    logger: log,
    context: 'AlignToNode',
    connection: conn,

    onPoll: async (state) => {
      log.progress(`${logPrefix} Align: ${fmtNum(state.angle)}°`);

      if (state.aligned) {
        log.progress(`${logPrefix} Aligned! (${fmtNum(state.angle)}°)`);
        return;
      }

      // Warn if alignment is taking a long time (but don't fail)
      if (!warnedSlow && Date.now() - alignStartTime > 30_000) {
        log.warn(`${logPrefix} Alignment is slow (30s+), angle: ${fmtNum(state.angle)}°`);
        warnedSlow = true;
      }

      // Pulse RCS on every iteration to help rotation, then turn off
      // Skip RCS for small burns where it would affect trajectory more than the burn
      if (!noRcs) {
        try {
          await conn.execute('RCS ON. WAIT 0.15. RCS OFF.');
        } catch {
          // Ignore RCS errors during blackout
        }
      }

      // Check for progress (improvement of at least 0.5 degrees)
      const timeSinceProgress = Date.now() - noProgressSince;
      if (state.angle < lastAngle - 0.5) {
        noProgressSince = Date.now();
        lastAngle = state.angle;
        // Reset fallback flag on progress - current method is working
        triedLockSteering = false;
      } else if (timeSinceProgress > STEERING_RESET_TRIGGER_TIME && usingSasMode && !triedLockSteering) {
        // SAS not making progress for 5s - try LOCK STEERING instead
        try {
          log.progress(`${logPrefix} SAS stuck, trying LOCK STEERING... (${fmtNum(state.angle)}°)`);
          await conn.execute('SAS OFF. WAIT 0.1. LOCK STEERING TO NEXTNODE:BURNVECTOR.');
          usingSasMode = false;
          triedLockSteering = true;
          noProgressSince = Date.now();
        } catch {
          // Error switching modes - continue with current method
          log.progress(`${logPrefix} Mode switch failed, continuing...`);
          triedLockSteering = true;
        }
      }
    },
  });

  // Always unlock steering and disable SAS when done (MechJeb will take over)
  try {
    if (usingSasMode) {
      await conn.execute('SAS OFF.');
    } else {
      await conn.execute('UNLOCK STEERING. SAS OFF.');
    }
  } catch {
    // Ignore cleanup errors
  }

  // Ensure RCS is off at end of alignment
  try {
    await conn.execute('RCS OFF.');
  } catch {
    // Ignore errors during cleanup
  }

  // Final verification
  try {
    const finalAngle = await queryNumber(conn, 'VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR)');
    log.progress(`${logPrefix} Align complete: ${fmtNum(finalAngle)}°, aligned: ${result.success}`);
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
  noRcsAlign?: boolean; // If true, don't use RCS during alignment (for small burns where RCS would affect trajectory)
  targetPeriapsis?: number; // Target periapsis in meters (for RCS fine-tuning mode)
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
    targetPeriapsis,
  } = options;

  const log = logger ?? nullLogger;
  const logPrefix = callerTool ? `[${callerTool} Maneuver]` : '[Maneuver]';
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

  log.progress(`${logPrefix} ${fmtVel(dvRequired)}, T-${formatTime(initialNodeEta)}`);

  // Set operation state in kOS (persists across restarts, auto-cleared by safety monitor)
  // This enables status tracking even if MCP client times out
  await setKosOperation(conn, 'node', callerTool ?? 'execute_node', fmtVel(dvRequired));

  // Determine if staging will be needed during burn
  const needsStaging = dvCurrentStage < dvRequired && dvShipTotal >= dvRequired;
  if (needsStaging) {
    log.progress(`${logPrefix} Current stage: ${fmtVel(dvCurrentStage)}, (staging will be automated)`);
    await conn.execute('WHEN STAGE:DELTAV:CURRENT < 1 THEN { STAGE. PRINT "Auto-staged during burn". }');
  } else {
    log.progress(`${logPrefix} staging not required`);
  }

  // Get estimated burn duration from MechJeb INFO wrapper
  const burnDuration = await queryNumber(conn, 'ADDONS:MJ:INFO:NEXTMANEUVERNODEBURNTIME');
  const halfBurn = burnDuration / 2;

  // For small burns (< 10 m/s), skip RCS during alignment as it would affect trajectory more than the burn
  const skipRcsForSmallBurn = dvRequired < 10;
  const useNoRcs = noRcsAlign || skipRcsForSmallBurn;
  if (skipRcsForSmallBurn) {
    log.progress(`${logPrefix} Small burn (${fmtVel(dvRequired)}), skipping RCS during alignment`);
  }

  // Best-effort alignment before warp - MechJeb will handle final alignment
  // We don't fail on alignment issues since MechJeb's executor has its own alignment phase
  await alignToNode(conn, logger, logPrefix, useNoRcs).catch(() => {
    log.warn(`${logPrefix} Pre-alignment failed, MechJeb will align during execution`);
  });

  // For very small burns (< 5 m/s), use RCS pulses instead of MechJeb executor
  // This prevents engine/alignment artifacts from affecting trajectory more than the burn
  // BUT only if we have an actual encounter - RCS fine-tune needs valid TPERI readings
  const TINY_BURN_THRESHOLD = 5;
  const hasEncounter = await conn.execute('PRINT SHIP:ORBIT:HASNEXTPATCH.', 2000)
    .then(r => r.output.includes('True'))
    .catch(() => false);

  if (dvRequired < TINY_BURN_THRESHOLD && hasEncounter && targetPeriapsis) {
    // For tiny burns, use RCS pulses to REPLACE the burn entirely
    // This prevents engine/alignment artifacts from affecting trajectory more than the burn

    // Save node ETA before removing (for warp timing)
    const savedNodeEta = await queryNumber(conn, 'NEXTNODE:ETA').catch(() => 0);

    // Remove the node - we'll use periapsis monitoring instead
    await conn.execute('IF HASNODE { REMOVE NEXTNODE. }', 3000);

    const targetPe = targetPeriapsis ?? 50_000;
    const periapsisQuery = createPeriapsisQuery();

    // Validate we can read periapsis before proceeding
    const initialPe = await periapsisQuery(conn);
    if (initialPe === null || initialPe <= 0) {
      log.warn(`${logPrefix} Could not read target periapsis, skipping RCS fine-tune`);
      await clearKosOperation(conn).catch(() => { /* ignore */ });
      return { success: false, nodesExecuted: 0, error: 'Could not read target periapsis for RCS fine-tuning' };
    }

    log.progress(`${logPrefix} RCS fine-tune: ${(initialPe / 1000).toFixed(0)}km → ${(targetPe / 1000).toFixed(0)}km target`);

    // Warp to 5 seconds before original node time (using saved ETA since node is removed)
    if (savedNodeEta > 10 && config.warp.onRails) {
      log.progress(`${logPrefix} Warping (${formatTime(savedNodeEta)})...`);
      await stopWarp(conn);
      const warpTargetTime = savedNodeEta - 5;
      await conn.execute(`KUNIVERSE:TIMEWARP:WARPTO(TIME:SECONDS + ${warpTargetTime}).`, 5000);

      // Wait for warp to complete by checking TIMEWARP:RATE
      let warpWait = 0;
      const maxWarpWait = 600; // 10 minute max warp time
      while (warpWait < maxWarpWait) {
        await delay(1000);
        warpWait++;
        const warpCheck = await conn.execute('PRINT KUNIVERSE:TIMEWARP:RATE.', 2000);
        const rate = parseFloat(warpCheck.output.match(/[\d.]+/)?.[0] || '1');
        if (rate <= 1) break; // Warp complete
      }
      await stopWarp(conn);
      await delay(500);
    }

    // Align PROGRADE with SAS, then enable RCS for fine-tuning
    await conn.execute('SAS ON. WAIT 0.2. SET SASMODE TO "PROGRADE". RCS OFF.');
    await delay(2000);
    await conn.execute('RCS ON.');

    // Use abstracted RCS fine-tune
    const fineTuneResult = await rcsFineTune(conn, {
      queryProperty: periapsisQuery,
      targetValue: targetPe,
      controlAxis: 'fore',
      directionStrategy: 'higher-means-negative',
      tolerance: { relative: 0.25 },
      logger: log,
      logPrefix,
    });

    // Cleanup
    await conn.execute('SET SHIP:CONTROL:FORE TO 0. RCS OFF. SAS ON. SET SASMODE TO "PROGRADE".');

    // Clear operation state
    try { await clearKosOperation(conn); } catch { /* ignore */ }

    return {
      success: fineTuneResult.success,
      nodesExecuted: 1,
      deltaV: { required: dvRequired, available: dvShipTotal, remaining: 0 },
      attempts: fineTuneResult.pulsesUsed,
    };
  }

  // Warp to node if it's far away and warp is enabled
  // Warp target: node time - (burn time / 2) - 15 seconds for alignment
  // This ensures we arrive 15s before the burn should START (not before node time)
  const nodeEta = await queryNumber(conn, 'NEXTNODE:ETA');
  const alignmentBuffer = 15; // Extra time for alignment before burn starts
  const warpLeadTime = halfBurn + alignmentBuffer;
  if (nodeEta > warpLeadTime + 10 && config.warp.onRails) {
    log.progress(`${logPrefix} Node in T-minus ${formatTime(nodeEta)}, burn ~${formatTime(burnDuration)}, warping to T-minus ${formatTime(warpLeadTime)}`);

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
    log.progress(`${logPrefix} Attempt ${attempt} of ${MAX_RETRIES}`);

    // Workaround: Shift node time earlier by half burn duration
    // MechJeb fires at node time instead of centering the burn
    if (areWorkaroundsEnabled() && halfBurn > 0) {
      // disabled for now
      //await conn.execute(`SET nd TO NEXTNODE. SET nd:ETA TO nd:ETA - ${halfBurn.toFixed(1)}.`, 3000);
    }

    // Stop any active warp before executing
    await stopWarp(conn);

    // Turn off SAS - MechJeb handles its own steering now
    await conn.execute('SAS OFF.');

    // Enable MechJeb node executor
    await conn.execute('SET ADDONS:MJ:NODE:ENABLED TO TRUE.', 5000);

    // Disabled: using kOS WARPTO instead of kickstart pulses
    // Warp assist: if node > 15s away, kickstart MechJeb warp handling
    // const warpCheckResult = await conn.execute('IF HASNODE { PRINT NEXTNODE:ETA. } ELSE { PRINT 0. }', 1500);
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

    // Track last valid state for fallback during parsing errors
    let lastValidState: BurnPollState | null = null;

    // Wait for burn completion using pollWithBlackoutResilience
    const result = await pollWithBlackoutResilience<BurnPollState>({
      poll: async () => {
        // Query progress - when MechJeb completes the burn, it removes the node
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
          // Parsing failed but connection worked - return last valid state or a placeholder
          // Don't throw - that would trigger false blackout detection
          if (lastValidState) {
            return lastValidState; // Keep monitoring with last known state
          }
          // No previous state - return a "still checking" state
          return { noNode: false, dvRemaining: 999, executorEnabled: true, executorState: 'WARPALIGN', burnComplete: false, executorStopped: false, nodeEta: 0 };
        }

        const dvRemaining = Number.parseFloat(progressMatch[1]);
        const executorEnabled = progressMatch[2].toLowerCase() === 'true';
        const executorState = progressMatch[3];
        const nodeEta = Number.parseInt(progressMatch[4]);
        const burnComplete = dvRemaining < DV_THRESHOLD;
        const executorStopped = !executorEnabled && dvRemaining >= DV_THRESHOLD;

        const state = { noNode: false, dvRemaining, executorEnabled, executorState, burnComplete, executorStopped, nodeEta };
        lastValidState = state; // Save for fallback
        return state;
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
          : `with ${fmtVel(state.dvRemaining)} remaining`;

        if (status !== lastStatus) {
          log.progress(`${logPrefix} ${status}, ${statusDetail}`);
          lastStatus = status;
          lastLogTime = now;
        } else if (now - lastLogTime >= 20_000) {
          // Log progress every 20 seconds at least
          log.progress(`${logPrefix} ${status}, ${statusDetail}`);
          lastLogTime = now;
        }

        conn.execute(`SET WARP TO +1.`);

        // Disabled: using kOS WARPTO instead of kickstart pulses
        // Kickstart warp if coasting to node (high dV = not burning yet)
        // if (state.dvRemaining > 10) {
        //   await kickstartWarp(conn, log);
        // }
      },
    });

    // Handle poll result
    if (result.success && result.result) {
      const state = result.result;

      if (state.noNode || state.burnComplete) {
        await stopWarp(conn);
        if (state.burnComplete && !state.noNode) {
          log.progress(`${logPrefix} Burn complete! (${fmtVel(state.dvRemaining)} remaining < ${fmtVel(DV_THRESHOLD)} threshold)`);
          // Clear the residual node to avoid "No maneuver nodes present!" errors
          await conn.execute('IF HASNODE { REMOVE NEXTNODE. }', 3000);
        }
        // Enable SAS prograde to maintain heading and avoid RCS drift affecting trajectory
        try {
          await conn.execute('SAS ON. WAIT 0.1. SET SASMODE TO "PROGRADE".');
        } catch { /* ignore SAS errors */ }
        // Clear operation state on success (safety monitor may have already cleared)
        try { await clearKosOperation(conn); } catch { /* ignore */ }
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
        await conn.execute('SET ADDONS:MJ:NODE:ENABLED TO FALSE.', 2000);
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
  const result = await conn.execute(
    'PRINT "NODEPROG|" + ALLNODES:LENGTH + "|" + ' +
    '(CHOOSE ROUND(NEXTNODE:ETA) IF HASNODE ELSE 0) + "|" + ' +
    'ROUND(THROTTLE * 100) + "|" + ' +
    'ADDONS:MJ:NODE:ENABLED + "|" + ADDONS:MJ:NODE:STATE.',
    3000
  );

  // Parse "NODEPROG|count|eta|throttle|enabled|state" format
  const match = result.output.match(/NODEPROG\|(\d+)\|(-?\d+)\|(\d+)\|(True|False)\|(\w+)/i);

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
      clearBroadcastLogger();
      return ctx.errorResponse('execute_node', error instanceof Error ? error.message : String(error));
    }
  },
};
