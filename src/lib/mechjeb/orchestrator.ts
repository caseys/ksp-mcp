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
 * @param execute - Whether to execute the node after planning (default: true)
 * @param planFn - The function that creates the maneuver node
 * @returns Combined result from planning and optional execution
 */
export async function withTargetAndExecute(
  conn: KosConnection,
  target: string | undefined,
  execute: boolean,
  planFn: () => Promise<ManeuverResult>
): Promise<OrchestratedResult> {

  // Handle target setting if provided
  if (target !== undefined) {
    const maneuver = new ManeuverProgram(conn);
    const targetResult = await maneuver.setTarget(target, 'auto');
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
    const { target, execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, execute, () =>
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
    const { target, execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, execute, () =>
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
    const { target, execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, execute, () =>
      this.maneuver.adjustApoapsis(altitude, timeRef)
    );
  }

  /**
   * Hohmann transfer to target.
   */
  async hohmannTransfer(
    timeRef: string = 'COMPUTED',
    capture: boolean = false,
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, execute, () =>
      this.maneuver.hohmannTransfer(timeRef, capture)
    );
  }

  /**
   * Course correction to fine-tune approach.
   */
  async courseCorrection(
    finalPeA: number,
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, execute, () =>
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
    const { target, execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, execute, () =>
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
    const { target, execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, execute, () =>
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
    const { target, execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, execute, () =>
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
    const { target, execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, execute, () =>
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
    const { target, execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, execute, () =>
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
    const { target, execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, execute, () =>
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
    const { target, execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, execute, () =>
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
    const { target, execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, execute, () =>
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
    const { target, execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, execute, () =>
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
    const { target, execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, execute, () =>
      returnFromMoon(this.conn, targetPeriapsis)
    );
  }

  /**
   * Interplanetary transfer to target planet.
   */
  async interplanetaryTransfer(
    waitForPhaseAngle: boolean = true,
    options?: ManeuverOptions
  ): Promise<OrchestratedResult> {
    const { target, execute = true } = options ?? {};
    return withTargetAndExecute(this.conn, target, execute, () =>
      interplanetaryTransfer(this.conn, waitForPhaseAngle)
    );
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
   * Check if target is set.
   */
  async hasTarget() {
    return this.maneuver.hasTarget();
  }
}
