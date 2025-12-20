/**
 * Resonant Orbit - Create orbit with specific period ratio
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';

/**
 * Create a maneuver node to establish a resonant orbit.
 * Useful for satellite constellations where you want to deploy
 * satellites at evenly spaced intervals.
 *
 * Example: 2:3 resonance means completing 2 orbits while the
 * original position completes 3, allowing periodic rendezvous.
 *
 * @param conn kOS connection
 * @param numerator Numerator of the resonance ratio
 * @param denominator Denominator of the resonance ratio
 * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW'
 */
export async function resonantOrbit(
  conn: KosConnection,
  numerator: number,
  denominator: number,
  timeRef = 'APOAPSIS'
): Promise<ManeuverResult> {
  if (numerator <= 0 || denominator <= 0) {
    return {
      success: false,
      error: `Invalid resonance ratio: ${numerator}:${denominator}. Both values must be positive.`
    };
  }

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:RESONANTORBIT(${numerator}, ${denominator}, "${timeRef}").`;
  return executeManeuverCommand(conn, cmd);
}
