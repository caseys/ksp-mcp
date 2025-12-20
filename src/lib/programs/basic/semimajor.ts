/**
 * Semi-Major Axis - Change orbital semi-major axis
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';

/**
 * Create a maneuver node to change the orbital semi-major axis.
 * The semi-major axis determines the orbital period.
 *
 * @param conn kOS connection
 * @param newSma Target semi-major axis in meters
 * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'
 */
export async function changeSemiMajorAxis(
  conn: KosConnection,
  newSma: number,
  timeRef = 'APOAPSIS'
): Promise<ManeuverResult> {
  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:SEMIMAJOR(${newSma}, "${timeRef}").`;
  return executeManeuverCommand(conn, cmd);
}
