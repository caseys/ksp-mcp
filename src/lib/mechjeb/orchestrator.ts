/**
 * Maneuver Orchestrator
 *
 * Shared helper for executing maneuvers with optional target setting and node execution.
 * Used by MCP server, CLI scripts, and tests to get consistent behavior.
 */

import type { KosConnection } from '../../transport/kos-connection.js';
import type { ManeuverResult } from './shared.js';
import { executeNode } from './execute-node.js';
// Target operations
import {
  setTarget,
  clearTarget,
  getTargetInfo,
  listTargets,
  hasTarget,
  getSOIBody,
  type SetTargetResult,
  type GetTargetInfo,
  type ClearTargetResult,
  type ListTargetsResult,
} from '../kos/target/index.js';
// Basic operations
import { circularize } from './basic/circularize.js';
import { adjustPeriapsis } from './basic/adjust-periapsis.js';
import { adjustApoapsis } from './basic/adjust-apoapsis.js';
import { ellipticize } from './basic/ellipticize.js';
import { changeSemiMajorAxis } from './basic/semimajor.js';
// Orbital operations
import { changeInclination } from './orbital/inclination.js';
import { changeLAN } from './orbital/lan.js';
import { changeLongitudeOfPeriapsis } from './orbital/longitude.js';
import { changeEccentricity } from './orbital/eccentricity.js';
// Rendezvous operations
import { matchPlane } from './rendezvous/match-plane.js';
import { killRelativeVelocity } from './rendezvous/kill-rel-vel.js';
// Transfer operations
import { hohmannTransfer } from './transfer/hohmann.js';
import { courseCorrection } from './transfer/course-correct.js';
import { resonantOrbit } from './transfer/resonant-orbit.js';
import { returnFromMoon } from './transfer/return-from-moon.js';
import { interplanetaryTransfer } from './transfer/interplanetary.js';
import type { McpLogger } from '../tool-types.js';

/**
 * Options for maneuver orchestration.
 */
export interface ManeuverOptions {
  /** Target name (body or vessel) to set before planning. If omitted, uses current target. */
  target?: string;
  /** Target type: 'auto' tries body then vessel, 'body' for celestial bodies, 'vessel' for ships. Defaults to 'auto'. */
  targetType?: 'auto' | 'body' | 'vessel';
  /** Whether to execute the node after planning. Defaults to true. */
  execute?: boolean;
  /** Structured logger for MCP notifications. */
  logger?: McpLogger;
  /** Name of the calling tool (for execution logging context). */
  callerTool?: string;
}

/**
 * Extended result that includes execution status.
 */
export interface OrchestratedResult extends ManeuverResult {
  /** Whether node execution was attempted */
  executed?: boolean;
  /** Number of nodes executed (if executed) */
  nodesExecuted?: number;
}

/**
 * Helper to handle optional target setting and node execution for maneuver operations.
 *
 * @param conn - kOS connection
 * @param target - Optional target name to set before planning
 * @param targetType - How to interpret target: 'auto' (try body then vessel), 'body', or 'vessel'
 * @param execute - Whether to execute the node after planning (default: true)
 * @param planFn - The function that creates the maneuver node
 * @param logger - Optional MCP logger
 * @param callerTool - Optional name of calling tool for logging context
 * @returns Combined result from planning and optional execution
 */
export async function withTargetAndExecute(
  conn: KosConnection,
  target: string | undefined,
  targetType: 'auto' | 'body' | 'vessel',
  execute: boolean,
  planFn: () => Promise<ManeuverResult>,
  logger?: McpLogger,
  callerTool?: string
): Promise<OrchestratedResult> {

  // Handle target setting if provided
  if (target !== undefined) {
    const targetResult = await setTarget(conn, target, targetType);
    if (!targetResult.success) {
      return {
        success: false,
        error: targetResult.error ?? `Failed to set target "${target}"`,
      };
    }
  }

  // Execute the planning function
  const planResult = await planFn();
  if (!planResult.success) {
    return planResult;
  }

  // Return early if not executing
  if (!execute) {
    return { ...planResult, executed: false };
  }

  // Execute the node
  const execResult = await executeNode(conn, { logger, callerTool });

  if (!execResult.success) {
    return {
      ...planResult,
      success: false,
      error: execResult.error ?? 'Node execution failed',
      executed: false,
    };
  }

  return {
    ...planResult,
    executed: true,
    nodesExecuted: execResult.nodesExecuted,
  };
}

/** Close approach check result */
interface CloseApproachResult {
  hasEncounter: boolean;
  encounterBody?: string;
  encounterPeriapsis?: number;  // Periapsis at encounter body (negative = below surface)
  isCloseApproach: boolean;
  separation: number;
  targetOrbitRadius: number;
}

/**
 * Check post-burn trajectory for encounter or close approach.
 * Used after Hohmann transfer execution to verify we're still on target.
 *
 * A "close approach" is defined as predicted separation < 33% of target's average orbit radius.
 */
async function checkPostBurnTrajectory(
  conn: KosConnection,
  targetName: string,
  logger?: McpLogger
): Promise<CloseApproachResult> {
  const CLOSE_APPROACH_THRESHOLD = 0.33; // 33% of target's orbit radius

  try {
    // First check if we have an encounter
    const encounterCheck = await conn.execute(
      'IF SHIP:ORBIT:HASNEXTPATCH { PRINT SHIP:ORBIT:NEXTPATCH:BODY:NAME. } ELSE { PRINT "NO_ENCOUNTER". }',
      3000
    );
    const encounterBody = encounterCheck.output.trim();

    if (encounterBody !== 'NO_ENCOUNTER') {
      // We have an encounter - check if it's with the correct target
      const isCorrectTarget = encounterBody.toLowerCase() === targetName.toLowerCase();

      // Query the encounter periapsis to check for crash trajectory
      let encounterPeriapsis: number | undefined;
      try {
        const peCheck = await conn.execute(
          'PRINT SHIP:ORBIT:NEXTPATCH:PERIAPSIS.',
          3000
        );
        encounterPeriapsis = parseFloat(peCheck.output.trim());
        if (isNaN(encounterPeriapsis)) {
          encounterPeriapsis = undefined;
        }
      } catch {
        // Periapsis query failed - continue without it
        logger?.error('[checkPostBurnTrajectory] Failed to query encounter periapsis');
      }

      return {
        hasEncounter: true,
        encounterBody,
        encounterPeriapsis,
        isCloseApproach: isCorrectTarget, // If correct target, we're good
        separation: 0,
        targetOrbitRadius: 0,
      };
    }

    // No encounter - check for close approach using current orbit
    const checkScript = `
      SET futureOrbit TO SHIP:ORBIT.
      SET timeAtAp TO TIME:SECONDS + futureOrbit:ETA:APOAPSIS.
      SET futurePosShip TO POSITIONAT(SHIP, timeAtAp).
      SET futurePosTgt TO POSITIONAT(TARGET, timeAtAp).
      SET predictedDist TO (futurePosShip - futurePosTgt):MAG.
      SET targetPe TO TARGET:ORBIT:PERIAPSIS.
      SET targetAp TO TARGET:ORBIT:APOAPSIS.
      PRINT "DIST:" + ROUND(predictedDist) + "|PE:" + ROUND(targetPe) + "|AP:" + ROUND(targetAp).
    `.trim().replaceAll('\n', ' ');

    const result = await conn.execute(checkScript, 5000);

    // Parse output: "DIST:12345|PE:67890|AP:111213"
    const distMatch = result.output.match(/DIST:(-?\d+)/);
    const peMatch = result.output.match(/PE:(-?\d+)/);
    const apMatch = result.output.match(/AP:(-?\d+)/);

    if (!distMatch || !peMatch || !apMatch) {
      logger?.warn(`[checkPostBurnTrajectory] Failed to parse kOS output: ${result.output}`);
      return { hasEncounter: false, isCloseApproach: false, separation: 0, targetOrbitRadius: 0 };
    }

    const separation = Math.abs(Number.parseInt(distMatch[1]));
    const targetPe = Number.parseInt(peMatch[1]);
    const targetAp = Number.parseInt(apMatch[1]);
    const targetOrbitRadius = (targetPe + targetAp) / 2;

    // Check if separation is within threshold
    const threshold = targetOrbitRadius * CLOSE_APPROACH_THRESHOLD;
    const isCloseApproach = separation < threshold;

    logger?.info(`[checkPostBurnTrajectory] Target: ${targetName}, Separation: ${(separation / 1000).toFixed(0)} km, ` +
                 `Orbit radius: ${(targetOrbitRadius / 1000).toFixed(0)} km, ` +
                 `Threshold: ${(threshold / 1000).toFixed(0)} km, Close: ${isCloseApproach}`);

    return { hasEncounter: false, isCloseApproach, separation, targetOrbitRadius };
  } catch (error) {
    logger?.error(`[checkPostBurnTrajectory] Error: ${error}`);
    return { hasEncounter: false, isCloseApproach: false, separation: 0, targetOrbitRadius: 0 };
  }
}

/**
 * Orchestrated maneuver operations.
 *
 * Provides high-level maneuver methods with built-in target setting and execution.
 * This is the recommended API for CLI scripts, tests, and programmatic use.
 */
export class ManeuverOrchestrator {
  constructor(private conn: KosConnection) {}

  /**
   * Circularize orbit at apoapsis or periapsis.
   */
  async circularize(
    timeRef: string = 'APOAPSIS',
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true, logger, callerTool } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      circularize(this.conn, timeRef),
      logger,
      callerTool
    );
  }

  /**
   * Adjust periapsis altitude.
   */
  async adjustPeriapsis(
    altitude: number,
    timeRef: string = 'APOAPSIS',
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true, logger, callerTool } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      adjustPeriapsis(this.conn, altitude, timeRef),
      logger,
      callerTool
    );
  }

  /**
   * Adjust apoapsis altitude.
   */
  async adjustApoapsis(
    altitude: number,
    timeRef: string = 'PERIAPSIS',
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true, logger, callerTool } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      adjustApoapsis(this.conn, altitude, timeRef),
      logger,
      callerTool
    );
  }

  /**
   * Hohmann transfer to target.
   *
   * Planning requires a proper SOI encounter (strict validation).
   * After execution, allows close approach as fallback (< 33% of target orbit radius).
   */
  async hohmannTransfer(
    timeRef: string = 'COMPUTED',
    capture: boolean = false,
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true, logger, callerTool } = options ?? {};

    // Get the target name for post-execution validation
    // We need this before execution since TARGET might change
    let targetName = target;
    if (!targetName) {
      // Query current target name
      const targetResult = await this.conn.execute('PRINT TARGET:NAME.', 2000);
      targetName = targetResult.output.trim();
    }

    // Plan and optionally execute via standard flow
    const result = await withTargetAndExecute(this.conn, target, targetType, execute, () =>
      hohmannTransfer(this.conn, timeRef, capture),
      logger,
      callerTool
    );

    // If planning failed or not executed, return as-is
    if (!result.success || !result.executed) {
      return result;
    }

    // Post-execution validation: check trajectory
    const trajectoryCheck = await checkPostBurnTrajectory(this.conn, targetName, logger);

    if (trajectoryCheck.hasEncounter) {
      // We have an encounter
      if (trajectoryCheck.encounterBody?.toLowerCase() === targetName.toLowerCase()) {
        // Correct target - check for crash trajectory
        if (trajectoryCheck.encounterPeriapsis !== undefined && trajectoryCheck.encounterPeriapsis < 0) {
          // Crash trajectory - suggest appropriate tool based on current SOI
          const currentSOI = await this.getSOIBody();
          const inTargetSOI = currentSOI.toLowerCase() === trajectoryCheck.encounterBody?.toLowerCase();
          const suggestion = inTargetSOI
            ? 'Run crash_avoidance to raise periapsis immediately.'
            : 'Run course_correct to raise periapsis before SOI entry.';

          return {
            ...result,
            warning: `⚠️ Trajectory will impact ${trajectoryCheck.encounterBody}!\n` +
                     `Encounter periapsis: ${(trajectoryCheck.encounterPeriapsis / 1000).toFixed(1)} km (below surface)\n` +
                     suggestion,
          };
        }
        // Success - no crash trajectory
        return result;
      }
      // Wrong encounter target - this shouldn't happen after planning succeeded
      return {
        ...result,
        warning: `⚠️ Post-burn encounter is with ${trajectoryCheck.encounterBody}, not ${targetName}.\n` +
                 'Burn execution may have been imprecise. Consider course correction.',
      };
    }

    // No encounter after execution - check for close approach
    if (trajectoryCheck.isCloseApproach) {
      return {
        ...result,
        warning: `⚠️ Close approach created (no SOI encounter after burn).\n` +
                 `Predicted separation: ${(trajectoryCheck.separation / 1000).toFixed(0)} km\n` +
                 `Target orbit: ${(trajectoryCheck.targetOrbitRadius / 1000).toFixed(0)} km avg radius\n` +
                 `A course_correct burn is recommended.`,
      };
    }

    // No encounter and no close approach - burn failed
    return {
      ...result,
      success: false,
      error: `❌ Burn executed but trajectory does not reach target!\n` +
             `Predicted separation: ${trajectoryCheck.separation > 0 ? (trajectoryCheck.separation / 1000).toFixed(0) + ' km' : 'unknown'}\n` +
             'Burn may have been severely off-target. Manual intervention required.',
    };
  }

  /**
   * Course correction to fine-tune approach.
   */
  async courseCorrection(
    finalPeA: number,
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true, logger, callerTool } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      courseCorrection(this.conn, finalPeA, logger),
      logger,
      callerTool
    );
  }

  /**
   * Change orbital inclination.
   */
  async changeInclination(
    newInclination: number,
    timeRef: string = 'EQ_NEAREST_AD',
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true, logger, callerTool } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      changeInclination(this.conn, newInclination, timeRef),
      logger,
      callerTool
    );
  }

  /**
   * Ellipticize orbit to specified pe/ap.
   */
  async ellipticize(
    peA: number,
    apA: number,
    timeRef: string = 'APOAPSIS',
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true, logger, callerTool } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      ellipticize(this.conn, peA, apA, timeRef),
      logger,
      callerTool
    );
  }

  /**
   * Change longitude of ascending node.
   */
  async changeLAN(
    newLAN: number,
    timeRef: string = 'APOAPSIS',
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true, logger, callerTool } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      changeLAN(this.conn, newLAN, timeRef),
      logger,
      callerTool
    );
  }

  /**
   * Change longitude of periapsis.
   */
  async changeLongitude(
    newLong: number,
    timeRef: string = 'APOAPSIS',
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true, logger, callerTool } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      changeLongitudeOfPeriapsis(this.conn, newLong, timeRef),
      logger,
      callerTool
    );
  }

  /**
   * Create resonant orbit for constellation deployment.
   */
  async resonantOrbit(
    numerator: number,
    denominator: number,
    timeRef: string = 'APOAPSIS',
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true, logger, callerTool } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      resonantOrbit(this.conn, numerator, denominator, timeRef),
      logger,
      callerTool
    );
  }

  /**
   * Kill relative velocity with target.
   */
  async killRelVel(
    timeRef: string = 'CLOSEST_APPROACH',
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true, logger, callerTool } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      killRelativeVelocity(this.conn, timeRef),
      logger,
      callerTool
    );
  }

  /**
   * Change semi-major axis.
   */
  async changeSemiMajorAxis(
    semiMajorAxis: number,
    timeRef: string = 'APOAPSIS',
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true, logger, callerTool } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      changeSemiMajorAxis(this.conn, semiMajorAxis, timeRef),
      logger,
      callerTool
    );
  }

  /**
   * Change orbital eccentricity.
   */
  async changeEccentricity(
    eccentricity: number,
    timeRef: string = 'APOAPSIS',
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true, logger, callerTool } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      changeEccentricity(this.conn, eccentricity, timeRef),
      logger,
      callerTool
    );
  }

  /**
   * Match orbital plane with target.
   */
  async matchPlane(
    timeRef: string = 'REL_NEAREST_AD',
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true, logger, callerTool } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      matchPlane(this.conn, timeRef),
      logger,
      callerTool
    );
  }

  /**
   * Return from moon to parent body.
   */
  async returnFromMoon(
    targetPeriapsis: number,
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true, logger, callerTool } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      returnFromMoon(this.conn, targetPeriapsis),
      logger,
      callerTool
    );
  }

  /**
   * Interplanetary transfer to target planet.
   *
   * Planning requires a proper SOI encounter (strict validation).
   * After execution, allows close approach as fallback (< 33% of target orbit radius).
   */
  async interplanetaryTransfer(
    waitForPhaseAngle: boolean = true,
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true, logger, callerTool } = options ?? {};

    // Get the target name for post-execution validation
    let targetName = target;
    if (!targetName) {
      const targetResult = await this.conn.execute('PRINT TARGET:NAME.', 2000);
      targetName = targetResult.output.trim();
    }

    // Plan and optionally execute via standard flow
    const result = await withTargetAndExecute(this.conn, target, targetType, execute, () =>
      interplanetaryTransfer(this.conn, { waitForPhaseAngle, logger }),
      logger,
      callerTool
    );

    // If planning failed or not executed, return as-is
    if (!result.success || !result.executed) {
      return result;
    }

    // Post-execution validation: check trajectory (same as Hohmann)
    const trajectoryCheck = await checkPostBurnTrajectory(this.conn, targetName, logger);

    if (trajectoryCheck.hasEncounter) {
      if (trajectoryCheck.encounterBody?.toLowerCase() === targetName.toLowerCase()) {
        // Correct target - check for crash trajectory
        if (trajectoryCheck.encounterPeriapsis !== undefined && trajectoryCheck.encounterPeriapsis < 0) {
          // Crash trajectory - suggest appropriate tool based on current SOI
          const currentSOI = await this.getSOIBody();
          const inTargetSOI = currentSOI.toLowerCase() === trajectoryCheck.encounterBody?.toLowerCase();
          const suggestion = inTargetSOI
            ? 'Run crash_avoidance to raise periapsis immediately.'
            : 'Run course_correct to raise periapsis before SOI entry.';

          return {
            ...result,
            warning: `⚠️ Trajectory will impact ${trajectoryCheck.encounterBody}!\n` +
                     `Encounter periapsis: ${(trajectoryCheck.encounterPeriapsis / 1000).toFixed(1)} km (below surface)\n` +
                     suggestion,
          };
        }
        // Success - no crash trajectory
        return result;
      }
      return {
        ...result,
        error: `⚠️ Post-burn encounter is with ${trajectoryCheck.encounterBody}, not ${targetName}.\n` +
               'Burn execution may have been imprecise. Consider course correction.',
      };
    }

    // No encounter after execution - check for close approach
    if (trajectoryCheck.isCloseApproach) {
      return {
        ...result,
        warning: `⚠️ Close approach created (no SOI encounter after burn).\n` +
                 `Predicted separation: ${(trajectoryCheck.separation / 1000).toFixed(0)} km\n` +
                 `Target orbit: ${(trajectoryCheck.targetOrbitRadius / 1000).toFixed(0)} km avg radius\n` +
                 `A course_correct burn is recommended.`,
      };
    }

    // No encounter and no close approach - burn failed
    return {
      ...result,
      success: false,
      error: `❌ Burn executed but trajectory does not reach target!\n` +
             `Predicted separation: ${trajectoryCheck.separation > 0 ? (trajectoryCheck.separation / 1000).toFixed(0) + ' km' : 'unknown'}\n` +
             'Burn may have been severely off-target. Manual intervention required.',
    };
  }

  /**
   * Set navigation target.
   */
  async setTarget(name: string, type: 'auto' | 'body' | 'vessel' = 'auto'): Promise<SetTargetResult> {
    return setTarget(this.conn, name, type);
  }

  /**
   * Clear navigation target.
   */
  async clearTarget(): Promise<ClearTargetResult> {
    return clearTarget(this.conn);
  }

  /**
   * Get target info.
   */
  async getTargetInfo(): Promise<GetTargetInfo> {
    return getTargetInfo(this.conn);
  }

  /**
   * List all targetable bodies and vessels sorted by distance.
   */
  async listTargets(): Promise<ListTargetsResult> {
    return listTargets(this.conn);
  }

  /**
   * Check if target is set.
   */
  async hasTarget(): Promise<boolean> {
    return hasTarget(this.conn);
  }

  /**
   * Get the name of the body the ship is currently orbiting (SOI body)
   */
  async getSOIBody(): Promise<string> {
    return getSOIBody(this.conn);
  }
}
