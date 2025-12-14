/**
 * MechJeb Maneuver Program
 *
 * Task-oriented interface for maneuver planning via kOS.MechJeb2.Addon
 */

import type { KosConnection } from '../../transport/kos-connection.js';
import {
  type ManeuverResult,
  parseNumber,
  parseTimeString,
  queryNumber,
  queryNumberWithRetry,
  queryTime,
  queryNodeInfo
} from './shared.js';

// Re-export for external use
export type { ManeuverResult } from './shared.js';

/**
 * Maneuver Program - controls MechJeb maneuver planner
 *
 * Uses kOS.MechJeb2.Addon's MANEUVERPLANNER suffixes:
 *   ADDONS:MJ:MANEUVERPLANNER:CHANGEPE(altitude, timeRef)
 *   ADDONS:MJ:MANEUVERPLANNER:CHANGEAP(altitude, timeRef)
 *   ADDONS:MJ:MANEUVERPLANNER:CIRCULARIZE(timeRef)
 */
export class ManeuverProgram {
  constructor(private conn: KosConnection) {}

  /**
   * Adjust periapsis by creating a maneuver node.
   *
   * NOTE: Cannot raise periapsis above current apoapsis (orbital mechanics).
   * MechJeb will clamp and return tiny dV if you try.
   *
   * @param altitude Target periapsis altitude in meters
   * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'
   */
  async adjustPeriapsis(altitude: number, timeRef: string = 'APOAPSIS'): Promise<ManeuverResult> {
    // Create the maneuver node (returns True/False)
    const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CHANGEPE(${altitude}, "${timeRef}").`;
    const result = await this.conn.execute(cmd, 10000);

    const success = result.output.includes('True');
    if (!success) {
      return { success: false, error: this.sanitizeError(result.output, 'Adjust periapsis') };
    }

    // Query node info using kOS native NEXTNODE (MechJeb INFO returns "N/A")
    const nodeInfo = await queryNodeInfo(this.conn);

    return {
      success: true,
      deltaV: nodeInfo.deltaV,
      timeToNode: nodeInfo.timeToNode
    };
  }

  /**
   * Adjust apoapsis by creating a maneuver node.
   *
   * @param altitude Target apoapsis altitude in meters
   * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'
   */
  async adjustApoapsis(altitude: number, timeRef: string = 'PERIAPSIS'): Promise<ManeuverResult> {
    const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CHANGEAP(${altitude}, "${timeRef}").`;
    const result = await this.conn.execute(cmd, 10000);

    const success = result.output.includes('True');
    if (!success) {
      return { success: false, error: this.sanitizeError(result.output, 'Adjust apoapsis') };
    }

    // Query node info using kOS native NEXTNODE (MechJeb INFO returns "N/A")
    const nodeInfo = await queryNodeInfo(this.conn);

    return {
      success: true,
      deltaV: nodeInfo.deltaV,
      timeToNode: nodeInfo.timeToNode
    };
  }

  /**
   * Circularize orbit at a specific point.
   *
   * @param timeRef When to circularize: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'
   */
  async circularize(timeRef: string = 'APOAPSIS'): Promise<ManeuverResult> {
    const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CIRCULARIZE("${timeRef}").`;
    const result = await this.conn.execute(cmd, 10000);

    const success = result.output.includes('True');
    if (!success) {
      return { success: false, error: this.sanitizeError(result.output, 'Circularize') };
    }

    // Query node info using kOS native NEXTNODE (MechJeb INFO returns "N/A")
    const nodeInfo = await queryNodeInfo(this.conn);

    return {
      success: true,
      deltaV: nodeInfo.deltaV,
      timeToNode: nodeInfo.timeToNode
    };
  }

  /**
   * Set the navigation target (celestial body or vessel)
   *
   * @param name Target name (e.g., "Mun", "Minmus", or vessel name)
   * @param type 'body' for celestial bodies, 'vessel' for other vessels
   */
  async setTarget(name: string, type: 'body' | 'vessel' = 'body'): Promise<boolean> {
    const cmd = type === 'body'
      ? `SET TARGET TO BODY("${name}").`
      : `SET TARGET TO VESSEL("${name}").`;
    const result = await this.conn.execute(cmd, 5000);
    // Success if no error message
    return result.success && !result.output.toLowerCase().includes('error');
  }

  /**
   * Check if a navigation target is currently set
   */
  async hasTarget(): Promise<boolean> {
    const result = await this.conn.execute('PRINT HASTARGET.', 2000);
    const output = result.output.trim().toLowerCase();
    // kOS returns "True" or "False" - check for true anywhere in output
    return output.includes('true');
  }

  /**
   * Debug helper to get target state with full details
   * Optimized: single atomic query
   */
  async getTargetDebugInfo(): Promise<{ hasTarget: boolean; rawOutput: string; targetName?: string }> {
    // Single query that handles both cases
    const result = await this.conn.execute(
      'IF HASTARGET { PRINT "TGT|" + TARGET:NAME. } ELSE { PRINT "NOTGT". }',
      3000
    );

    if (result.output.includes('NOTGT')) {
      return { hasTarget: false, rawOutput: result.output };
    }

    const match = result.output.match(/TGT\|(.+?)(?:\s*>|$)/);
    return {
      hasTarget: true,
      rawOutput: result.output,
      targetName: match ? match[1].trim() : undefined
    };
  }

  /**
   * Get the current target name
   */
  async getTarget(): Promise<string | null> {
    if (!await this.hasTarget()) return null;
    const result = await this.conn.execute('PRINT TARGET.', 2000);
    // Extract target name from output
    const match = result.output.match(/(?:Body|Vessel)\s+"?([^"\n]+)"?/i);
    return match ? match[1].trim() : result.output.trim();
  }

  /**
   * Sanitize kOS output for error messages.
   * Removes command echoes, control characters, and extracts meaningful failure reasons.
   */
  private sanitizeError(rawOutput: string, operation: string): string {
    // If output is mostly command echo (contains SET/PRINT), give generic message
    // Check this FIRST because command echo may contain FALSE as parameter
    if (rawOutput.includes('SET ') || rawOutput.includes('PRINT ')) {
      return `${operation} failed - planner did not return success`;
    }

    // Common kOS error patterns
    const errorPatterns = [
      { pattern: /No target/i, message: 'No target set' },
      { pattern: /Cannot find/i, message: 'Command not found - MechJeb may not be available' },
      { pattern: /Syntax error/i, message: 'kOS syntax error' },
      { pattern: /^False$/i, message: `${operation} failed - planner returned False` },  // Exact match
    ];

    for (const { pattern, message } of errorPatterns) {
      if (pattern.test(rawOutput)) {
        return message;
      }
    }

    // Otherwise, return cleaned output (limit length)
    const cleaned = rawOutput.trim().substring(0, 100);
    return cleaned || `${operation} failed - unknown reason`;
  }

  /**
   * Plan a Hohmann transfer to the current target.
   *
   * Requires a target to be set (use setTarget first).
   * Creates 1-2 maneuver nodes depending on capture setting.
   *
   * @param timeRef When to execute: 'COMPUTED' (optimal), 'PERIAPSIS', 'APOAPSIS'
   * @param capture If true, includes capture burn (2 nodes). If false, transfer only (1 node)
   */
  async hohmannTransfer(
    timeRef: string = 'COMPUTED',
    capture: boolean = true
  ): Promise<ManeuverResult> {
    // Check target exists with debug info
    const targetDebug = await this.getTargetDebugInfo();
    if (!targetDebug.hasTarget) {
      return {
        success: false,
        error: `No target set. Use setTarget() first.\n` +
               `Debug: HASTARGET returned: "${targetDebug.rawOutput.trim()}"`
      };
    }

    const captureStr = capture ? 'TRUE' : 'FALSE';
    const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:HOHMANN("${timeRef}", ${captureStr}).`;
    const result = await this.conn.execute(cmd, 10000);

    const success = result.output.includes('True');
    if (!success) {
      // Sanitize error message - extract meaningful failure reason
      const error = this.sanitizeError(result.output, 'Hohmann transfer');
      return { success: false, error };
    }

    // Query node info using kOS native NEXTNODE (MechJeb INFO returns "N/A")
    const nodeInfo = await queryNodeInfo(this.conn);
    const deltaV = nodeInfo.deltaV;
    const timeToNode = nodeInfo.timeToNode;

    // CRITICAL: Verify encounter exists (check the orbit AFTER executing the node)
    const hasEncounterResult = await this.conn.execute('PRINT NEXTNODE:ORBIT:HASNEXTPATCH.');
    if (!hasEncounterResult.output.includes('True')) {
      return {
        success: false,
        error: '❌ Hohmann transfer nodes created but NO ENCOUNTER detected!\n' +
               'The transfer trajectory does not intersect the target.\n' +
               'This indicates a problem with the transfer planning.\n' +
               'DO NOT EXECUTE this burn - it will waste fuel without reaching the target.'
      };
    }

    return {
      success: true,
      deltaV,
      timeToNode,
    };
  }

  /**
   * Fine-tune closest approach to target.
   *
   * Optimizes periapsis for body targets or closest approach for vessel targets.
   * Timing is calculated automatically by MechJeb (no timeRef parameter).
   *
   * @param finalPeA Target periapsis (bodies) or closest approach (vessels) in meters
   */
  async courseCorrection(finalPeA: number, minLeadTime: number = 300): Promise<ManeuverResult> {
    // WORKAROUND: MechJeb's course correction algorithm produces results that vary
    // with trajectory geometry. Using 3x multiplier to err on the safe side
    // (higher periapsis than requested, avoiding surface impact).
    // TODO: Investigate MechJeb algorithm or implement iterative refinement.
    const adjustedPeA = finalPeA * 3;
    console.error(`[CourseCorrection] WORKAROUND: Requested ${finalPeA}m, using ${adjustedPeA}m (3x safe margin)`);

    const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:COURSECORRECTION(${adjustedPeA}).`;
    const result = await this.conn.execute(cmd, 10000);

    const success = result.output.includes('True');
    if (!success) {
      return { success: false, error: this.sanitizeError(result.output, 'Course correction') };
    }

    // Query node info using kOS native NEXTNODE (MechJeb INFO returns "N/A")
    const nodeInfo = await queryNodeInfo(this.conn);
    const deltaV = nodeInfo.deltaV;
    const timeToNode = nodeInfo.timeToNode;

    // Check minimum lead time - reject nodes that are too soon
    if (timeToNode < minLeadTime) {
      // Delete the node that's too soon
      await this.conn.execute('REMOVE NEXTNODE.', 2000);
      return {
        success: false,
        error: `Course correction burn time (${timeToNode.toFixed(0)}s) is less than minimum lead time (${minLeadTime}s). Node deleted. Try again later or reduce lead time.`
      };
    }

    return { success: true, deltaV, timeToNode };
  }

  /**
   * Change orbital inclination.
   *
   * Creates a maneuver node to change the orbital inclination to a new value.
   * Most efficient at equatorial crossings (ascending/descending nodes).
   *
   * @param newInclination Target inclination in degrees
   * @param timeRef When to execute: 'EQ_ASCENDING', 'EQ_DESCENDING', 'EQ_NEAREST_AD', 'EQ_HIGHEST_AD', 'X_FROM_NOW'
   */
  async changeInclination(newInclination: number, timeRef: string = 'EQ_NEAREST_AD'): Promise<ManeuverResult> {
    const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CHANGEINCLINATION(${newInclination}, "${timeRef}").`;
    const result = await this.conn.execute(cmd, 10000);

    const success = result.output.includes('True');
    if (!success) {
      return { success: false, error: this.sanitizeError(result.output, 'Change inclination') };
    }

    // Query node info using kOS native NEXTNODE (MechJeb INFO returns "N/A")
    const nodeInfo = await queryNodeInfo(this.conn);
    const deltaV = nodeInfo.deltaV;
    const timeToNode = nodeInfo.timeToNode;

    return { success: true, deltaV, timeToNode };
  }

  /**
   * Ellipticize orbit to specified periapsis and apoapsis.
   *
   * Creates a maneuver node to change orbit shape while keeping it elliptical.
   *
   * @param peA Target periapsis altitude in meters
   * @param apA Target apoapsis altitude in meters
   * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'
   */
  async ellipticize(peA: number, apA: number, timeRef: string = 'APOAPSIS'): Promise<ManeuverResult> {
    const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:ELLIPTICIZE(${peA}, ${apA}, "${timeRef}").`;
    const result = await this.conn.execute(cmd, 10000);

    const success = result.output.includes('True');
    if (!success) {
      return { success: false, error: this.sanitizeError(result.output, 'Ellipticize') };
    }

    // Query node info using kOS native NEXTNODE (MechJeb INFO returns "N/A")
    const nodeInfo = await queryNodeInfo(this.conn);

    return {
      success: true,
      deltaV: nodeInfo.deltaV,
      timeToNode: nodeInfo.timeToNode
    };
  }

  /**
   * Change longitude of ascending node (LAN).
   *
   * Creates a maneuver node to change where the orbit crosses the equatorial plane.
   *
   * @param newLAN Target LAN in degrees (0-360)
   * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW'
   */
  async changeLAN(newLAN: number, timeRef: string = 'APOAPSIS'): Promise<ManeuverResult> {
    const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:LAN(${newLAN}, "${timeRef}").`;
    const result = await this.conn.execute(cmd, 10000);

    const success = result.output.includes('True');
    if (!success) {
      return { success: false, error: this.sanitizeError(result.output, 'Change LAN') };
    }

    // Query node info using kOS native NEXTNODE (MechJeb INFO returns "N/A")
    const nodeInfo = await queryNodeInfo(this.conn);

    return {
      success: true,
      deltaV: nodeInfo.deltaV,
      timeToNode: nodeInfo.timeToNode
    };
  }

  /**
   * Change longitude of periapsis.
   *
   * Creates a maneuver node to rotate the orbit in its plane.
   *
   * @param newLong Target longitude of periapsis in degrees (0-360)
   * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW'
   */
  async changeLongitude(newLong: number, timeRef: string = 'APOAPSIS'): Promise<ManeuverResult> {
    const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:LONGITUDE(${newLong}, "${timeRef}").`;
    const result = await this.conn.execute(cmd, 10000);

    const success = result.output.includes('True');
    if (!success) {
      return { success: false, error: this.sanitizeError(result.output, 'Change longitude') };
    }

    // Query node info using kOS native NEXTNODE (MechJeb INFO returns "N/A")
    const nodeInfo = await queryNodeInfo(this.conn);

    return {
      success: true,
      deltaV: nodeInfo.deltaV,
      timeToNode: nodeInfo.timeToNode
    };
  }

  /**
   * Create a resonant orbit for satellite constellation deployment.
   *
   * Creates a maneuver node to put the vessel in an orbit that returns
   * to the same position after a specific number of orbital periods.
   *
   * @param numerator Numerator of the resonance ratio
   * @param denominator Denominator of the resonance ratio
   * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW'
   */
  async resonantOrbit(numerator: number, denominator: number, timeRef: string = 'APOAPSIS'): Promise<ManeuverResult> {
    const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:RESONANTORBIT(${numerator}, ${denominator}, "${timeRef}").`;
    const result = await this.conn.execute(cmd, 10000);

    const success = result.output.includes('True');
    if (!success) {
      return { success: false, error: this.sanitizeError(result.output, 'Resonant orbit') };
    }

    // Query node info using kOS native NEXTNODE (MechJeb INFO returns "N/A")
    const nodeInfo = await queryNodeInfo(this.conn);

    return {
      success: true,
      deltaV: nodeInfo.deltaV,
      timeToNode: nodeInfo.timeToNode
    };
  }

  /**
   * Kill relative velocity with target.
   *
   * Creates a maneuver node to match velocity with the current target.
   * Useful for rendezvous operations.
   *
   * @param timeRef When to execute: 'CLOSEST_APPROACH', 'X_FROM_NOW', etc.
   */
  async killRelVel(timeRef: string = 'CLOSEST_APPROACH'): Promise<ManeuverResult> {
    // Check target exists
    if (!await this.hasTarget()) {
      return { success: false, error: 'No target set. Use setTarget() first.' };
    }

    const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:KILLRELVEL("${timeRef}").`;
    const result = await this.conn.execute(cmd, 10000);

    const success = result.output.includes('True');
    if (!success) {
      return { success: false, error: this.sanitizeError(result.output, 'Match velocities') };
    }

    // Query node info using kOS native NEXTNODE (MechJeb INFO returns "N/A")
    const nodeInfo = await queryNodeInfo(this.conn);

    return {
      success: true,
      deltaV: nodeInfo.deltaV,
      timeToNode: nodeInfo.timeToNode
    };
  }

  /**
   * Query a numeric value from MechJeb (e.g., "23.80  m/s")
   */
  private async queryNumber(suffix: string): Promise<number> {
    return queryNumber(this.conn, suffix);
  }

  /**
   * Query a time value from MechJeb (e.g., "31m 10s")
   */
  private async queryTime(suffix: string): Promise<number> {
    return queryTime(this.conn, suffix);
  }
}
