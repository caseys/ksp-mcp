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

import type { KosConnection } from '../../transport/kos-connection.js';
import { delay, queryNumber, unlockControls } from '../mechjeb/shared.js';
import { areWorkaroundsEnabled } from '../../config/workarounds.js';
import { executeNode } from '../mechjeb/execute-node.js';

export interface CrashAvoidanceResult {
  success: boolean;
  error?: string;
  initialPeriapsis?: number;
  finalPeriapsis?: number;
  finalApoapsis?: number;
  deltaVUsed?: number;
  stagesUsed?: number;
  circularized?: boolean;
}

export interface CrashAvoidanceOptions {
  targetPeriapsis?: number;  // Default 10000m (10km)
  timeoutMs?: number;        // Default 300000 (5 min)
  pollIntervalMs?: number;   // Default 1000 (1 sec)
  alignmentThreshold?: number; // Default 10 degrees
}

// Defaults
const DEFAULT_TARGET_PE = 10_000;       // 10km
const DEFAULT_TIMEOUT_MS = 300_000;        // 5 minutes
const DEFAULT_POLL_MS = 1000;          // 1 second
const DEFAULT_ALIGN_THRESHOLD = 10;    // degrees - full throttle below this
const THROTTLE_START_ANGLE = 45;       // degrees - start throttling above this angle
const DV_STAGE_THRESHOLD = 1;          // m/s - stage when below this
const HORIZONTAL_ANGLE_THRESHOLD = 80; // degrees - transition to circularize when angle to UP exceeds this (ship tilting toward horizontal)
const MIN_VERTICAL_SPEED = 20; // m/s - minimum vertical speed before checking apoapsis target

/**
 * Calculate throttle based on alignment angle.
 * Ramps from 0% at startAngle to 100% at fullThrottleAngle.
 */
function calculateThrottle(angle: number, fullThrottleAngle: number, startAngle: number): number {
  if (angle <= fullThrottleAngle) return 1;
  if (angle >= startAngle) return 0;
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

  // Step 1: Enable RCS and SAS with proper waits for initialization
  console.error('[CrashAvoidance] Enabling RCS and SAS, setting RADIALOUT...');
  await conn.execute('RCS ON. SAS ON. WAIT 1. SET SASMODE TO "RADIALOUT". WAIT 0.5.', 4000);

  // Step 2: Query NAVMODE to determine reference frame for angle calculation
  const navmodeResult = await conn.execute('PRINT NAVMODE.', 2000);
  const isSurfaceMode = navmodeResult.output.includes('SURFACE');
  console.error(`[CrashAvoidance] NavMode: ${isSurfaceMode ? 'SURFACE' : 'ORBIT'}`);

  // Choose angle calculation based on navmode:
  // - SURFACE mode: Use SHIP:UP (away from planet center) - robust at low altitude/velocity
  // - ORBIT mode: Use orbital radial-out calculation (perpendicular to velocity in orbital plane)
  const angleCmd = isSurfaceMode
    ? 'PRINT VANG(SHIP:FACING:FOREVECTOR, SHIP:UP:FOREVECTOR).'
    : 'PRINT VANG(SHIP:FACING:FOREVECTOR, VCRS(SHIP:VELOCITY:ORBIT, VCRS(-SHIP:BODY:POSITION, SHIP:VELOCITY:ORBIT)):NORMALIZED).';

  // Step 3: Combined alignment and burn loop
  // Throttle ramps up as alignment improves (0% at 45°, 100% at 10°)
  console.error(`[CrashAvoidance] Starting alignment and burn (throttle ramps from ${THROTTLE_START_ANGLE}° to ${alignmentThreshold}°)...`);
  const burnStart = Date.now();
  let currentPe = initialPe;
  let burnSuccess = false;
  let lastThrottle = -1;
  let circularized = false;

  // Set up throttle control variable in kOS
  await conn.execute('SET MCP_THR TO 0.', 2000);
  await conn.execute('LOCK THROTTLE TO MCP_THR.', 2000);

  while (Date.now() - burnStart < timeoutMs) {
    // Query alignment angle using the appropriate reference frame
    const angleResult = await conn.execute(angleCmd, 2000);
    const angle = Number.parseFloat(angleResult.output.match(/[\d.]+/)?.[0] || '180');

    // Calculate and set throttle based on alignment
    const throttle = calculateThrottle(angle, alignmentThreshold, THROTTLE_START_ANGLE);

    // Update throttle - use locked variable for reliable control
    if (Math.abs(throttle - lastThrottle) > 0.02 || lastThrottle < 0) {
      await conn.execute(`SET MCP_THR TO ${throttle.toFixed(2)}.`, 2000);
      lastThrottle = throttle;
    }

    // Check orbit parameters
    currentPe = await queryNumber(conn, 'PERIAPSIS');
    const currentAp = await queryNumber(conn, 'APOAPSIS');

    // Safety check depends on navmode:
    // - SURFACE mode: first need vertical speed >= 20 m/s, then apoapsis > target
    // - ORBIT mode: monitor periapsis (raising the crash point)
    let isSafe = false;
    let safetyLabel = '';

    if (isSurfaceMode) {
      const vertSpeed = await queryNumber(conn, 'SHIP:VERTICALSPEED');
      if (vertSpeed >= MIN_VERTICAL_SPEED && currentAp > targetPeriapsis) {
        isSafe = true;
        safetyLabel = `Vspd: ${vertSpeed.toFixed(0)}m/s, Ap: ${(currentAp / 1000).toFixed(1)}km`;
      }
    } else {
      if (currentPe > targetPeriapsis) {
        isSafe = true;
        safetyLabel = `Pe: ${(currentPe / 1000).toFixed(1)}km`;
      }
    }

    // Check if safe - if so, transition to circularization
    if (isSafe) {
      console.error(`[CrashAvoidance] Safe! ${safetyLabel} > ${(targetPeriapsis / 1000).toFixed(1)}km target`);
      console.error('[CrashAvoidance] Transitioning to circularization...');

      // Stop throttle
      await conn.execute('SET MCP_THR TO 0.', 2000);
      await unlockControls(conn);

      // Create circularization node at apoapsis
      const circResult = await conn.execute(
        'SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CIRCULARIZE("APOAPSIS").',
        10_000
      );

      if (circResult.output.includes('True')) {
        console.error('[CrashAvoidance] Circularization node created, executing...');
        const execResult = await executeNode(conn);
        if (execResult.success) {
          console.error('[CrashAvoidance] Circularization complete!');
          burnSuccess = true;
          circularized = true;
        } else {
          console.error(`[CrashAvoidance] Circularization failed: ${execResult.error}`);
          burnSuccess = true; // Still safe, just didn't circularize
        }
      } else {
        console.error(`[CrashAvoidance] Failed to create circularization node: ${circResult.output}`);
        burnSuccess = true; // Still safe, just didn't circularize
      }
      break;
    }

    // Monitor angle to UP to detect when ship is tilting toward horizontal
    // This happens when navmode switches and SAS RADIALOUT changes direction
    const upAngle = await queryNumber(conn, 'VANG(SHIP:FACING:FOREVECTOR, SHIP:UP:FOREVECTOR)');
    if (upAngle > HORIZONTAL_ANGLE_THRESHOLD) {
      console.error(`[CrashAvoidance] Ship horizontal (${upAngle.toFixed(1)}°), transitioning to circularization...`);

      // Stop throttle
      await conn.execute('SET MCP_THR TO 0.', 2000);
      await unlockControls(conn);

      console.error(`[CrashAvoidance] Current apoapsis: ${(currentAp / 1000).toFixed(1)} km`);

      // Create circularization node at apoapsis
      const circResult = await conn.execute(
        'SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CIRCULARIZE("APOAPSIS").',
        10_000
      );

      if (circResult.output.includes('True')) {
        console.error('[CrashAvoidance] Circularization node created, executing...');

        // Execute the circularization burn
        const execResult = await executeNode(conn);
        if (execResult.success) {
          console.error('[CrashAvoidance] Circularization complete!');
          burnSuccess = true;
          circularized = true;
        } else {
          console.error(`[CrashAvoidance] Circularization failed: ${execResult.error}`);
        }
      } else {
        console.error(`[CrashAvoidance] Failed to create circularization node: ${circResult.output}`);
      }
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

  // Step 4: Stop throttle and unlock controls
  console.error('[CrashAvoidance] Stopping throttle...');
  await conn.execute('SET MCP_THR TO 0.', 2000);
  await unlockControls(conn);

  // Calculate delta-v used
  const finalDv = await queryNumber(conn, 'SHIP:DELTAV:CURRENT');
  const deltaVUsed = initialDv - finalDv;
  const finalPe = await queryNumber(conn, 'PERIAPSIS');
  const finalAp = await queryNumber(conn, 'APOAPSIS');

  console.error(`[CrashAvoidance] Complete. Pe: ${initialPe.toFixed(0)}m → ${finalPe.toFixed(0)}m, Ap: ${(finalAp / 1000).toFixed(1)}km, ΔV used: ${deltaVUsed.toFixed(1)} m/s${circularized ? ' (circularized)' : ''}`);

  return {
    success: burnSuccess,
    error: burnSuccess ? undefined : `Timeout: periapsis at ${finalPe.toFixed(0)}m (target: ${targetPeriapsis}m)`,
    initialPeriapsis: initialPe,
    finalPeriapsis: finalPe,
    finalApoapsis: finalAp,
    deltaVUsed,
    stagesUsed,
    circularized,
  };
}
