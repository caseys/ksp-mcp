/**
 * Adjust Periapsis - Change orbit low point
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';

/**
 * Create a maneuver node to adjust periapsis.
 * Callers are responsible for validating vessel state before calling.
 *
 * @param conn kOS connection
 * @param altitude Target periapsis altitude in meters
 * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'
 * @param xFromNowSeconds When using X_FROM_NOW, the time in seconds from now
 */
export async function adjustPeriapsis(
  conn: KosConnection,
  altitude: number,
  timeRef = 'APOAPSIS',
  xFromNowSeconds?: number
): Promise<ManeuverResult> {
  // Build command - use CHANGEPETIMED for X_FROM_NOW (thread-safe, no shared state)
  let cmd: string;
  if (timeRef === 'X_FROM_NOW' && xFromNowSeconds !== undefined) {
    cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CHANGEPETIMED(${altitude}, "${timeRef}", ${xFromNowSeconds}).`;
  } else {
    cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CHANGEPE(${altitude}, "${timeRef}").`;
  }
  return executeManeuverCommand(conn, cmd, 10_000, 'adjust_periapsis');
}
