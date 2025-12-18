/**
 * Crash Avoidance - Emergency burn to raise periapsis
 *
 * Performs manual ship control to escape a crash trajectory:
 * 1. Enable RCS and SAS
 * 2. Point to radial-out
 * 3. Wait for alignment
 * 4. Full throttle with auto-staging
 * 5. Monitor until periapsis is safe
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { delay, queryNumber } from '../shared.js';
import { areWorkaroundsEnabled } from '../../../config/workarounds.js';

export interface CrashAvoidanceResult {
  success: boolean;
  error?: string;
  initialPeriapsis?: number;
  finalPeriapsis?: number;
  deltaVUsed?: number;
  stagesUsed?: number;
}

export interface CrashAvoidanceOptions {
  targetPeriapsis?: number;  // Default 10000m (10km)
  timeoutMs?: number;        // Default 300000 (5 min)
  pollIntervalMs?: number;   // Default 1000 (1 sec)
  alignmentThreshold?: number; // Default 10 degrees
}

// Defaults
const DEFAULT_TARGET_PE = 10000;       // 10km
const DEFAULT_TIMEOUT_MS = 300000;     // 5 minutes
const DEFAULT_POLL_MS = 1000;          // 1 second
const DEFAULT_ALIGN_THRESHOLD = 10;    // degrees - full throttle below this
const THROTTLE_START_ANGLE = 45;       // degrees - start throttling above this angle
const DV_STAGE_THRESHOLD = 1;          // m/s - stage when below this

/**
 * Calculate throttle based on alignment angle.
 * Ramps from 0% at startAngle to 100% at fullThrottleAngle.
 */
function calculateThrottle(angle: number, fullThrottleAngle: number, startAngle: number): number {
  if (angle <= fullThrottleAngle) return 1.0;
  if (angle >= startAngle) return 0.0;
  // Linear interpolation between start and full throttle angles
  return 1 - ((angle - fullThrottleAngle) / (startAngle - fullThrottleAngle));
}

/**
 * Emergency burn to raise periapsis above target altitude.
 *
 * Uses RCS and SAS to point radial-out, then burns at full throttle
 * with auto-staging until periapsis exceeds target.
 *
 * @param conn kOS connection
 * @param options Configuration options
 * @returns Result with initial/final periapsis, delta-v used, stages used
 */
export async function crashAvoidance(
  conn: KosConnection,
  options: CrashAvoidanceOptions = {}
): Promise<CrashAvoidanceResult> {
  // When workarounds disabled, return no-op for testing
  if (!areWorkaroundsEnabled()) {
    console.error('[CrashAvoidance] Workarounds disabled, returning no-op');
    return {
      success: true,
      initialPeriapsis: 0,
      finalPeriapsis: 0,
      stagesUsed: 0,
    };
  }

  const {
    targetPeriapsis = DEFAULT_TARGET_PE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_MS,
    alignmentThreshold = DEFAULT_ALIGN_THRESHOLD,
  } = options;

  // Get initial state
  const initialPe = await queryNumber(conn, 'PERIAPSIS');
  const initialDv = await queryNumber(conn, 'SHIP:DELTAV:CURRENT');
  let stagesUsed = 0;

  console.error(`[CrashAvoidance] Initial Pe: ${initialPe.toFixed(0)}m, Target: ${targetPeriapsis}m`);
  console.error(`[CrashAvoidance] Ship ΔV: ${initialDv.toFixed(0)} m/s`);

  // Check if already safe
  if (initialPe > targetPeriapsis) {
    console.error('[CrashAvoidance] Already safe, no burn needed');
    return {
      success: true,
      initialPeriapsis: initialPe,
      finalPeriapsis: initialPe,
      deltaVUsed: 0,
      stagesUsed: 0,
    };
  }

  // Check if we have delta-v
  if (initialDv < 1) {
    return {
      success: false,
      error: 'No delta-v available',
      initialPeriapsis: initialPe,
      finalPeriapsis: initialPe,
      deltaVUsed: 0,
      stagesUsed: 0,
    };
  }

  // Step 1: Enable RCS and SAS
  console.error('[CrashAvoidance] Enabling RCS and SAS...');
  await conn.execute('RCS ON. SAS ON.', 2000);

  // Step 2: Set SAS to radial-out
  console.error('[CrashAvoidance] Setting SAS to RADIALOUT...');
  await conn.execute('SET SASMODE TO "RADIALOUT".', 2000);

  // Step 3: Combined alignment and burn loop
  // Throttle ramps up as alignment improves (0% at 45°, 100% at 10°)
  console.error(`[CrashAvoidance] Starting alignment and burn (throttle ramps from ${THROTTLE_START_ANGLE}° to ${alignmentThreshold}°)...`);
  const burnStart = Date.now();
  let currentPe = initialPe;
  let burnSuccess = false;
  let lastThrottle = -1;

  // Set up throttle control variable in kOS
  await conn.execute('SET MCP_THR TO 0.', 2000);
  await conn.execute('LOCK THROTTLE TO MCP_THR.', 2000);

  while (Date.now() - burnStart < timeoutMs) {
    // Query alignment angle to radial-out
    // Radial-out = cross(velocity, angular_momentum) where angular_momentum = cross(position, velocity)
    const angleResult = await conn.execute(
      'PRINT VANG(SHIP:FACING:FOREVECTOR, VCRS(SHIP:VELOCITY:ORBIT, VCRS(-SHIP:BODY:POSITION, SHIP:VELOCITY:ORBIT)):NORMALIZED).',
      2000
    );
    const angle = parseFloat(angleResult.output.match(/[\d.]+/)?.[0] || '180');

    // Calculate and set throttle based on alignment
    const throttle = calculateThrottle(angle, alignmentThreshold, THROTTLE_START_ANGLE);

    // Update throttle - use locked variable for reliable control
    if (Math.abs(throttle - lastThrottle) > 0.02 || lastThrottle < 0) {
      await conn.execute(`SET MCP_THR TO ${throttle.toFixed(2)}.`, 2000);
      lastThrottle = throttle;
    }

    // Check periapsis
    currentPe = await queryNumber(conn, 'PERIAPSIS');

    // Check if safe
    if (currentPe > targetPeriapsis) {
      console.error(`[CrashAvoidance] Safe! Pe: ${currentPe.toFixed(0)}m`);
      burnSuccess = true;
      break;
    }

    // Check stage delta-v, auto-stage if depleted (only if throttle > 0)
    if (throttle > 0) {
      const stageDv = await queryNumber(conn, 'STAGE:DELTAV:CURRENT');
      if (stageDv < DV_STAGE_THRESHOLD) {
        console.error('[CrashAvoidance] Stage depleted, staging...');
        await conn.execute('STAGE.', 2000);
        stagesUsed++;
        await delay(500);
        continue;
      }
    }

    // Log progress
    const throttlePct = (throttle * 100).toFixed(0);
    console.error(`[CrashAvoidance] Angle: ${angle.toFixed(1)}°, Throttle: ${throttlePct}%, Pe: ${currentPe.toFixed(0)}m`);

    await delay(pollIntervalMs);
  }

  // Step 4: Stop throttle
  console.error('[CrashAvoidance] Stopping throttle...');
  await conn.execute('SET MCP_THR TO 0. UNLOCK THROTTLE.', 2000);

  // Calculate delta-v used
  const finalDv = await queryNumber(conn, 'SHIP:DELTAV:CURRENT');
  const deltaVUsed = initialDv - finalDv;
  const finalPe = await queryNumber(conn, 'PERIAPSIS');

  console.error(`[CrashAvoidance] Complete. Pe: ${initialPe.toFixed(0)}m → ${finalPe.toFixed(0)}m, ΔV used: ${deltaVUsed.toFixed(1)} m/s`);

  return {
    success: burnSuccess,
    error: burnSuccess ? undefined : `Timeout: periapsis at ${finalPe.toFixed(0)}m (target: ${targetPeriapsis}m)`,
    initialPeriapsis: initialPe,
    finalPeriapsis: finalPe,
    deltaVUsed,
    stagesUsed,
  };
}
