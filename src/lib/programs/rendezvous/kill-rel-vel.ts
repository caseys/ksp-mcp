/**
 * Kill Relative Velocity - Match velocity with target
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';

/**
 * Create a maneuver node to kill relative velocity with the target.
 * After executing this maneuver, relative velocity with target should be ~0 m/s.
 * Requires a target to be set first.
 *
 * @param conn kOS connection
 * @param timeRef When to execute: 'CLOSEST_APPROACH', 'X_FROM_NOW'
 */
export async function killRelativeVelocity(
  conn: KosConnection,
  timeRef = 'CLOSEST_APPROACH'
): Promise<ManeuverResult> {
  // Check if target is set
  const hasTargetResult = await conn.execute('PRINT HASTARGET.', 2000);
  if (!hasTargetResult.output.includes('True')) {
    return {
      success: false,
      error: 'No target set. Use kos_set_target first.'
    };
  }

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:KILLRELVEL("${timeRef}").`;
  return executeManeuverCommand(conn, cmd);
}
