/**
 * Longitude of Periapsis - Change where periapsis occurs in the orbit
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';

/**
 * Create a maneuver node to change the Longitude of Periapsis.
 * This rotates the orbit so periapsis occurs at the specified longitude.
 *
 * @param conn kOS connection
 * @param newLong Target longitude in degrees (-180 to 180)
 * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'
 */
export async function changeLongitudeOfPeriapsis(
  conn: KosConnection,
  newLong: number,
  timeRef = 'APOAPSIS'
): Promise<ManeuverResult> {
  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:LONGITUDE(${newLong}, "${timeRef}").`;
  return executeManeuverCommand(conn, cmd);
}
