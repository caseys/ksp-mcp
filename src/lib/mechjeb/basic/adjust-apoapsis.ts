/**
 * Adjust Apoapsis - Change orbit high point
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';
import { validateVesselState, STABLE_ORBIT_REQUIREMENTS } from '../../kos/vessel/validate.js';

/**
 * Create a maneuver node to adjust apoapsis.
 *
 * @param conn kOS connection
 * @param altitude Target apoapsis altitude in meters
 * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'
 * @param xFromNowSeconds When using X_FROM_NOW, the time in seconds from now
 */
export async function adjustApoapsis(
  conn: KosConnection,
  altitude: number,
  timeRef = 'PERIAPSIS',
  xFromNowSeconds?: number
): Promise<ManeuverResult> {
  // Validate vessel state: must be in stable orbit (not escaped, not on ground)
  const validation = await validateVesselState(conn, STABLE_ORBIT_REQUIREMENTS, 'adjust_apoapsis');
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // Build command - use CHANGEAPTIMED for X_FROM_NOW (thread-safe, no shared state)
  let cmd: string;
  if (timeRef === 'X_FROM_NOW' && xFromNowSeconds !== undefined) {
    cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CHANGEAPTIMED(${altitude}, "${timeRef}", ${xFromNowSeconds}).`;
  } else {
    cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CHANGEAP(${altitude}, "${timeRef}").`;
  }
  return executeManeuverCommand(conn, cmd, 10_000, 'adjust_apoapsis');
}
