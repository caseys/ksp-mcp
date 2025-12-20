/**
 * Ellipticize - Set both periapsis and apoapsis in a single burn
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';

/**
 * Create a maneuver node to set both periapsis and apoapsis.
 * More efficient than separate Pe/Ap burns when changing both.
 *
 * @param conn kOS connection
 * @param newPeA Target periapsis altitude in meters
 * @param newApA Target apoapsis altitude in meters
 * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'
 */
export async function ellipticize(
  conn: KosConnection,
  newPeA: number,
  newApA: number,
  timeRef = 'APOAPSIS'
): Promise<ManeuverResult> {
  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:ELLIPTICIZE(${newPeA}, ${newApA}, "${timeRef}").`;
  return executeManeuverCommand(conn, cmd);
}
