/**
 * MechJeb Ascent Program
 *
 * Task-oriented interface for launching to orbit
 */

import type { KosConnection } from '../../transport/kos-connection.js';
import type {
  LaunchOptions,
  AscentSettings,
  AscentStatus,
  AscentProgress,
  AscentResult,
  LaunchMode
} from '../types.js';
import { delay } from '../utils/progress.js';
import { formatOrbit, formatTime, fmtNum } from '../utils/format.js';
import { clearNodes } from '../kos/nodes.js';
import { type McpLogger, nullLogger } from '../tool-types.js';
import { clearBroadcastLogger } from '../../utils/mcp-logger.js';
import { config } from '../../config/index.js';
import { ManeuverOrchestrator } from './orchestrator.js';
import { pollWithBlackoutResilience } from '../../utils/poll-with-resilience.js';

// Imports for smart launch parameter resolution
import { hasTarget } from '../kos/target/shared.js';
import { setTarget } from '../kos/target/set-target.js';
import { getTargetValidationInfo } from '../kos/target/validate.js';
import { getVesselStateInfo } from '../kos/vessel/validate.js';
import { getTargetOrbitInfo, getRendezvousInfo } from './targeting/shared.js';
// Note: interplanetaryTransfer not imported - we call MechJeb directly in warpToTransferWindow
// to bypass validation that requires being in orbit
import { queryNodeInfo } from './shared.js';
import { warpForward } from '../kos/warp.js';

// ============================================================================
// Smart Launch Parameter Resolution
// ============================================================================

/**
 * Smart launch parameters resolved based on target type
 */
interface SmartLaunchParams {
  /** Target orbit altitude in meters (undefined = use default/arg) */
  altitude?: number;
  /** Target inclination in degrees (undefined = use arg) */
  inclination?: number;
  /** Launch mode to use */
  launchMode: LaunchMode;
  /** Target name (may be changed if redirected) */
  target?: string;
  /** Pre-launch action required */
  prelaunchAction?: 'warp_to_overhead' | 'warp_to_transfer_window';
  /** Error message if launch is invalid */
  error?: string;
  /** Log message explaining the chosen strategy */
  strategyMessage?: string;
}

/**
 * Query body properties (radius, atmosphere height)
 */
async function getBodyProperties(conn: KosConnection): Promise<{ radius: number; atmHeight: number }> {
  const result = await conn.execute(
    'SET _R TO SHIP:BODY:RADIUS. ' +
    'SET _ATM TO 0. IF SHIP:BODY:ATM:EXISTS { SET _ATM TO SHIP:BODY:ATM:HEIGHT. } ' +
    'PRINT _R + "|" + _ATM.',
    3000
  );
  const match = result.output.match(/([\d.]+)\|([\d.]+)/);
  return {
    radius: match ? Number.parseFloat(match[1]) : 600_000,  // Default to Kerbin
    atmHeight: match ? Number.parseFloat(match[2]) : 70_000
  };
}

/**
 * Calculate default parking orbit altitude based on body properties
 * Returns max(radius/2, atmHeight*2) to ensure safe orbit above atmosphere
 */
function calculateParkingOrbitAltitude(radius: number, atmHeight: number): number {
  const halfRadius = radius / 2;
  const doubleAtm = atmHeight * 2;
  return Math.max(halfRadius, doubleAtm, 80_000);  // Minimum 80km for safety
}


/**
 * Resolve smart launch parameters based on target type and current situation
 */
async function resolveSmartLaunchParams(
  conn: KosConnection,
  targetName: string | undefined,
  logger: McpLogger
): Promise<SmartLaunchParams> {
  // Step 1: Set target if provided
  if (targetName) {
    const result = await setTarget(conn, targetName, 'auto');
    if (!result.success) {
      return { launchMode: 'orbit', error: result.error ?? `Failed to set target '${targetName}'` };
    }
  }

  // Step 2: Get vessel state and target info
  const vesselState = await getVesselStateInfo(conn);
  const targetInfo = await getTargetValidationInfo(conn);

  if (!targetInfo) {
    // No target - fall through to normal launch with defaults
    return { launchMode: 'orbit' };
  }

  const bodyProps = await getBodyProperties(conn);
  const parkingAltitude = calculateParkingOrbitAltitude(bodyProps.radius, bodyProps.atmHeight);

  // Step 3: Handle edge cases (heuristics)

  // Case: We're on a moon and target is a planet (other than our parent)
  if (vesselState.bodyType === 'moon' && targetInfo.class === 'planet') {
    return {
      launchMode: 'orbit',
      error: `Must return to ${vesselState.parentBodyName} before interplanetary transfer to ${targetInfo.name}. Use return_from_moon tool first.`
    };
  }

  // Case: Target is parent body of our moon (e.g., targeting Kerbin from Mun)
  if (vesselState.bodyType === 'moon' && targetInfo.name === vesselState.parentBodyName) {
    return {
      altitude: parkingAltitude,
      // inclination left undefined - will be determined by launch direction
      launchMode: 'orbit',
      target: targetInfo.name,
      prelaunchAction: 'warp_to_overhead',
      strategyMessage: `Launch from ${vesselState.bodyName} to return to ${targetInfo.name} - warping until ${targetInfo.name} is overhead`
    };
  }

  // Case: Target is vessel or moon in a different SOI
  if (!targetInfo.isInShipSOI && (targetInfo.class === 'vessel' || targetInfo.class === 'moon')) {
    // Redirect to the SOI body containing the target
    const redirectTarget = targetInfo.parentBody;
    logger.warn(`[Ascent] Target ${targetInfo.name} is in ${redirectTarget}'s SOI - redirecting target`);
    const redirectResult = await setTarget(conn, redirectTarget, 'body');
    if (!redirectResult.success) {
      return { launchMode: 'orbit', error: redirectResult.error ?? `Failed to redirect to ${redirectTarget}` };
    }

    // Re-query target info after redirect
    const newTargetInfo = await getTargetValidationInfo(conn);
    if (!newTargetInfo) {
      return { launchMode: 'orbit', error: `Target redirected to ${redirectTarget} but failed to query target info` };
    }

    // Now treat as planet transfer
    return {
      altitude: parkingAltitude,
      inclination: 0,
      launchMode: 'orbit',
      target: redirectTarget,
      prelaunchAction: 'warp_to_transfer_window',
      strategyMessage: `Target ${targetInfo.name} is in ${redirectTarget}'s SOI - launching to ${redirectTarget} transfer window`
    };
  }

  // Step 4: Main target type handling

  // Case A: Target is a vessel in same SOI
  if (targetInfo.class === 'vessel' && targetInfo.isInShipSOI) {
    const targetOrbit = await getTargetOrbitInfo(conn);
    const rendezvousInfo = await getRendezvousInfo(conn);

    if (!targetOrbit) {
      return { launchMode: 'orbit', error: 'Could not get target orbit info' };
    }

    const targetInc = targetOrbit.inclination;
    const relativeInc = rendezvousInfo?.relativeInclination ?? Math.abs(targetInc);
    const targetAltitude = targetOrbit.periapsis * 0.95;  // 5% below target

    // Check if inclinations are close (within 5°)
    if (relativeInc <= 5) {
      // Use rendezvous mode - same orbital plane
      return {
        altitude: targetAltitude,
        inclination: targetInc,
        launchMode: 'rendezvous',
        target: targetInfo.name,
        strategyMessage: `Vessel ${targetInfo.name} in same plane (${relativeInc.toFixed(1)}° apart) - using rendezvous launch`
      };
    } else {
      // Use plane mode - different orbital plane
      return {
        altitude: targetAltitude,
        inclination: targetInc,
        launchMode: 'plane',
        target: targetInfo.name,
        strategyMessage: `Vessel ${targetInfo.name} in different plane (${relativeInc.toFixed(1)}° apart) - using plane-matching launch`
      };
    }
  }

  // Case B: Target is a moon in same SOI
  if (targetInfo.class === 'moon' && targetInfo.isInShipSOI) {
    const targetOrbit = await getTargetOrbitInfo(conn);

    if (!targetOrbit) {
      return { launchMode: 'orbit', error: 'Could not get target orbit info' };
    }

    // If moon is nearly equatorial, just do normal launch
    if (targetOrbit.inclination < 0.05) {
      return {
        altitude: parkingAltitude,
        inclination: 0,
        launchMode: 'orbit',
        target: targetInfo.name,
      };
    }

    // Moon has significant inclination - use plane matching
    return {
      altitude: parkingAltitude,
      inclination: targetOrbit.inclination,
      launchMode: 'plane',
      target: targetInfo.name,
      strategyMessage: `Matching planes with ${targetInfo.name} at ${targetOrbit.inclination.toFixed(1)}°`
    };
  }

  // Case C: Target is a planet (interplanetary transfer)
  if (targetInfo.class === 'planet') {
    return {
      altitude: parkingAltitude,
      inclination: 0,  // Equatorial for interplanetary
      launchMode: 'orbit',
      target: targetInfo.name,
      prelaunchAction: 'warp_to_transfer_window',
      strategyMessage: `Target set to the planet ${targetInfo.name}`
    };
  }

  // Fallback: normal launch
  return { altitude: parkingAltitude, inclination: 0, launchMode: 'orbit' };
}

/**
 * Warp to interplanetary transfer window
 * Creates a transfer node, warps to 1 hour before, then deletes the node
 *
 * NOTE: This bypasses normal interplanetaryTransfer validation because we're
 * calling from the launchpad. MechJeb can create transfer nodes from the pad,
 * but our normal validation requires being in orbit.
 *
 * @returns Error message if failed, undefined if successful
 */
async function warpToTransferWindow(
  conn: KosConnection,
  logger: McpLogger
): Promise<string | undefined> {
  logger.progress('[Ascent] Calculating interplanetary transfer window...');

  try {
    // Call MechJeb directly, bypassing our validation (which requires orbit)
    // MechJeb can calculate transfer windows from the launchpad
    const cmd = 'SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:INTERPLANETARY(TRUE).';
    const result = await conn.execute(cmd, 10_000);

    // Check if node was created
    if (result.output.toLowerCase().includes('false') || result.output.toLowerCase().includes('error')) {
      return `Could not create transfer node: ${result.output.trim()}`;
    }

    // Verify a node exists
    const hasNodeResult = await conn.execute('PRINT HASNODE.', 3000);
    if (!hasNodeResult.output.toLowerCase().includes('true')) {
      return 'Transfer node was not created by MechJeb';
    }

    // Get node time and warp to 1 hour before
    const nodeInfo = await queryNodeInfo(conn);
    const warpSeconds = nodeInfo.timeToNode - 3600;  // 1 hour before node

    if (warpSeconds > 60) {
      logger.progress(`[Ascent] Warping to transfer window in ${formatTime(nodeInfo.timeToNode)}...`);

      // Use WARPTO directly - warpForward has crash checks that fail on launchpad
      await conn.execute(`KUNIVERSE:TIMEWARP:WARPTO(TIME:SECONDS + ${warpSeconds}).`, 5000);

      // Wait for warp to complete (poll WARP level)
      let warpComplete = false;
      const maxWait = 600_000;  // 10 minutes max
      const startTime = Date.now();

      while (!warpComplete && (Date.now() - startTime) < maxWait) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const warpResult = await conn.execute('PRINT WARP.', 3000);
        const warpLevel = parseInt(warpResult.output.match(/(\d+)/)?.[1] ?? '0');
        if (warpLevel === 0) {
          warpComplete = true;
        }
      }

      if (!warpComplete) {
        return 'Warp timed out';
      }
      logger.progress('[Ascent] Warp complete');
    } else {
      logger.progress('[Ascent] Transfer window is soon - no warp needed');
    }

    // Clear the node - we just used it for timing
    await clearNodes(conn);
    logger.progress('[Ascent] Transfer node cleared - ready to launch');
    return undefined;  // Success

  } catch (error) {
    return `Transfer window calculation failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Warp until parent body is at zenith (directly overhead)
 * Used when launching from a moon to return to parent body
 */
async function warpUntilBodyOverhead(
  conn: KosConnection,
  bodyName: string,
  logger: McpLogger
): Promise<void> {
  logger.info(`[Ascent] Waiting for ${bodyName} to be overhead...`);

  // Query current angle to body
  const getAngle = async (): Promise<number> => {
    const result = await conn.execute(
      `SET _ANG TO VANG(BODY("${bodyName}"):DIRECTION, SHIP:UP). PRINT _ANG.`,
      3000
    );
    const match = result.output.match(/([\d.]+)/);
    return match ? Number.parseFloat(match[1]) : 90;
  };

  const OVERHEAD_THRESHOLD = 10;  // degrees from zenith
  let angle = await getAngle();

  if (angle <= OVERHEAD_THRESHOLD) {
    logger.info(`[Ascent] ${bodyName} is already overhead (${angle.toFixed(1)}° from zenith)`);
    return;
  }

  // Get moon's rotation period to estimate warp time
  const rotResult = await conn.execute('PRINT SHIP:BODY:ROTATIONPERIOD.', 3000);
  const rotMatch = rotResult.output.match(/([\d.]+)/);
  const rotationPeriod = rotMatch ? Number.parseFloat(rotMatch[1]) : 21_600;  // Default 6 hours

  // Estimate time to overhead - rough approximation based on angle
  // The body will be overhead when we've rotated to face it
  const estimatedWarp = (angle / 360) * rotationPeriod * 0.8;  // 80% of estimated time

  if (estimatedWarp > 60) {
    logger.info(`[Ascent] ${bodyName} is ${angle.toFixed(1)}° from overhead - warping ~${formatTime(estimatedWarp)}...`);
    await warpForward(conn, estimatedWarp, 300_000, logger);
  }

  // Fine-tune: poll and warp in smaller increments until overhead
  for (let i = 0; i < 10; i++) {
    angle = await getAngle();
    if (angle <= OVERHEAD_THRESHOLD) {
      logger.info(`[Ascent] ${bodyName} is now overhead (${angle.toFixed(1)}° from zenith)`);
      return;
    }

    // Warp smaller increments
    const smallWarp = Math.min((angle / 360) * rotationPeriod * 0.5, 300);
    if (smallWarp > 10) {
      await warpForward(conn, smallWarp, 60_000, logger);
    } else {
      await delay(5000);  // Just wait real-time for small angles
    }
  }

  // Good enough
  logger.info(`[Ascent] ${bodyName} is approximately overhead (${angle.toFixed(1)}° from zenith)`);
}

/**
 * Detect kOS errors in output
 * Checks for common error patterns like "not found", "GET Suffix", exceptions, etc.
 */
function hasKosError(output: string): boolean {
  const lc = output.toLowerCase();
  return lc.includes('not found') || lc.includes('get suffix') ||
         lc.includes('at interpreter') || lc.includes('error') ||
         lc.includes('object reference') || lc.includes('null reference') ||
         lc.includes('value cannot be null');
}

/**
 * Handle for monitoring an in-progress ascent
 */
export class AscentHandle {
  private logger: McpLogger;

  constructor(
    private conn: KosConnection,
    public readonly id: string,
    public readonly targetAltitude: number,
    logger?: McpLogger
  ) {
    this.logger = logger ?? nullLogger;
  }

  /**
   * Get current progress of the ascent
   * Optimized: single atomic query instead of 5 sequential commands
   * Uses MechJeb STATUS for accurate phase detection and dynamic atmosphere height
   */
  async getProgress(): Promise<AscentProgress> {
    // Single atomic query for all progress values including MechJeb status and atmosphere height
    const result = await this.conn.execute(
      'PRINT "PROG|" + ALTITUDE + "|" + APOAPSIS + "|" + PERIAPSIS + "|" + ' +
      'ADDONS:MJ:ASCENT:ENABLED + "|" + ADDONS:MJ:ASCENT:STATUS + "|" + ' +
      'ROUND(SHIP:BODY:ATM:HEIGHT).',
      3000
    );

    // Parse "PROG|alt|apo|per|enabled|mjStatus|atmHeight" format
    const match = result.output.match(/PROG\|([\d.]+)\|([\d.-]+)\|([\d.-]+)\|(True|False)\|([^|]*)\|(\d+)/i);

    const altitude = match ? Number.parseFloat(match[1]) : 0;
    const apoapsis = match ? Number.parseFloat(match[2]) : 0;
    const periapsis = match ? Number.parseFloat(match[3]) : 0;
    const enabled = match ? match[4].toLowerCase() === 'true' : false;
    const mjStatus = match ? match[5].trim() : '';
    const atmHeight = match ? Number.parseInt(match[6]) : 70_000;

    // Determine phase using MechJeb status strings
    let phase: AscentProgress['phase'];
    const statusLower = mjStatus.toLowerCase();

    if (statusLower.includes('prelaunch') || statusLower.includes('landed') || (!enabled && mjStatus === '')) {
      phase = 'prelaunch';
    } else if (periapsis >= atmHeight) {
      phase = 'complete';
    } else if (statusLower.includes('circulariz')) {
      phase = 'circularizing';
    } else if (statusLower.includes('coasting')) {
      phase = 'coasting';
    } else if (statusLower.includes('gravity turn') || statusLower.includes('turn')) {
      phase = 'gravity_turn';
    } else if (altitude > 100) {
      phase = 'launching';
    } else {
      phase = 'prelaunch';
    }

    return {
      phase,
      altitude,
      apoapsis,
      periapsis,
      enabled,
      shipStatus: mjStatus || 'Unknown'
    };
  }

  /**
   * Wait for the ascent to complete using TypeScript polling
   * More reliable than blocking kOS UNTIL loop - handles connection recovery
   */
  async waitForCompletion(pollIntervalMs = 5000): Promise<AscentResult> {
    const MAX_WAIT_MS = 900_000; // 15 minutes max
    this.logger.info(`[Ascent] Target: ${Math.round(this.targetAltitude/1000)}km orbit`);

    // Query atmosphere height once (0 for bodies without atmosphere)
    const atmResult = await this.conn.execute(
      'IF SHIP:BODY:ATM:EXISTS { PRINT ROUND(SHIP:BODY:ATM:HEIGHT). } ELSE { PRINT 0. }',
      3000
    );
    const atmMatch = atmResult.output.match(/(\d+)/);
    const atmHeight = atmMatch ? Number.parseInt(atmMatch[1]) : 0;

    let lastLogTime = 0;
    let lastStatus = '';
    let hasWarpedToCirc = false;

    interface AscentPollState {
      enabled: boolean;
      status: string;
      apoapsis: number;
      periapsis: number;
      body: string;
      eccentricity: number;
      // Computed orbit quality tiers
      survivable: boolean;  // periapsis >= atmHeight
      successful: boolean;  // periapsis >= 95% target
      goodOrbit: boolean;   // successful AND ecc < 0.01
    }

    const result = await pollWithBlackoutResilience<AscentPollState>({
      poll: async () => {
        // Use pipe delimiters for robust parsing (status may contain spaces/colons)
        // Include eccentricity for orbit quality assessment
        const statusResult = await this.conn.execute(
          'SET _ASC TO ADDONS:MJ:ASCENT. ' +
          'SET _E TO _ASC:ENABLED. ' +
          'SET _S TO _ASC:STATUS. ' +
          'SET _A TO ROUND(APOAPSIS). ' +
          'SET _P TO ROUND(PERIAPSIS). ' +
          'SET _B TO SHIP:BODY:NAME. ' +
          'SET _EC TO ROUND(ORBIT:ECCENTRICITY, 4). ' +
          'PRINT _E + "|" + _S + "|" + _A + "|" + _P + "|" + _B + "|" + _EC.'
        );

        const statusMatch = statusResult.output.match(/(True|False)\|([^|]*)\|(-?\d+)\|(-?\d+)\|(\w+)\|([\d.]+)/i);
        if (!statusMatch) {
          throw new Error('Failed to parse ascent status');
        }

        const enabled = statusMatch[1].toLowerCase() === 'true';
        const status = statusMatch[2].trim();
        const apoapsis = Number.parseInt(statusMatch[3]);
        const periapsis = Number.parseInt(statusMatch[4]);
        const body = statusMatch[5];
        const eccentricity = Number.parseFloat(statusMatch[6]);

        // Orbit quality tiers
        const survivable = periapsis >= atmHeight;  // Above atmosphere
        const successful = periapsis >= this.targetAltitude * 0.95;  // Within 95% of target
        const goodOrbit = successful && eccentricity < 0.01;  // Successful AND nearly circular

        return { enabled, status, apoapsis, periapsis, body, eccentricity, survivable, successful, goodOrbit };
      },

      isDone: (state) => !state.enabled,  // Done when MechJeb ascent stops
      isSuccess: (state) => state.survivable,  // Success if we're above atmosphere (can fix the rest)

      timeoutMs: MAX_WAIT_MS,
      pollIntervalMs,
      logger: this.logger,
      context: 'Ascent',
      connection: this.conn,

      onPoll: async (state) => {
        // Log status changes (skip 'Off' - completion is logged after potential auto-fix)
        const now = Date.now();
        if (!state?.status) {
          this.logger.progress(`[Ascent] no status`);
        } else if (state.status === 'Off') {
          //this.logger.progress(`[Ascent] primary ascent burn complete.`);
        } else if ((state.status).includes('Awaiting liftoff')) {
          this.logger.progress(`[Ascent] LAUNCH!! LAUNCH!!`);
        } else if ((state.status).includes('Vertical ascent')) {
          this.logger.progress(`[Ascent] Roll program at ${state.periapsis} meters`);
        } else if ((state.status).includes('Coasting to circularization burn')) {
          // Warp to circularization burn (only once)
          if (!hasWarpedToCirc && config.warp.onRails) {
            hasWarpedToCirc = true;
            try {
              // Get node ETA and warp to 15s before burn starts
              const etaResult = await this.conn.execute('IF HASNODE { PRINT NEXTNODE:ETA. } ELSE { PRINT 0. }', 3000);
              const nodeEta = Number.parseFloat(etaResult.output.match(/([\d.]+)/)?.[1] ?? '0');
              if (nodeEta > 30) {
                const warpTarget = nodeEta - 15;
                this.logger.progress(`[Ascent] Warping to circularization burn (T-${Math.round(nodeEta)}s)`);
                await this.conn.execute('SET WARP TO 0.', 2000);
                await delay(500);
                await this.conn.execute(`KUNIVERSE:TIMEWARP:WARPTO(TIME:SECONDS + ${warpTarget}).`, 5000);
              } else {
                this.logger.progress(`[Ascent] Coasting to circularization burn`);
              }
            } catch {
              this.logger.progress(`[Ascent] Coasting to circularization burn`);
            }
          }
        } else if (state?.status && state.status !== lastStatus) {
          this.logger.progress(`[Ascent] ${state.status} at ${formatOrbit(state.apoapsis, state.periapsis)}`);
        }
        lastStatus = state?.status;
        lastLogTime = now;

        // Log progress every 20 seconds at least
        if (now - lastLogTime >= 20_000) {
          this.logger.progress(`[Ascent] at ${formatOrbit(state.apoapsis, state.periapsis)}`);
          lastLogTime = now;
        }
      },
    });

    // Handle completion
    if (result.result) {
      let { apoapsis, periapsis, eccentricity, successful, goodOrbit } = result.result;
      const { body, survivable } = result.result;

      if (!result.timedOut) {
        // Clear any leftover maneuver nodes
        try {
          await clearNodes(this.conn);
        } catch {
          // Ignore
        }

        // Check if we need to auto-fix the orbit
        // Survivable but not successful = above atmosphere but below target
        if (survivable && !successful) {
          this.logger.warn(`[Ascent] Orbit below target (${fmtNum(periapsis/1000)}km vs ${fmtNum(this.targetAltitude * 0.95 / 1000)}km) - circularizing...`);

          const orchestrator = new ManeuverOrchestrator(this.conn);
          const fixResult = await orchestrator.changeEccentricity(0, 'X_FROM_NOW', {
            execute: true,
            logger: this.logger,
            callerTool: 'fine_tuninng_ascent',
            xFromNowSeconds: 15,  // Create node 15 seconds from now
          });

          if (fixResult.success) {
            // Re-query orbit state after fix
            const postFix = await this.conn.execute(
              'PRINT ROUND(APOAPSIS) + "|" + ROUND(PERIAPSIS) + "|" + ROUND(ORBIT:ECCENTRICITY, 4).',
              3000
            );
            const postMatch = postFix.output.match(/(-?\d+)\|(-?\d+)\|([\d.]+)/);
            if (postMatch) {
              apoapsis = Number.parseInt(postMatch[1]);
              periapsis = Number.parseInt(postMatch[2]);
              eccentricity = Number.parseFloat(postMatch[3]);
              successful = periapsis >= this.targetAltitude * 0.95;
              goodOrbit = successful && eccentricity < 0.01;
            }
            this.logger.progress(`[Ascent] Orbit corrected to ${formatOrbit(apoapsis, periapsis)}, ecc=${eccentricity.toFixed(4)}`);
          } else {
            this.logger.warn(`[Ascent] Ascent fine tune failed: ${fixResult.error ?? 'unknown'}`);
          }
        }

        // Final status message based on orbit quality
        if (goodOrbit) {
          this.logger.progress(`[Ascent] Complete! Circular orbit at ${formatOrbit(apoapsis, periapsis)} at ${body}`);
        } else if (successful) {
          this.logger.progress(`[Ascent] Complete! ${formatOrbit(apoapsis, periapsis)} at ${body} (ecc=${eccentricity.toFixed(3)})`);
        } else if (survivable) {
          this.logger.progress(`[Ascent] Complete but below target: ${formatOrbit(apoapsis, periapsis)} at ${body}`);
        } else {
          this.logger.error(`[Ascent] FAILED - periapsis below atmosphere: ${formatOrbit(apoapsis, periapsis)}`);
        }

        return {
          success: survivable,  // We succeeded if we're above atmosphere
          finalOrbit: { apoapsis, periapsis },
          aborted: false,  // We never abort - we either succeed or fail
        };
      }
    }

    // Timeout
    this.logger.error(`[Ascent] TIMEOUT after ${MAX_WAIT_MS/1000}s`);
    const finalApoapsis = result.result?.apoapsis ?? 0;
    const finalPeriapsis = result.result?.periapsis ?? 0;
    this.logger.progress(`[Ascent] Final: ${formatOrbit(finalApoapsis, finalPeriapsis)}`);

    return {
      success: false,
      finalOrbit: { apoapsis: finalApoapsis, periapsis: finalPeriapsis },
      aborted: false,
    };
  }
}

/**
 * Ascent Program - controls MechJeb ascent autopilot
 */
export class AscentProgram {
  private handleCounter = 0;
  private logger: McpLogger;

  constructor(private conn: KosConnection, logger?: McpLogger) {
    this.logger = logger ?? nullLogger;
  }

  /**
   * Wait for MechJeb to be fully initialized and ready.
   * Just retry until MechJeb queries work - no arbitrary delays.
   */
  async waitForMechJebReady(): Promise<void> {
    const MAX_ATTEMPTS = 30;  // ~15 seconds max

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      // Use SET then PRINT for reliable output (inline MechJeb addon access can be lost)
      const result = await this.conn.execute('SET _E TO ADDONS:MJ:ASCENT:ENABLED. PRINT _E.');
      if (!hasKosError(result.output) && result.output.trim() !== '') {
        this.logger.info('[Ascent] MechJeb ready');
        return;
      }
      await delay(500);  // Short retry delay
    }

    throw new Error('[Ascent] MechJeb not ready after 15 seconds');
  }

  /**
   * Configure ascent settings
   */
  async configure(settings: Partial<AscentSettings>): Promise<void> {
    const commands: string[] = [];
    const AG = 'ADDONS:MJ:ASCENT';

    if (settings.desiredAltitude !== undefined) {
      commands.push(`SET ${AG}:DESIREDALTITUDE TO ${settings.desiredAltitude}.`);
    }
    if (settings.desiredInclination !== undefined) {
      commands.push(`SET ${AG}:DESIREDINCLINATION TO ${settings.desiredInclination}.`);
    }
    if (settings.autostage !== undefined) {
      commands.push(`SET ${AG}:AUTOSTAGE TO ${settings.autostage ? 'TRUE' : 'FALSE'}.`);
    }
    if (settings.skipCircularization !== undefined) {
      commands.push(`SET ${AG}:SKIPCIRCULARIZATION TO ${settings.skipCircularization ? 'TRUE' : 'FALSE'}.`);
    }
    if (settings.autowarp !== undefined) {
      commands.push(`SET ${AG}:AUTOWARP TO ${settings.autowarp ? 'TRUE' : 'FALSE'}.`);
    }

    // Gravity turn profile
    if (settings.turnStartAltitude !== undefined) {
      commands.push(`SET ${AG}:TURNSTARTALTITUDE TO ${settings.turnStartAltitude}.`);
    }
    if (settings.turnStartVelocity !== undefined) {
      commands.push(`SET ${AG}:TURNSTARTVELOCITY TO ${settings.turnStartVelocity}.`);
    }
    if (settings.turnEndAltitude !== undefined) {
      commands.push(`SET ${AG}:TURNENDALTITUDE TO ${settings.turnEndAltitude}.`);
    }
    if (settings.turnEndAngle !== undefined) {
      commands.push(`SET ${AG}:TURNENDANGLE TO ${settings.turnEndAngle}.`);
    }
    if (settings.turnShapeExponent !== undefined) {
      commands.push(`SET ${AG}:TURNSHAPEEXPONENT TO ${settings.turnShapeExponent}.`);
    }
    if (settings.autoPath !== undefined) {
      commands.push(`SET ${AG}:AUTOPATH TO ${settings.autoPath ? 'TRUE' : 'FALSE'}.`);
    }

    // Limits
    if (settings.limitAoA !== undefined) {
      commands.push(`SET ${AG}:LIMITAOA TO ${settings.limitAoA ? 'TRUE' : 'FALSE'}.`);
    }
    if (settings.maxAoA !== undefined) {
      commands.push(`SET ${AG}:MAXAOA TO ${settings.maxAoA}.`);
    }
    if (settings.limitQEnabled !== undefined) {
      commands.push(`SET ${AG}:LIMITQAENABLED TO ${settings.limitQEnabled ? 'TRUE' : 'FALSE'}.`);
    }
    if (settings.limitQ !== undefined) {
      commands.push(`SET ${AG}:LIMITQA TO ${settings.limitQ}.`);
    }

    // Roll control
    if (settings.forceRoll !== undefined) {
      commands.push(`SET ${AG}:FORCEROLL TO ${settings.forceRoll ? 'TRUE' : 'FALSE'}.`);
    }
    if (settings.verticalRoll !== undefined) {
      commands.push(`SET ${AG}:VERTICALROLL TO ${settings.verticalRoll}.`);
    }
    if (settings.turnRoll !== undefined) {
      commands.push(`SET ${AG}:TURNROLL TO ${settings.turnRoll}.`);
    }

    // Launch mode settings (for Launch to Plane / Launch to Rendezvous)
    if (settings.launchingToPlane !== undefined) {
      commands.push(`SET ${AG}:LAUNCHINGTOPLANE TO ${settings.launchingToPlane ? 'TRUE' : 'FALSE'}.`);
    }
    if (settings.launchingToRendezvous !== undefined) {
      commands.push(`SET ${AG}:LAUNCHINGTORENDEZVOUS TO ${settings.launchingToRendezvous ? 'TRUE' : 'FALSE'}.`);
    }
    if (settings.launchPhaseAngle !== undefined) {
      commands.push(`SET ${AG}:LAUNCHPHASEANGLE TO ${settings.launchPhaseAngle}.`);
    }
    if (settings.launchLANDifference !== undefined) {
      commands.push(`SET ${AG}:LAUNCHLANDIFFERENCE TO ${settings.launchLANDifference}.`);
    }
    if (settings.desiredLan !== undefined) {
      commands.push(`SET ${AG}:DESIREDLAN TO ${settings.desiredLan}.`);
    }
    if (settings.overrideWarpToPlane !== undefined) {
      commands.push(`SET ${AG}:OVERRIDEWARPTOPLANE TO ${settings.overrideWarpToPlane ? 'TRUE' : 'FALSE'}.`);
    }

    // Execute commands one at a time for reliability
    // Batch commands can overwhelm the kOS telnet connection
    for (const cmd of commands) {
      await this.conn.execute(cmd);
      await delay(50);  // Small delay between commands
    }
  }

  /**
   * Get current ascent status
   * Optimized: single atomic query instead of 3 sequential commands
   */
  async getStatus(): Promise<AscentStatus> {
    // Single atomic query for all ascent status values
    const result = await this.conn.execute(
      'PRINT "ASC|" + ADDONS:MJ:ASCENT:ENABLED + "|" + ADDONS:MJ:ASCENT:DESIREDALTITUDE + "|" + ADDONS:MJ:ASCENT:DESIREDINCLINATION.',
      3000
    );

    // Parse "ASC|enabled|altitude|inclination" format
    const match = result.output.match(/ASC\|(True|False)\|([\d.]+)\|([\d.-]+)/i);

    return {
      enabled: match ? match[1].toLowerCase() === 'true' : false,
      ascentType: 'GT',  // Gravity Turn is the default
      settings: {
        desiredAltitude: match ? Number.parseFloat(match[2]) : 0,
        desiredInclination: match ? Number.parseFloat(match[3]) : 0
      }
    };
  }

  /**
   * Enable or disable ascent autopilot
   */
  async setEnabled(enabled: boolean): Promise<void> {
    await this.conn.execute(`SET ADDONS:MJ:ASCENT:ENABLED TO ${enabled ? 'TRUE' : 'FALSE'}.`);
  }

  /**
   * Launch to orbit - high-level task method
   *
   * Configures MechJeb ascent guidance and initiates launch.
   * MechJeb handles throttle, staging, and attitude automatically.
   * Returns a handle for monitoring progress.
   *
   * Launch modes:
   * - 'orbit' (default): Simple launch to target altitude/inclination
   * - 'rendezvous': Launch at optimal phase angle to intercept target
   * - 'plane': Launch into target's orbital plane (auto-calculates inclination)
   */
  async launchToOrbit(options: LaunchOptions): Promise<AscentHandle> {
    const {
      altitude,
      inclination = 0,
      autoStage = true,
      launchMode = 'orbit',
      target,
      // phaseAngle and lanDifference removed - always reset to 0 internally
    } = options;

    // Wait for MechJeb to be ready (critical after save reload)
    await this.waitForMechJebReady();

    // Handle launch modes that require a target
    if (launchMode !== 'orbit') {
      if (!target) {
        throw new Error(`Launch mode '${launchMode}' requires a target. Use launchMode: 'orbit' for basic launches.`);
      }

      // Set the target in KSP
      this.logger.info(`[Ascent] Setting target: ${target}`);
      const targetResult = await this.conn.execute(`SET TARGET TO "${target}".`);
      if (targetResult.output.toLowerCase().includes('error') || targetResult.output.toLowerCase().includes('not found')) {
        throw new Error(`Failed to set target '${target}'. Make sure the vessel/body exists.`);
      }
      await delay(200);

      // Verify target was set
      const verifyTarget = await this.conn.execute('IF HASTARGET { PRINT TARGET:NAME. } ELSE { PRINT "NO_TARGET". }');
      if (verifyTarget.output.includes('NO_TARGET')) {
        throw new Error(`Target '${target}' was not set successfully.`);
      }
      this.logger.info(`[Ascent] Target set: ${verifyTarget.output.trim()}`);
    }

    // Configure ascent - always enable MechJeb autowarp capability
    // Actual physics warp level is controlled by AUTOWARP_PHYSICS_MAX env var
    const ascentSettings: Partial<AscentSettings> = {
      desiredAltitude: altitude,
      desiredInclination: inclination,
      autostage: autoStage,
      skipCircularization: false,  // Let MechJeb handle circularization
      autowarp: config.warp.physicsMax > 0,  // Enable MechJeb autowarp if physics warp is enabled
      overrideWarpToPlane: config.warp.physicsMax <= 0,  // Skip plane warp if autowarp disabled (inverse)
      // Roll control: enable force roll and set angle to match inclination
      forceRoll: inclination !== 0,  // Enable roll control for non-equatorial launches
      verticalRoll: 0,  // Default vertical roll
      turnRoll: inclination,  // Roll angle matches target inclination
      // ALWAYS reset ALL launch mode fields to defaults - MechJeb persists stale values
      launchingToPlane: false,
      launchingToRendezvous: false,
      launchPhaseAngle: 0,
      launchLANDifference: 0,
      desiredLan: 0,
    };

    // Configure launch mode specific settings
    if (launchMode === 'rendezvous') {
      ascentSettings.launchingToRendezvous = true;
      // phaseAngle stays at 0 (reset above)
    } else if (launchMode === 'plane') {
      ascentSettings.launchingToPlane = true;
      // lanDifference stays at 0 (reset above)
      // For plane mode, let MechJeb calculate inclination from target
      delete ascentSettings.desiredInclination;
      // But keep roll settings to match the target inclination
      ascentSettings.forceRoll = true;
      ascentSettings.turnRoll = inclination;
    }

    this.logger.info(`[Ascent] Roll config: forceRoll=${ascentSettings.forceRoll}, turnRoll=${ascentSettings.turnRoll}`);
    await this.configure(ascentSettings);

    // Verify roll settings were applied
    const rollCheck = await this.conn.execute('PRINT "ROLL|" + ADDONS:MJ:ASCENT:FORCEROLL + "|" + ADDONS:MJ:ASCENT:TURNROLL.');
    this.logger.progress(`[Ascent] Roll check: ${rollCheck.output.trim()}`);

    // Let MechJeb process the configuration
    await delay(500);

    // For plane/rendezvous modes, MechJeb handles the countdown and warp to launch window
    // For normal orbit mode, use our staged launch
    if (launchMode === 'plane' || launchMode === 'rendezvous') {
      // Enable autopilot and start countdown - MechJeb will warp to launch window
      this.logger.progress(`[Ascent] Enabling ascent autopilot for ${launchMode} mode...`);
      const enableResult = await this.conn.execute('SET ADDONS:MJ:ASCENT:ENABLED TO TRUE. PRINT ADDONS:MJ:ASCENT:ENABLED.');
      this.logger.info(`[Ascent] Enable result: ${enableResult.output}`);
      await delay(500);

      const countdownResult = await this.conn.execute('PRINT ADDONS:MJ:ASCENT:STARTCOUNTDOWN(TIME:SECONDS + 999999).');
      this.logger.info(`[Ascent] Countdown result: ${countdownResult.output}`);
      await delay(1000);

      // Wait for MechJeb to warp to window and launch
      let launched = false;
      let wasWarping = false;
      for (let i = 0; i < 600; i++) {
        const statusResult = await this.conn.execute('PRINT SHIP:STATUS + "|" + WARP.');
        const parts = statusResult.output.split('|');
        const status = parts[0]?.toLowerCase() ?? '';
        const warpLevel = parseInt(parts[1]?.trim() ?? '0');

        if (status.includes('flying') || status.includes('orbiting') || status.includes('sub_orbital')) {
          launched = true;
          break;
        }

        // Track warp state and stage when warp completes (if MechJeb doesn't)
        if (warpLevel > 0 && !wasWarping) {
          this.logger.progress('[Ascent] Warping to launch window...');
          wasWarping = true;
        } else if (warpLevel === 0 && wasWarping) {
          wasWarping = false;
          // Give MechJeb a few seconds to launch on its own
          await delay(3000);
          const checkStatus = await this.conn.execute('PRINT SHIP:STATUS.');
          if (checkStatus.output.toLowerCase().includes('prelaunch')) {
            // Still on pad - stage manually
            await this.conn.execute('STAGE.');
            await delay(500);
          }
        }

        await delay(1000);
      }

      if (!launched) {
        throw new Error('MechJeb did not launch within timeout - check launch window');
      }
    } else {
      // Normal orbit mode - enable autopilot and stage manually
      let autopilotEngaged = false;
      for (let attempt = 1; attempt <= 10; attempt++) {
        await this.conn.execute('SET ADDONS:MJ:ASCENT:ENABLED TO TRUE.');
        await delay(500);

        for (let verifyAttempt = 1; verifyAttempt <= 3; verifyAttempt++) {
          const verifyResult = await this.conn.execute('SET _E TO ADDONS:MJ:ASCENT:ENABLED. PRINT _E.');
          if (verifyResult.output.toLowerCase().includes('true')) {
            autopilotEngaged = true;
            this.logger.progress('[Ascent] Autopilot engaged');
            break;
          }
          if (verifyResult.output.toLowerCase().includes('false')) {
            break;
          }
          await delay(200);
        }

        if (autopilotEngaged) break;
        this.logger.progress(`[Ascent] Autopilot not engaged yet (attempt ${attempt}/10)`);
        await delay(300);
      }

      if (!autopilotEngaged) {
        this.logger.warn('[Ascent] Autopilot may not have engaged after 10 attempts, proceeding anyway');
      }

      // Release controls
      await this.conn.execute('UNLOCK THROTTLE.');
      await delay(100);
      await this.conn.execute('SAS OFF.');
      await delay(100);

      // Check if we need to stage
      const statusResult = await this.conn.execute('PRINT SHIP:STATUS.');
      const shipStatus = statusResult.output.toLowerCase();

      if (shipStatus.includes('prelaunch')) {
        await this.conn.execute('STAGE.');
        await delay(500);
        this.logger.progress('[Ascent] STAGED TO LAUNCH');
      } else {
        this.logger.progress('[Ascent] LAUNCH');
      }
    }

    // Enable physics warp after 20 seconds if configured via env var
    // This replaces the old autoWarp parameter with global env var control
    if (config.warp.physicsMax > 0) {
      void setTimeout(() => {
        this.conn.execute(`SET WARPMODE TO "PHYSICS". SET WARP TO 0. WAIT 0.3. SET WARP TO ${config.warp.physicsMax}.`)
          .catch(() => { /* Ignore warp errors during ascent */ });
      }, 20_000);
    }

    // Create handle for monitoring (pass logger for waitForCompletion)
    const handleId = `ascent-${++this.handleCounter}-${Date.now()}`;
    return new AscentHandle(this.conn, handleId, altitude, this.logger);
  }
}

// ============================================================================
// Tool Definition
// ============================================================================

import { z } from 'zod';
import type { ToolDefinition } from '../tool-types.js';
import { distanceSchema } from '../tool-types.js';
import { validateVesselState, LAUNCH_REQUIREMENTS } from '../kos/vessel/validate.js';
import { setKosOperation, clearKosOperation } from '../../utils/kos-operation-state.js';

/**
 * Get default launch altitude based on current body:
 * - With atmosphere: atmHeight * 1.5 (safe margin above atmosphere)
 * - Without atmosphere: 50km
 */
async function getDefaultLaunchAltitude(conn: KosConnection): Promise<number> {
  const NO_ATM_DEFAULT = 50_000; // 50km for bodies without atmosphere
  try {
    const result = await conn.execute(
      'IF SHIP:BODY:ATM:EXISTS { PRINT SHIP:BODY:ATM:HEIGHT. } ELSE { PRINT 0. }',
      3000
    );
    const match = result.output.match(/([\d.]+)/);
    if (match) {
      const atmHeight = parseFloat(match[1]);
      return atmHeight > 0 ? Math.round(atmHeight * 1.5) : NO_ATM_DEFAULT;
    }
  } catch {
    // Ignore errors
  }
  return NO_ATM_DEFAULT;
}

/**
 * Launch ascent tool definition
 */
export const launchAscentTool: ToolDefinition = {
  name: 'launch',
  description: 'Launch from pad or ground to orbit. With a target, automatically selects optimal launch mode (rendezvous for vessels, plane-matching for moons, transfer window for planets).',
  inputSchema: {
    altitude: z.union([distanceSchema, z.literal('auto')]).optional().default('auto')
      .describe('Target orbit altitude in meters. Default: safe altitude above atmosphere.'),
    inclination: z.number().optional().default(0)
      .describe('Target inclination in degrees (0=equatorial). Overridden when launching to target.'),
    target: z.string().optional()
      .describe('Target name. Auto-selects launch mode and timing based on target type.'),
    wait: z.union([z.boolean(), z.literal('auto')]).optional().default('auto')
      .describe('Wait for orbit and stream progress updates.'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 1,
  handler: async (args, ctx, extra) => {
    const conn = await ctx.ensureConnected();
    const logger = ctx.createLogger(extra);

    // Validate vessel state: must be landed or prelaunch
    const validation = await validateVesselState(conn, LAUNCH_REQUIREMENTS, 'launch');
    if (!validation.valid) {
      return ctx.errorResponse('launch', validation.error ?? 'Invalid vessel state');
    }

    // Smart parameter resolution: if target is provided or already exists, auto-select launch params
    let smartParams: SmartLaunchParams | null = null;
    const targetArg = args.target as string | undefined;

    if (targetArg || await hasTarget(conn)) {
      smartParams = await resolveSmartLaunchParams(conn, targetArg, logger);

      // Check for errors (e.g., trying to do interplanetary from a moon)
      if (smartParams.error) {
        return ctx.errorResponse('launch', smartParams.error);
      }

      // Log the chosen strategy
      if (smartParams.strategyMessage) {
        logger.progress(`[Ascent] ${smartParams.strategyMessage}`);
      }

      // Handle pre-launch actions (must succeed before launch)
      if (smartParams.prelaunchAction === 'warp_to_overhead' && smartParams.target) {
        await warpUntilBodyOverhead(conn, smartParams.target, logger);
      } else if (smartParams.prelaunchAction === 'warp_to_transfer_window') {
        const warpError = await warpToTransferWindow(conn, logger);
        if (warpError) {
          return ctx.errorResponse('launch', `Cannot launch to ${smartParams.target}: ${warpError}`);
        }
      }
    }

    // Determine final launch parameters (smart params override args when available)
    const altArg = args.altitude as number | 'auto';
    const defaultAltitude = altArg === 'auto' ? await getDefaultLaunchAltitude(conn) : altArg;

    // Use smart params if resolved, otherwise use args (nullish coalescing)
    const altitude = smartParams?.altitude ?? defaultAltitude;
    const inclination = smartParams?.inclination ?? (args.inclination as number);
    const launchMode = smartParams?.launchMode ?? 'orbit';
    const target = smartParams?.target ?? targetArg;

    // Set operation state in kOS (persists across restarts, auto-cleared by safety monitor on completion)
    await setKosOperation(conn, 'ascent', 'launch', String(altitude));

    try {
      const program = new AscentProgram(conn, logger);
      const handle = await program.launchToOrbit({
        altitude,
        inclination,
        autoStage: true,
        launchMode,
        target,
      });

      // Resolve 'auto' to client-appropriate default
      const waitArg = args.wait as boolean | 'auto';
      const wait = waitArg === 'auto' ? ctx.supportsNotifications(extra) : waitArg;

      if (wait) {
        // Wait for completion (blocking call that monitors ascent)
        try {
          const result = await handle.waitForCompletion();

          if (result.success) {
            const orbit = result.finalOrbit;
            // Query orbit details for comprehensive status
            const orbitQuery = await conn.execute(
              'PRINT SHIP:BODY:NAME + "|" + ROUND(ORBIT:ECCENTRICITY, 4) + "|" + ROUND(ORBIT:INCLINATION, 1) + "|" + ROUND(ORBIT:PERIOD).',
              3000
            );
            const match = orbitQuery.output.match(/([^|]+)\|([\d.]+)\|([\d.]+)\|([\d.]+)/);
            const bodyName = match?.[1]?.trim() ?? 'Unknown';
            const ecc = Number.parseFloat(match?.[2] ?? '0');
            const inc = Number.parseFloat(match?.[3] ?? '0');
            const period = Number.parseFloat(match?.[4] ?? '0');

            // Build comprehensive completion message
            const lines: string[] = [
              `Launch complete - in stable ${bodyName} orbit`,
              `Orbit: ${formatOrbit(orbit.apoapsis, orbit.periapsis)}`,
              `Inclination: ${inc.toFixed(1)}° | Eccentricity: ${ecc.toFixed(4)} | Period: ${formatTime(period)}`,
            ];

            // Add target-specific completion info
            if (target && (launchMode === 'plane' || launchMode === 'rendezvous')) {
              try {
                if (launchMode === 'plane') {
                  // Check inclination match with target
                  const tgtQuery = await conn.execute(
                    'IF HASTARGET { SET TGT TO ADDONS:MJ:TARGET. PRINT "TGT|" + TARGET:NAME + "|" + TGT:TARGETINCLINATION. } ELSE { PRINT "NOTGT". }',
                    3000
                  );
                  const tgtMatch = tgtQuery.output.match(/TGT\|([^|]+)\|([\d.]+)/);
                  if (tgtMatch) {
                    const tgtName = tgtMatch[1];
                    const tgtInc = Number.parseFloat(tgtMatch[2]);
                    const incOffset = Math.abs(inc - tgtInc);
                    if (incOffset < 0.5) {
                      lines.push(`Plane match with ${tgtName}: excellent (${incOffset.toFixed(2)}° offset)`);
                    } else if (incOffset < 2) {
                      lines.push(`Plane match with ${tgtName}: good (${incOffset.toFixed(1)}° offset)`);
                    } else {
                      lines.push(`Plane match with ${tgtName}: ${incOffset.toFixed(1)}° offset - may need adjustment`);
                    }
                  }
                } else if (launchMode === 'rendezvous') {
                  // Check distance and closest approach to target vessel
                  const rdzQuery = await conn.execute(
                    'IF HASTARGET { PRINT "RDZ|" + TARGET:NAME + "|" + ROUND(TARGET:DISTANCE) + "|" + ROUND(ADDONS:MJ:TARGET:CLOSESTAPPROACHDISTANCE). } ELSE { PRINT "NOTGT". }',
                    3000
                  );
                  const rdzMatch = rdzQuery.output.match(/RDZ\|([^|]+)\|([\d.]+)\|([\d.]+)/);
                  if (rdzMatch) {
                    const tgtName = rdzMatch[1];
                    const distance = Number.parseFloat(rdzMatch[2]);
                    const closestApproach = Number.parseFloat(rdzMatch[3]);
                    const distStr = distance > 1_000_000 ? `${(distance/1_000_000).toFixed(1)}Mm` :
                                   (distance > 1000 ? `${(distance/1000).toFixed(0)}km` : `${distance.toFixed(0)}m`);
                    const caStr = closestApproach > 1_000_000 ? `${(closestApproach/1_000_000).toFixed(1)}Mm` :
                                 (closestApproach > 1000 ? `${(closestApproach/1000).toFixed(0)}km` : `${closestApproach.toFixed(0)}m`);
                    lines.push(`Rendezvous with ${tgtName}: ${distStr} away, closest approach ${caStr}`);
                  }
                }
              } catch { /* ignore target query errors */ }
              lines.push(`Next: Use transfer tool to intercept ${target}.`);
            } else if (target) {
              lines.push(`Next: Use transfer tool to go to ${target}.`);
            } else {
              // Add guidance based on orbit quality
              if (ecc < 0.01) {
                lines.push('Orbit is nearly circular - ready for maneuvers.');
              } else if (ecc < 0.05) {
                lines.push('Orbit is circular and stable.');
              } else {
                lines.push(`Orbit is elliptical (ecc=${ecc.toFixed(3)}) - consider circularizing if needed.`);
              }
              lines.push('Next: Use transfer tool to go to a moon or planet, or status to see available targets.');
            }

            return ctx.successResponse('launch', lines.join('\n'));
          } else {
            return ctx.errorResponse('launch', 'Ascent failed - periapsis below atmosphere');
          }
        } finally {
          // Clear operation state when waiting for completion
          await clearKosOperation(conn);
          clearBroadcastLogger();
        }
      } else {
        // Return immediately - operation continues in background
        // Safety monitor in kOS will auto-clear _MCP_OP when orbit is achieved
        let launchMsg = `Launch started! Target: ${(altitude / 1000).toFixed(0)} km orbit.`;
        if (smartParams?.strategyMessage) {
          launchMsg = `${smartParams.strategyMessage}\nLaunch started! Target: ${(altitude / 1000).toFixed(0)} km orbit at ${inclination.toFixed(1)}° inclination.`;
        } else if (launchMode === 'rendezvous') {
          launchMsg = `Launch to Rendezvous started! Target: ${target}, ${(altitude / 1000).toFixed(0)} km orbit`;
        } else if (launchMode === 'plane') {
          launchMsg = `Launch to Plane started! Target: ${target}'s orbital plane, ${(altitude / 1000).toFixed(0)} km orbit`;
        }
        return ctx.successResponse('launch',
          `${launchMsg}\nPoll status for progress. MechJeb is flying.`);
      }
    } catch (error) {
      // Clear operation state on error
      try {
        await clearKosOperation(conn);
      } catch { /* ignore cleanup errors */ }
      clearBroadcastLogger();
      return ctx.errorResponse('launch', error instanceof Error ? error.message : String(error));
    }
  },
};
