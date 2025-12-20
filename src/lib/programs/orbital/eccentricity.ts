/**
 * Eccentricity - Change orbital eccentricity
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';

/**
 * Create a maneuver node to change orbital eccentricity.
 * Eccentricity ranges from 0 (circular) to just under 1 (parabolic).
 *
 * @param conn kOS connection
 * @param newEcc Target eccentricity (0 to <1)
 * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'
 */
export async function changeEccentricity(
  conn: KosConnection,
  newEcc: number,
  timeRef = 'APOAPSIS'
): Promise<ManeuverResult> {
  if (newEcc < 0 || newEcc >= 1) {
    return {
      success: false,
      error: `Invalid eccentricity: ${newEcc}. Must be between 0 (circular) and 1 (parabolic).`
    };
  }

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:ECCENTRICITY(${newEcc}, "${timeRef}").`;
  return executeManeuverCommand(conn, cmd);
}
