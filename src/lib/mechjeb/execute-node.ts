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
// Thrust Limiting for Small Burns
// ============================================================================

const SMALL_BURN_THRESHOLD = 10; // m/s - burns below this get thrust limiting
const SMALL_BURN_THRUST_LIMIT = 12; // percent - conservative limit for precision

/**
 * Limit engine thrust for small burns.
 * Prevents overshooting by reducing thrust output.
 */
async function limitEngineThrust(
  conn: KosConnection,
  targetPercent: number,
  logger?: McpLogger
): Promise<void> {
  const script = `
    LOCAL count IS 0.
    FOR eng IN SHIP:ENGINES {
      IF eng:IGNITION AND NOT eng:FLAMEOUT {
        SET eng:THRUSTLIMIT TO ${targetPercent}.
        SET count TO count + 1.
      }
    }
    PRINT "THROTTLED|" + count.
  `.trim().replaceAll('\n', ' ');

  const result = await conn.execute(script, 5000);
  const match = result.output.match(/THROTTLED\|(\d+)/);
  const count = match ? parseInt(match[1]) : 0;

  if (count > 0) {
    logger?.progress(`[Maneuver] Limited ${count} engine(s) to ${targetPercent}% thrust`);
  }
}

/**
 * Restore engine thrust limits to 100%.
 */
async function restoreEngineThrust(conn: KosConnection, logger?: McpLogger): Promise<void> {
  await conn.execute(`
    FOR eng IN SHIP:ENGINES {
      SET eng:THRUSTLIMIT TO 100.
    }
  `.trim().replaceAll('\n', ' '), 3000);
  logger?.progress('[Maneuver] Restored engine thrust to 100%');
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
const ALIGN_POLL_INTERVAL = 600; // ms - poll interval for alignment
const MODE_SWITCH_INTERVAL = 2; // switch steering mode every N poll cycles

/** Steering mode for alignment */
type SteeringMode = 'lock' | 'sas';

// WARPALIGN stuck detection configuration
const WARPALIGN_STUCK_THRESHOLD = 3; // Warn after 3 polls with no angle change (~6 seconds)

/**
 * Align ship to maneuver node using alternating steering modes.
 *
 * Approach:
 * - Enable physics warp x2 at start for faster rotation
 * - Alternate between LOCK STEERING and SAS MANEUVER when stuck
 * - RCS pulses in both modes (unless noRcs)
 * - Reset to rails warp x1 at end
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
  log.progress(`${logPrefix} Aligning to burn vector (${fmtNum(initialAngle)}°)...`);

  // Check if vessel supports SAS MANEUVER mode
  const sasCapabilityCheck = await conn.execute(`
    LOCAL has_sas3 IS FALSE.
    FOR c IN SHIP:CREW {
      IF c:TRAIT = "Pilot" AND c:EXPERIENCE >= 3 { SET has_sas3 TO TRUE. BREAK. }
    }
    IF NOT has_sas3 {
      FOR p IN SHIP:PARTS {
        IF p:HASMODULE("ModuleCommand") {
          LOCAL m IS p:GETMODULE("ModuleCommand").
          IF m:HASFIELD("minimumCrew") AND m:GETFIELD("minimumCrew") = 0 {
            IF p:NAME:CONTAINS("hecs2") OR p:NAME:CONTAINS("HECS2") OR
               p:NAME:CONTAINS("rc001") OR p:NAME:CONTAINS("RC-001") OR
               p:NAME:CONTAINS("rc-l01") OR p:NAME:CONTAINS("RC-L01") OR
               p:NAME:CONTAINS("droneCore") OR p:NAME:CONTAINS("mk2") OR p:NAME:CONTAINS("mk3") {
              SET has_sas3 TO TRUE. BREAK.
            }
          }
        }
      }
    }
    PRINT "SAS3:" + has_sas3.
  `.replaceAll('\n', ' '), 5000);

  const supportsSasManeuver = sasCapabilityCheck.output.includes('SAS3:True');

  // ========== ENABLE PHYSICS WARP AT START ==========
  try {
    await conn.execute('SAS OFF. UNLOCK STEERING. SET WARPMODE TO "PHYSICS". SET WARP TO 1.');
  } catch { /* ignore warp errors */ }

  // Start with LOCK STEERING mode
  // Use object to avoid TypeScript control flow narrowing issues with async callbacks
  const state = { currentMode: 'lock' as SteeringMode, pollCount: 0 };
  let lastAngle = initialAngle;

  /** Switch to LOCK STEERING mode */
  async function switchToLock(): Promise<void> {
    const script = `
      SAS OFF. WAIT 0.1.
      LOCAL frozenTop IS SHIP:FACING:TOPVECTOR.
      LOCK STEERING TO LOOKDIRUP(NEXTNODE:BURNVECTOR, frozenTop).
    `.trim().replaceAll('\n', ' ');
    await conn.execute(script, 3000);
    state.currentMode = 'lock';
  }

  /** Switch to SAS MANEUVER mode */
  async function switchToSas(): Promise<void> {
    await conn.execute('UNLOCK STEERING. SAS ON. WAIT 0.2. SET SASMODE TO "MANEUVER".', 3000);
    state.currentMode = 'sas';
  }

  // Initialize LOCK STEERING
  const initScript = `
    SAS OFF. WAIT 0.1.
    LOCAL frozenTop IS SHIP:FACING:TOPVECTOR.
    LOCK STEERING TO LOOKDIRUP(NEXTNODE:BURNVECTOR, frozenTop).
  `.trim().replaceAll('\n', ' ');
  await conn.execute(initScript, 3000);

  interface AlignState {
    angle: number;
    aligned: boolean;
  }

  const alignResult = await pollWithBlackoutResilience<AlignState>({
    poll: async () => {
      const result = await conn.execute('PRINT VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR).', 2000);
      const angle = parseNumber(result.output);
      // Protect against spurious 0 readings
      const effectiveAngle = (angle === 0 && lastAngle > 10) ? lastAngle : angle;
      return { angle: effectiveAngle, aligned: effectiveAngle < ALIGN_THRESHOLD };
    },
    isDone: (s) => s.aligned,
    isSuccess: (s) => s.aligned,
    timeoutMs: 60_000,  // 60 seconds max
    pollIntervalMs: ALIGN_POLL_INTERVAL,
    logger: log,
    context: 'Align',
    connection: conn,
    onPoll: async (s) => {
      state.pollCount++;

      if (s.aligned) {
        log.progress(`${logPrefix} Aligned (${fmtNum(s.angle)}°)`);
        return;
      }

      // Log progress periodically (every ~15° or every 5 polls)
      const angleChanged = lastAngle - s.angle >= 15;
      if (angleChanged || state.pollCount % 5 === 0) {
        log.progress(`${logPrefix} Aligning: ${fmtNum(s.angle)}° (${state.currentMode})`);
      }

      lastAngle = s.angle;

      // RCS pulse to help rotation (in both modes, unless noRcs)
      if (!noRcs) {
        try { await conn.execute('RCS ON. WAIT 0.12. RCS OFF.'); } catch { /* ignore */ }
      }

      // Switch steering mode every MODE_SWITCH_INTERVAL polls
      if (state.pollCount % MODE_SWITCH_INTERVAL === 0) {
        if (state.currentMode === 'lock' && supportsSasManeuver) {
          await switchToSas();
        } else {
          await switchToLock();
        }
      }
    },
  });

  // ========== CLEANUP: RESET TO RAILS WARP ==========
  try {
    await conn.execute('SET WARP TO 0. SET WARPMODE TO "RAILS".');
  } catch { /* ignore warp errors */ }

  // Clean up steering
  try {
    if (state.currentMode === 'sas') {
      await conn.execute('SAS OFF.');
    } else {
      await conn.execute('UNLOCK STEERING. SAS OFF.');
    }
  } catch { /* ignore */ }

  // Ensure RCS is off
  try {
    await conn.execute('RCS OFF.');
  } catch { /* ignore */ }

  // Final verification
  try {
    const finalAngle = await queryNumber(conn, 'VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR)');
    return finalAngle < ALIGN_THRESHOLD;
  } catch {
    return alignResult.success;
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
    targetPeriapsis: _targetPeriapsis, // Unused until RCS refinement re-enabled
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

  log.progress(`${logPrefix} ${fmtVel(dvRequired)}, in ${formatTime(initialNodeEta)}`);

  // Set operation state in kOS (persists across restarts, auto-cleared by safety monitor)
  // This enables status tracking even if MCP client times out
  await setKosOperation(conn, 'node', callerTool ?? 'execute_node', fmtVel(dvRequired));

  // Determine if staging will be needed during burn
  const needsStaging = dvCurrentStage < dvRequired && dvShipTotal >= dvRequired;
  if (needsStaging) {
    log.progress(`${logPrefix} Multi-stage burn (staging automated)`);
    await conn.execute('WHEN STAGE:DELTAV:CURRENT < 1 THEN { STAGE. PRINT "Auto-staged during burn". }');
  }

  // Get estimated burn duration from MechJeb INFO wrapper
  const burnDuration = await queryNumber(conn, 'ADDONS:MJ:INFO:NEXTMANEUVERNODEBURNTIME');
  const halfBurn = burnDuration / 2;

  // For small burns (< 10 m/s), skip RCS during alignment as it would affect trajectory more than the burn
  const skipRcsForSmallBurn = dvRequired < 10;
  const useNoRcs = noRcsAlign || skipRcsForSmallBurn;

  // Best-effort alignment before warp - MechJeb will handle final alignment
  // We don't fail on alignment issues since MechJeb's executor has its own alignment phase
  await alignToNode(conn, logger, logPrefix, useNoRcs).catch(() => {
    log.warn(`${logPrefix} Pre-alignment failed, MechJeb will align during execution`);
  });

  // Check for encounter (kept for future RCS refinement re-enablement)
  const _hasEncounter = await conn.execute('PRINT SHIP:ORBIT:HASNEXTPATCH.', 2000)
    .then(r => r.output.includes('True'))
    .catch(() => false);

  // For small burns, limit engine thrust to prevent overshooting
  let thrustWasLimited = false;
  if (dvRequired < SMALL_BURN_THRESHOLD) {
    await limitEngineThrust(conn, SMALL_BURN_THRUST_LIMIT, log);
    thrustWasLimited = true;
  }

  // Enable MechJeb executor FIRST, before any warp
  // This ensures burn will complete even if we warp into a blackout zone
  // MechJeb runs on the vessel autonomously once enabled
  // IMPORTANT: Unlock steering to prevent kOS steering from conflicting with MechJeb
  await stopWarp(conn);
  await conn.execute('UNLOCK STEERING. SAS OFF. SET ADDONS:MJ:NODE:ENABLED TO TRUE.', 5000);

  // Warp to node if it's far away and warp is enabled
  // Warp target: node time - (burn time / 2) - 15 seconds for alignment
  // This ensures we arrive 15s before the burn should START (not before node time)
  const nodeEta = await queryNumber(conn, 'NEXTNODE:ETA');
  const alignmentBuffer = 15; // Extra time for alignment before burn starts
  const warpLeadTime = halfBurn + alignmentBuffer;

  if (nodeEta > warpLeadTime + 10 && config.warp.onRails) {
    log.progress(`${logPrefix} Helm, course set for maneuver. Ignition in ${formatTime(nodeEta)}... Engage!`);

    const warpTargetSeconds = nodeEta - warpLeadTime;
    await conn.execute(`KUNIVERSE:TIMEWARP:WARPTO(TIME:SECONDS + ${warpTargetSeconds}).`, 5000);

    // Wait for warp to complete (poll until ETA is close)
    let warpAttempts = 0;
    const maxWarpAttempts = 600; // Max 10 minutes of warp checking (1s poll interval)
    while (warpAttempts < maxWarpAttempts) {
      await delay(1000);
      try {
        const currentEta = await queryNumber(conn, 'NEXTNODE:ETA');
        if (currentEta <= warpLeadTime + 5) {
          log.progress(`${logPrefix} Dropping out of warp. preparing for maneuver.`);
          break;
        }
        if (warpAttempts % 30 === 0) {
          log.progress(`${logPrefix} On approach... ignition in ${formatTime(currentEta)}`);
        }
      } catch {
        // May be in blackout during warp - that's fine, MechJeb will handle it
        if (warpAttempts % 30 === 0) {
          log.progress(`${logPrefix} Warp in progress (no signal - autopilot handling)`);
        }
      }
      warpAttempts++;
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

    // For retries (attempt > 1), re-enable MechJeb and log retry
    // First attempt already enabled it before warp
    if (attempt > 1) {
      log.progress(`${logPrefix} Retry attempt ${attempt}/${MAX_RETRIES}`);
      try {
        await stopWarp(conn);
        await conn.execute('SAS OFF. SET ADDONS:MJ:NODE:ENABLED TO TRUE.', 5000);
      } catch {
        // May be in blackout - MechJeb will continue executing autonomously
        log.progress(`${logPrefix} No signal - executing autonomously`);
      }
    }

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
    let parseFailureCount = 0;
    const MAX_PARSE_FAILURES = 10; // After this many failures, assume state is stale and check node directly

    // WARPALIGN stuck detection - track when MechJeb goes back to alignment after burn started
    let burnEverStarted = false;
    let warpAlignStartTime: number | null = null;
    let lastWarpAlignAngle: number | null = null;
    let warpAlignStuckCount = 0;

    // Wait for burn completion using pollWithBlackoutResilience
    const result = await pollWithBlackoutResilience<BurnPollState>({
      poll: async () => {
        // Query MechJeb state first - this is most reliable for completion detection
        // Then query node if it exists. Split into two parts to handle node removal gracefully.
        const progressResult = await conn.execute(
          'PRINT ADDONS:MJ:NODE:ENABLED + "|" + ADDONS:MJ:NODE:STATE + "|" + HASNODE + "|" + (CHOOSE ROUND(NEXTNODE:DELTAV:MAG,1) IF HASNODE ELSE 0) + "|" + (CHOOSE ROUND(NEXTNODE:ETA) IF HASNODE ELSE 0).',
          3000
        );

        // Check for no node - either HASNODE returned False or node was removed
        // Format: enabled|state|hasNode|dv|eta
        const noNodeMatch = progressResult.output.match(/(True|False)\|(\w+)\|False\|/i);
        if (noNodeMatch) {
          const executorEnabled = noNodeMatch[1].toLowerCase() === 'true';
          const executorState = noNodeMatch[2];
          return { noNode: true, dvRemaining: 0, executorEnabled, executorState, burnComplete: true, executorStopped: false, nodeEta: 0 };
        }

        // Parse "enabled|state|hasNode|dv|eta" format (hasNode=True case)
        const progressMatch = progressResult.output.match(/(True|False)\|(\w+)\|True\|([\d.]+)\|(-?\d+)/i);
        if (!progressMatch) {
          parseFailureCount++;
          // After too many parse failures, do a direct node check to break the stall
          if (parseFailureCount >= MAX_PARSE_FAILURES) {
            log.warn(`${logPrefix} Parse failures detected, checking node directly...`);
            try {
              const directCheck = await conn.execute('PRINT HASNODE.', 2000);
              if (!directCheck.output.includes('True')) {
                return { noNode: true, dvRemaining: 0, executorEnabled: false, executorState: 'IDLE', burnComplete: true, executorStopped: false, nodeEta: 0 };
              }
            } catch { /* ignore */ }
            parseFailureCount = 0; // Reset and continue
          }
          // Return last valid state if available (but don't loop forever)
          if (lastValidState) {
            return lastValidState;
          }
          // No previous state - return a "still checking" state
          return { noNode: false, dvRemaining: 999, executorEnabled: true, executorState: 'WARPALIGN', burnComplete: false, executorStopped: false, nodeEta: 0 };
        }

        // Successful parse - reset failure counter
        parseFailureCount = 0;

        const executorEnabled = progressMatch[1].toLowerCase() === 'true';
        const executorState = progressMatch[2];
        const dvRemaining = Number.parseFloat(progressMatch[3]);
        const nodeEta = Number.parseInt(progressMatch[4]);
        const burnComplete = dvRemaining < DV_THRESHOLD;
        // Executor stopped: either disabled, or IDLE state (MechJeb sets IDLE when done even if enabled)
        const executorIdle = executorState.toUpperCase() === 'IDLE';
        const executorStopped = (!executorEnabled || executorIdle) && dvRemaining >= DV_THRESHOLD;

        const state = { noNode: false, dvRemaining, executorEnabled, executorState, burnComplete, executorStopped, nodeEta };
        lastValidState = state; // Save for fallback
        return state;
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
        }

        // Space-themed status messages based on MechJeb executor state
        let statusMsg: string;
        switch (execState) {
        case 'LEAD': {
          statusMsg = `Ignition in ${formatTime(state.nodeEta)}`;
          warpAlignStartTime = null; // Reset when in LEAD
          break;
        }
        case 'BURN': {
          statusMsg = `Burn: ${fmtVel(state.dvRemaining)} to go`;
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
            const angleResult = await conn.execute(
              'PRINT ROUND(VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR), 1).',
              2000
            );
            const currentAngle = parseNumber(angleResult.output);

            // Check if dV is dropping (burn actually happening despite WARPALIGN state)
            const dvDropping = burnEverStarted && state.dvRemaining < dvRequired * 0.95;

            if (dvDropping) {
              // dV is dropping - burn is happening, don't interfere with stuck detection
              // Just let the normal polling continue until burnComplete
              statusMsg = `Burn: ${fmtVel(state.dvRemaining)} to go (realigning)`;
              warpAlignStuckCount = 0; // Reset stuck counter
            } else {
              // Check for stuck alignment (angle not changing)
              if (lastWarpAlignAngle !== null) {
                const angleChange = Math.abs(currentAngle - lastWarpAlignAngle);
                if (angleChange < 0.5) {
                  warpAlignStuckCount++;
                  if (warpAlignStuckCount >= WARPALIGN_STUCK_THRESHOLD) {
                    log.warn(`${logPrefix} Alignment stuck at ${currentAngle.toFixed(1)}° - attempting recovery`);
                    // Try to unstick by clearing steering and resetting
                    try {
                      await conn.execute('UNLOCK STEERING. SAS OFF. WAIT 0.3. SAS ON. SET SASMODE TO "MANEUVER".', 5000);
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

        // Log completion - show residual dV only if significant (> 0.5 m/s)
        if (state.dvRemaining > 0.5) {
          log.progress(`${logPrefix} Burn complete (${fmtVel(state.dvRemaining)} residual)`);
        } else {
          log.progress(`${logPrefix} Burn complete`);
        }

        // Clear any residual node to avoid "No maneuver nodes present!" errors
        try { await conn.execute('IF HASNODE { REMOVE NEXTNODE. }', 3000); } catch { /* ignore */ }

        // Restore thrust if it was limited for small burns
        if (thrustWasLimited) {
          try { await restoreEngineThrust(conn, log); } catch { /* ignore */ }
        }

        // RCS refinement for small burns - DISABLED
        // Causes oscillation issues with distant target corrections.
        // The prograde/retrograde direction strategy doesn't map cleanly to
        // periapsis changes due to orbital geometry at distant intercepts.
        // TODO: Re-enable after reworking direction strategy for course corrections

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
        await conn.execute('SET ADDONS:MJ:NODE:ENABLED TO FALSE.', 2000);
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
