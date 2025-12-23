/**
 * Maneuver Orchestrator
 *
 * Shared helper for executing maneuvers with optional target setting and node execution.
 * Used by MCP server, CLI scripts, and tests to get consistent behavior.
 */

import type { KosConnection } from '../../transport/kos-connection.js';
import type { ManeuverResult } from './shared.js';
import { ManeuverProgram } from './maneuver.js';
import { executeNode } from './execute-node.js';
import { changeSemiMajorAxis } from './basic/semimajor.js';
import { changeEccentricity } from './orbital/eccentricity.js';
import { matchPlane } from './rendezvous/match-plane.js';
import { returnFromMoon } from './transfer/return-from-moon.js';
import { interplanetaryTransfer } from './transfer/interplanetary.js';

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
 * @returns Combined result from planning and optional execution
 */
export async function withTargetAndExecute(
  conn: KosConnection,
  target: string | undefined,
  targetType: 'auto' | 'body' | 'vessel',
  execute: boolean,
  planFn: () => Promise<ManeuverResult>
): Promise<OrchestratedResult> {

  // Handle target setting if provided
  if (target !== undefined) {
    const maneuver = new ManeuverProgram(conn);
    const targetResult = await maneuver.setTarget(target, targetType);
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
  const execResult = await executeNode(conn);

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
  targetName: string
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
      return {
        hasEncounter: true,
        encounterBody,
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
      console.error('[checkPostBurnTrajectory] Failed to parse kOS output:', result.output);
      return { hasEncounter: false, isCloseApproach: false, separation: 0, targetOrbitRadius: 0 };
    }

    const separation = Math.abs(Number.parseInt(distMatch[1]));
    const targetPe = Number.parseInt(peMatch[1]);
    const targetAp = Number.parseInt(apMatch[1]);
    const targetOrbitRadius = (targetPe + targetAp) / 2;

    // Check if separation is within threshold
    const threshold = targetOrbitRadius * CLOSE_APPROACH_THRESHOLD;
    const isCloseApproach = separation < threshold;

    console.error(`[checkPostBurnTrajectory] Target: ${targetName}, Separation: ${(separation / 1000).toFixed(0)} km, ` +
                  `Orbit radius: ${(targetOrbitRadius / 1000).toFixed(0)} km, ` +
                  `Threshold: ${(threshold / 1000).toFixed(0)} km, Close: ${isCloseApproach}`);

    return { hasEncounter: false, isCloseApproach, separation, targetOrbitRadius };
  } catch (error) {
    console.error('[checkPostBurnTrajectory] Error:', error);
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
  private maneuver: ManeuverProgram;

  constructor(private conn: KosConnection) {
    this.maneuver = new ManeuverProgram(conn);
  }

  /**
   * Get the underlying ManeuverProgram for low-level access.
   */
  get program(): ManeuverProgram {
    return this.maneuver;
  }

  /**
   * Circularize orbit at apoapsis or periapsis.
   */
  async circularize(
    timeRef: string = 'APOAPSIS',
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      this.maneuver.circularize(timeRef)
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
    const { target, targetType = 'auto', execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      this.maneuver.adjustPeriapsis(altitude, timeRef)
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
    const { target, targetType = 'auto', execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      this.maneuver.adjustApoapsis(altitude, timeRef)
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
    const { target, targetType = 'auto', execute = true } = options ?? {};

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
      this.maneuver.hohmannTransfer(timeRef, capture)
    );

    // If planning failed or not executed, return as-is
    if (!result.success || !result.executed) {
      return result;
    }

    // Post-execution validation: check trajectory
    const trajectoryCheck = await checkPostBurnTrajectory(this.conn, targetName);

    if (trajectoryCheck.hasEncounter) {
      // We have an encounter
      if (trajectoryCheck.encounterBody?.toLowerCase() === targetName.toLowerCase()) {
        // Correct target - success
        return result;
      }
      // Wrong encounter target - this shouldn't happen after planning succeeded
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
        error: `⚠️ Close approach created (no SOI encounter after burn).\n` +
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
    const { target, targetType = 'auto', execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      this.maneuver.courseCorrection(finalPeA)
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
    const { target, targetType = 'auto', execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      this.maneuver.changeInclination(newInclination, timeRef)
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
    const { target, targetType = 'auto', execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      this.maneuver.ellipticize(peA, apA, timeRef)
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
    const { target, targetType = 'auto', execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      this.maneuver.changeLAN(newLAN, timeRef)
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
    const { target, targetType = 'auto', execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      this.maneuver.changeLongitude(newLong, timeRef)
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
    const { target, targetType = 'auto', execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      this.maneuver.resonantOrbit(numerator, denominator, timeRef)
    );
  }

  /**
   * Kill relative velocity with target.
   */
  async killRelVel(
    timeRef: string = 'CLOSEST_APPROACH',
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      this.maneuver.killRelVel(timeRef)
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
    const { target, targetType = 'auto', execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      changeSemiMajorAxis(this.conn, semiMajorAxis, timeRef)
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
    const { target, targetType = 'auto', execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      changeEccentricity(this.conn, eccentricity, timeRef)
    );
  }

  /**
   * Match orbital plane with target.
   */
  async matchPlane(
    timeRef: string = 'REL_NEAREST_AD',
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      matchPlane(this.conn, timeRef)
    );
  }

  /**
   * Return from moon to parent body.
   */
  async returnFromMoon(
    targetPeriapsis: number,
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, targetType = 'auto', execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, targetType, execute, () =>
      returnFromMoon(this.conn, targetPeriapsis)
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
    const { target, targetType = 'auto', execute = true } = options ?? {};

    // Get the target name for post-execution validation
    let targetName = target;
    if (!targetName) {
      const targetResult = await this.conn.execute('PRINT TARGET:NAME.', 2000);
      targetName = targetResult.output.trim();
    }

    // Plan and optionally execute via standard flow
    const result = await withTargetAndExecute(this.conn, target, targetType, execute, () =>
      interplanetaryTransfer(this.conn, waitForPhaseAngle)
    );

    // If planning failed or not executed, return as-is
    if (!result.success || !result.executed) {
      return result;
    }

    // Post-execution validation: check trajectory (same as Hohmann)
    const trajectoryCheck = await checkPostBurnTrajectory(this.conn, targetName);

    if (trajectoryCheck.hasEncounter) {
      if (trajectoryCheck.encounterBody?.toLowerCase() === targetName.toLowerCase()) {
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
        error: `⚠️ Close approach created (no SOI encounter after burn).\n` +
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
  async setTarget(name: string, type: 'auto' | 'body' | 'vessel' = 'auto') {
    return this.maneuver.setTarget(name, type);
  }

  /**
   * Clear navigation target.
   */
  async clearTarget() {
    return this.maneuver.clearTarget();
  }

  /**
   * Get target info.
   */
  async getTargetInfo() {
    return this.maneuver.getTargetInfo();
  }

  /**
   * List all targetable bodies and vessels sorted by distance.
   */
  async listTargets() {
    return this.maneuver.listTargets();
  }

  /**
   * Check if target is set.
   */
  async hasTarget() {
    return this.maneuver.hasTarget();
  }

  /**
   * Get the name of the body the ship is currently orbiting (SOI body)
   */
  async getSOIBody() {
    return this.maneuver.getSOIBody();
  }
}
