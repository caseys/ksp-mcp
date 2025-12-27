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
  /** Progress callback for MCP notifications. */
  onProgress?: (message: string) => void;
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
        console.error('[checkPostBurnTrajectory] Failed to query encounter periapsis');
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
        // Correct target - check for crash trajectory
        if (trajectoryCheck.encounterPeriapsis !== undefined && trajectoryCheck.encounterPeriapsis < 0) {
          // Crash trajectory - warn user to run course correction
          return {
            ...result,
            error: `⚠️ Transfer successful but trajectory will IMPACT ${trajectoryCheck.encounterBody}!\n` +
                   `Encounter periapsis: ${(trajectoryCheck.encounterPeriapsis / 1000).toFixed(1)} km (below surface)\n` +
                   `Run course_correct to raise periapsis before SOI entry.`,
          };
        }
        // Success - no crash trajectory
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
    const { target, targetType = 'auto', execute = true, onProgress } = options ?? {};

    // Get the target name for post-execution validation
    let targetName = target;
    if (!targetName) {
      const targetResult = await this.conn.execute('PRINT TARGET:NAME.', 2000);
      targetName = targetResult.output.trim();
    }

    // Plan and optionally execute via standard flow
    const result = await withTargetAndExecute(this.conn, target, targetType, execute, () =>
      interplanetaryTransfer(this.conn, { waitForPhaseAngle, onProgress })
    );

    // If planning failed or not executed, return as-is
    if (!result.success || !result.executed) {
      return result;
    }

    // Post-execution validation: check trajectory (same as Hohmann)
    const trajectoryCheck = await checkPostBurnTrajectory(this.conn, targetName);

    if (trajectoryCheck.hasEncounter) {
      if (trajectoryCheck.encounterBody?.toLowerCase() === targetName.toLowerCase()) {
        // Correct target - check for crash trajectory
        if (trajectoryCheck.encounterPeriapsis !== undefined && trajectoryCheck.encounterPeriapsis < 0) {
          // Crash trajectory - warn user to run course correction
          return {
            ...result,
            error: `⚠️ Transfer successful but trajectory will IMPACT ${trajectoryCheck.encounterBody}!\n` +
                   `Encounter periapsis: ${(trajectoryCheck.encounterPeriapsis / 1000).toFixed(1)} km (below surface)\n` +
                   `Run course_correct to raise periapsis before SOI entry.`,
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

// ============================================================================
// Tool Definitions
// ============================================================================

import { z } from 'zod';
import type { ToolDefinition } from '../tool-types.js';
import { executeSchema, distanceSchema, targetSchema, autoTargetSchema, parseTarget } from '../tool-types.js';

/**
 * Circularize tool definition
 */
export const circularizeTool: ToolDefinition = {
  name: 'circularize',
  description: 'Make orbit circular. Use after launch or transfer.',
  inputSchema: {
    timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW'])
      .optional()
      .describe('When to circularize. If omitted, auto-picks based on orbit (periapsis for hyperbolic, nearest apse for elliptical)'),
    execute: executeSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 1,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();

      // Auto-detect best timeRef if not specified
      let timeRef = args.timeRef as string | undefined;
      if (!timeRef) {
        const orbitInfo = await conn.execute(
          'PRINT SHIP:ORBIT:ECCENTRICITY + "|" + ETA:APOAPSIS + "|" + ETA:PERIAPSIS.'
        );
        const parts = orbitInfo.output.split('|').map(s => Number.parseFloat(s.trim()));
        const [ecc, etaApo, etaPe] = parts;

        if (ecc >= 1) {
          timeRef = 'PERIAPSIS';  // Hyperbolic orbit - no apoapsis
        } else {
          timeRef = etaApo < etaPe ? 'APOAPSIS' : 'PERIAPSIS';  // Nearest apse
        }
      }

      const orchestrator = new ManeuverOrchestrator(conn);
      const result = await orchestrator.circularize(timeRef, { execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        return ctx.successResponse('circularize',
          `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
      } else {
        return ctx.errorResponse('circularize', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('circularize', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Adjust apoapsis tool definition
 */
export const adjustApoapsisTool: ToolDefinition = {
  name: 'adjust_apoapsis',
  description: 'Change orbit high point. Use to raise/lower orbit.',
  inputSchema: {
    altitude: distanceSchema.optional().describe('Target apoapsis altitude in meters (default: current + 10km)'),
    timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
      .optional()
      .default('PERIAPSIS')
      .describe('When to execute the maneuver'),
    execute: executeSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 2,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);

      // Default altitude: current apoapsis + 10km
      let altitude = args.altitude as number | undefined;
      if (altitude === undefined) {
        const orbitInfo = await ctx.getOrbitInfo(conn);
        altitude = orbitInfo ? orbitInfo.apoapsis + 10_000 : 100_000;
      }

      const result = await orchestrator.adjustApoapsis(altitude, args.timeRef as string, { execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        return ctx.successResponse('adjust_ap',
          `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
      } else {
        return ctx.errorResponse('adjust_ap', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('adjust_ap', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Adjust periapsis tool definition
 */
export const adjustPeriapsisTool: ToolDefinition = {
  name: 'adjust_periapsis',
  description: 'Change orbit low point. Use for deorbit or orbit adjustments.',
  inputSchema: {
    altitude: distanceSchema.optional().describe('Target periapsis altitude in meters (default: current - 10km)'),
    timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
      .optional()
      .default('APOAPSIS')
      .describe('When to execute the maneuver'),
    execute: executeSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 2,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);

      // Default altitude: current periapsis - 10km (minimum 0)
      let altitude = args.altitude as number | undefined;
      if (altitude === undefined) {
        const orbitInfo = await ctx.getOrbitInfo(conn);
        altitude = orbitInfo ? Math.max(0, orbitInfo.periapsis - 10_000) : 50_000;
      }

      const result = await orchestrator.adjustPeriapsis(altitude, args.timeRef as string, { execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        return ctx.successResponse('adjust_pe',
          `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
      } else {
        return ctx.errorResponse('adjust_pe', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('adjust_pe', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Ellipticize tool definition
 */
export const ellipticizeTool: ToolDefinition = {
  name: 'ellipticize',
  description: 'Set both orbit high and low points in one maneuver.',
  inputSchema: {
    periapsis: distanceSchema.optional().describe('Target periapsis altitude in meters (default: current periapsis)'),
    apoapsis: distanceSchema.optional().describe('Target apoapsis altitude in meters (default: current apoapsis)'),
    timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
      .optional()
      .default('APOAPSIS')
      .describe('When to execute the maneuver'),
    execute: executeSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 2,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);

      // Default to current orbital parameters
      let periapsis = args.periapsis as number | undefined;
      let apoapsis = args.apoapsis as number | undefined;
      if (periapsis === undefined || apoapsis === undefined) {
        const orbitInfo = await ctx.getOrbitInfo(conn);
        if (orbitInfo) {
          periapsis = periapsis ?? orbitInfo.periapsis;
          apoapsis = apoapsis ?? orbitInfo.apoapsis;
        } else {
          periapsis = periapsis ?? 70_000;
          apoapsis = apoapsis ?? 70_000;
        }
      }

      const result = await orchestrator.ellipticize(periapsis, apoapsis, args.timeRef as string, { execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        return ctx.successResponse('ellipticize',
          `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
      } else {
        return ctx.errorResponse('ellipticize', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('ellipticize', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Change inclination tool definition
 */
export const changeInclinationTool: ToolDefinition = {
  name: 'change_inclination',
  description: 'Tilt orbit. Use for polar orbit or equatorial orbit.',
  inputSchema: {
    newInclination: z.number().optional().default(0).describe('Target inclination in degrees (default: 0 for equatorial)'),
    timeRef: z.enum(['EQ_ASCENDING', 'EQ_DESCENDING', 'EQ_NEAREST_AD', 'EQ_HIGHEST_AD', 'X_FROM_NOW'])
      .optional()
      .default('EQ_NEAREST_AD')
      .describe('When to execute: at ascending node, descending node, nearest AN/DN, or highest AD'),
    execute: executeSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 2,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);
      const result = await orchestrator.changeInclination(args.newInclination as number, args.timeRef as string, { execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        return ctx.successResponse('change_inclination',
          `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
      } else {
        return ctx.errorResponse('change_inclination', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('change_inclination', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Change LAN tool definition
 */
export const changeAscendingNodeTool: ToolDefinition = {
  name: 'change_ascending_node',
  description: 'Change LAN. Advanced orbital adjustment.',
  inputSchema: {
    lan: z.number().optional().default(90).describe('Target LAN in degrees (0 to 360, default: 90)'),
    timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
      .optional()
      .default('APOAPSIS')
      .describe('When to execute the maneuver'),
    execute: executeSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 3,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);
      const result = await orchestrator.changeLAN(args.lan as number, args.timeRef as string, { execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        return ctx.successResponse('change_ascending_node',
          `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
      } else {
        return ctx.errorResponse('change_ascending_node', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('change_ascending_node', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Change periapsis longitude tool definition
 */
export const changePeriapsisLongitudeTool: ToolDefinition = {
  name: 'change_periapsis_longitude',
  description: 'Rotate orbit orientation. Advanced.',
  inputSchema: {
    longitude: z.number().optional().default(90).describe('Target longitude in degrees (-180 to 180, default: 90)'),
    timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
      .optional()
      .default('APOAPSIS')
      .describe('When to execute the maneuver'),
    execute: executeSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 3,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);
      const result = await orchestrator.changeLongitude(args.longitude as number, args.timeRef as string, { execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        return ctx.successResponse('change_periapsis_longitude',
          `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
      } else {
        return ctx.errorResponse('change_periapsis_longitude', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('change_periapsis_longitude', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Change semi-major axis tool definition
 */
export const changeSemiMajorAxisTool: ToolDefinition = {
  name: 'change_semi_major_axis',
  description: 'Change orbital period. Advanced.',
  inputSchema: {
    semiMajorAxis: distanceSchema.optional().default(1_000_000).describe('Target semi-major axis in meters (default: 1000km)'),
    timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
      .optional()
      .default('APOAPSIS')
      .describe('When to execute the maneuver'),
    execute: executeSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 3,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);
      const result = await orchestrator.changeSemiMajorAxis(args.semiMajorAxis as number, args.timeRef as string, { execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        return ctx.successResponse('change_semi_major_axis',
          `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
      } else {
        return ctx.errorResponse('change_semi_major_axis', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('change_semi_major_axis', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Change eccentricity tool definition
 */
export const changeEccentricityTool: ToolDefinition = {
  name: 'change_eccentricity',
  description: 'Change orbit shape (0=circular). Advanced.',
  inputSchema: {
    eccentricity: z.number().min(0).max(0.99).optional().default(0).describe('Target eccentricity (0 = circular, <1 = elliptical, default: 0)'),
    timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
      .optional()
      .default('APOAPSIS')
      .describe('When to execute the maneuver'),
    execute: executeSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 3,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);
      const result = await orchestrator.changeEccentricity(args.eccentricity as number, args.timeRef as string, { execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        return ctx.successResponse('change_eccentricity',
          `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
      } else {
        return ctx.errorResponse('change_eccentricity', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('change_eccentricity', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Hohmann transfer tool definition
 */
export const hohmannTransferTool: ToolDefinition = {
  name: 'hohmann_transfer',
  description: 'Go to a moon or planet. Use for: fly to Mun, navigate to Minmus, transfer to vessel.',
  inputSchema: {
    target: autoTargetSchema,
    timeReference: z.enum(['COMPUTED', 'PERIAPSIS', 'APOAPSIS'])
      .optional()
      .default('COMPUTED')
      .describe('When to execute: COMPUTED (optimal), PERIAPSIS, or APOAPSIS'),
    capture: z.boolean()
      .optional()
      .default(false)
      .describe('Include capture burn for vessel rendezvous. Default: false (transfer only).'),
    execute: executeSchema,
    includeTelemetry: z.boolean()
      .optional()
      .default(false)
      .describe('Include ship telemetry in response (slower but more info)'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 1,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);

      // Auto-select target if not provided
      let target = args.target as string | undefined;
      if (!target) {
        const autoTarget = await ctx.selectTarget(orchestrator, 'closest-body');
        if (autoTarget) {
          target = autoTarget;
        }
      }

      const result = await orchestrator.hohmannTransfer(args.timeReference as string, args.capture as boolean, { target, execute: args.execute as boolean });

      if (result.success) {
        const nodeCount = result.nodesCreated ?? 1;
        const execInfo = result.executed ? ' (executed)' : '';
        let text = `${nodeCount} node(s): ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`;

        // Include warning if present (crash trajectory, close approach, etc.)
        if (result.error) {
          text += '\n\n' + result.error;
        }

        if (args.includeTelemetry) {
          const { queryTargetEncounterInfo } = await import('./shared.js');
          const { getShipTelemetry, formatTargetEncounterInfo } = await import('./telemetry.js');
          const targetInfo = await queryTargetEncounterInfo(conn);
          if (targetInfo) {
            text += '\n\n' + formatTargetEncounterInfo(targetInfo);
          }
          const telemetry = await getShipTelemetry(conn, { timeoutMs: 2500 });
          text += '\n\n' + telemetry.formatted;
        }

        return ctx.successResponse('hohmann', text);
      } else {
        return ctx.errorResponse('hohmann', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('hohmann', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Course correction tool definition
 */
export const courseCorrectTool: ToolDefinition = {
  name: 'course_correct',
  description: 'Fine-tune approach after transfer. Adjusts periapsis at destination.',
  inputSchema: {
    target: targetSchema,
    targetDistance: distanceSchema.optional().default(50_000).describe('Target periapsis (bodies) or closest approach (vessels) in meters (default: 50km)'),
    execute: executeSchema,
    includeTelemetry: z.boolean()
      .optional()
      .default(false)
      .describe('Include ship telemetry in response (slower but more info)'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 1,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);

      // Auto-select 2nd closest body if no target provided
      let target = args.target as string | undefined;
      if (!target) {
        const autoTarget = await ctx.selectTarget(orchestrator, 'second-closest');
        if (autoTarget) {
          target = autoTarget;
        }
      }

      // Try course correction
      let result = await orchestrator.courseCorrection(args.targetDistance as number, { target, execute: args.execute as boolean });

      // If no encounter, do hohmann transfer first
      if (!result.success && result.error?.toLowerCase().includes('no encounter')) {
        const hohmannResult = await orchestrator.hohmannTransfer('COMPUTED', false, { target, execute: args.execute as boolean });
        if (hohmannResult.success) {
          result = await orchestrator.courseCorrection(args.targetDistance as number, { execute: args.execute as boolean });
        }
      }

      if (!result.success) {
        return ctx.errorResponse('course_correct', result.error ?? 'Failed');
      }

      const execInfo = result.executed ? ' (executed)' : '';
      let text = `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`;

      if (args.includeTelemetry) {
        const { queryTargetEncounterInfo } = await import('./shared.js');
        const { getShipTelemetry, formatTargetEncounterInfo } = await import('./telemetry.js');
        const targetInfo = await queryTargetEncounterInfo(conn);
        if (targetInfo) {
          text += '\n\n' + formatTargetEncounterInfo(targetInfo);
        }
        const telemetry = await getShipTelemetry(conn, { timeoutMs: 2500 });
        text += '\n\n' + telemetry.formatted;
      }

      return ctx.successResponse('course_correct', text);
    } catch (error) {
      return ctx.errorResponse('course_correct', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Match planes tool definition
 */
export const matchPlanesTool: ToolDefinition = {
  name: 'match_planes',
  description: 'Align orbit with target for rendezvous or docking.',
  inputSchema: {
    target: autoTargetSchema,
    timeRef: z.enum(['REL_NEAREST_AD', 'REL_HIGHEST_AD', 'REL_ASCENDING', 'REL_DESCENDING'])
      .optional()
      .default('REL_NEAREST_AD')
      .describe('When to execute: nearest AN/DN, highest AN/DN, ascending node, or descending node'),
    execute: executeSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 1,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);

      // Auto-select closest vessel if not provided
      let target = args.target as string | undefined;
      if (!target) {
        const autoTarget = await ctx.selectTarget(orchestrator, 'closest-vessel');
        if (autoTarget) {
          target = autoTarget;
        }
      }

      const result = await orchestrator.matchPlane(args.timeRef as string, { target, execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        return ctx.successResponse('match_planes',
          `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
      } else {
        return ctx.errorResponse('match_planes', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('match_planes', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Match velocities tool definition
 */
export const matchVelocitiesTool: ToolDefinition = {
  name: 'match_velocities',
  description: 'Match speed with target for docking. Use at closest approach.',
  inputSchema: {
    target: autoTargetSchema,
    timeRef: z.enum(['CLOSEST_APPROACH', 'X_FROM_NOW'])
      .optional()
      .default('CLOSEST_APPROACH')
      .describe('When to execute: at closest approach or after X seconds'),
    execute: executeSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 2,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);

      // Auto-select closest vessel if not provided
      let target = args.target as string | undefined;
      if (!target) {
        const autoTarget = await ctx.selectTarget(orchestrator, 'closest-vessel');
        if (autoTarget) {
          target = autoTarget;
        }
      }

      const result = await orchestrator.killRelVel(args.timeRef as string, { target, execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        return ctx.successResponse('match_velocities',
          `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
      } else {
        return ctx.errorResponse('match_velocities', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('match_velocities', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Interplanetary transfer tool definition
 */
export const interplanetaryTransferTool: ToolDefinition = {
  name: 'interplanetary_transfer',
  description: 'Go to another planet: Duna, Eve, Jool. Waits for transfer window.',
  inputSchema: {
    target: autoTargetSchema,
    waitForPhaseAngle: z.boolean()
      .optional()
      .default(true)
      .describe('If true, waits for optimal phase angle. If false, transfers immediately.'),
    execute: executeSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 2,
  handler: async (args, ctx, extra) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);
      const onProgress = ctx.createProgressCallback(extra);

      // Auto-select furthest body if not provided (interplanetary = distant planets)
      let target = args.target as string | undefined;
      if (!target) {
        const autoTarget = await ctx.selectTarget(orchestrator, 'furthest-body');
        if (autoTarget) {
          target = autoTarget;
        }
      }

      const result = await orchestrator.interplanetaryTransfer(args.waitForPhaseAngle as boolean, { target, execute: args.execute as boolean, onProgress });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        let text = `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`;

        // Include warning if present (crash trajectory, close approach, etc.)
        if (result.error) {
          text += '\n\n' + result.error;
        }

        return ctx.successResponse('interplanetary', text);
      } else {
        return ctx.errorResponse('interplanetary', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('interplanetary', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Return from moon tool definition
 */
export const returnFromMoonTool: ToolDefinition = {
  name: 'return_from_moon',
  description: 'Return from Mun/Minmus to Kerbin. Sets up reentry trajectory.',
  inputSchema: {
    targetPeriapsis: distanceSchema.optional().default(40_000).describe('Target periapsis at parent body in meters (default: 40km)'),
    execute: executeSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 2,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);
      const result = await orchestrator.returnFromMoon(args.targetPeriapsis as number, { execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        return ctx.successResponse('return_from_moon',
          `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
      } else {
        return ctx.errorResponse('return_from_moon', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('return_from_moon', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Resonant orbit tool definition
 */
export const resonantOrbitTool: ToolDefinition = {
  name: 'resonant_orbit',
  description: 'Create orbit for deploying satellite constellation.',
  inputSchema: {
    numerator: z.number().int().positive().optional().default(2).describe('Numerator of resonance ratio (default: 2 for 2:3)'),
    denominator: z.number().int().positive().optional().default(3).describe('Denominator of resonance ratio (default: 3 for 2:3)'),
    timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW'])
      .optional()
      .default('APOAPSIS')
      .describe('When to execute the maneuver'),
    execute: executeSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 2,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);
      const result = await orchestrator.resonantOrbit(args.numerator as number, args.denominator as number, args.timeRef as string, { execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        return ctx.successResponse('resonant_orbit',
          `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
      } else {
        return ctx.errorResponse('resonant_orbit', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('resonant_orbit', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Set target tool definition
 */
export const setTargetTool: ToolDefinition = {
  name: 'set_target',
  description: 'Set navigation target. Prefer target param on transfer tools.',
  inputSchema: {
    name: z.preprocess(parseTarget, z.string()).optional().describe('Target name. Use get_targets to list available names. (default: 2nd closest body)'),
    type: z.enum(['auto', 'body', 'vessel']).optional().default('auto')
      .describe('Target type: "auto" tries name directly, "body" for celestial bodies, "vessel" for ships'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  tier: 3,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);

      // Default to 2nd closest body if no name provided
      let name = args.name as string | undefined;
      if (!name) {
        const autoTarget = await ctx.selectTarget(orchestrator, 'second-closest', false);
        if (!autoTarget) {
          return ctx.errorResponse('set_target', 'No suitable target found');
        }
        name = autoTarget;
      }

      const result = await orchestrator.setTarget(name, args.type as 'auto' | 'body' | 'vessel');
      if (!result.success) {
        return ctx.errorResponse('set_target', result.error ?? `Failed to set target "${name}"`);
      }

      return ctx.successResponse('set_target', `Target: ${result.name} (${result.type})`);
    } catch (error) {
      return ctx.errorResponse('set_target', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Get target tool definition
 */
export const getTargetTool: ToolDefinition = {
  name: 'get_target',
  description: 'Show current navigation target.',
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 2,
  handler: async (_args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);

      const info = await orchestrator.getTargetInfo();
      if (!info.hasTarget) {
        return ctx.successResponse('get_target', 'No target set.');
      }

      return ctx.successResponse('get_target', info.details ?? `Target: ${info.name}`);
    } catch (error) {
      return ctx.errorResponse('get_target', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Get targets tool definition
 */
export const getTargetsTool: ToolDefinition = {
  name: 'get_targets',
  description: 'List all moons, planets, and vessels you can travel to.',
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 2,
  handler: async (_args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);
      const result = await orchestrator.listTargets();
      return ctx.successResponse('get_targets', JSON.stringify(result, null, 2));
    } catch (error) {
      return ctx.errorResponse('get_targets', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Clear target tool definition
 */
export const clearTargetTool: ToolDefinition = {
  name: 'clear_target',
  description: 'Clear navigation target.',
  inputSchema: {},
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 3,
  handler: async (_args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);
      const result = await orchestrator.clearTarget();

      if (result.cleared) {
        return ctx.successResponse('clear_target', 'Target cleared.');
      }

      return ctx.successResponse('clear_target', result.warning ?? 'Clear command sent.');
    } catch (error) {
      return ctx.errorResponse('clear_target', error instanceof Error ? error.message : String(error));
    }
  },
};
