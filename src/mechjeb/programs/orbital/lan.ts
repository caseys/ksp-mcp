/**
 * LAN - Change Longitude of Ascending Node
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';

/**
 * Create a maneuver node to change the Longitude of Ascending Node (LAN).
 * The LAN determines where the orbit crosses the equatorial plane northward.
 *
 * @param conn kOS connection
 * @param newLan Target LAN in degrees (0 to 360)
 * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'
 */
export async function changeLAN(
  conn: KosConnection,
  newLan: number,
  timeRef = 'APOAPSIS'
): Promise<ManeuverResult> {
  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:LAN(${newLan}, "${timeRef}").`;
  return executeManeuverCommand(conn, cmd);
}
