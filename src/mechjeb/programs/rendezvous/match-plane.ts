/**
 * Match Plane - Match orbital plane with target
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';

/**
 * Create a maneuver node to match orbital plane with the target.
 * Requires a target to be set first.
 *
 * @param conn kOS connection
 * @param timeRef When to execute: 'REL_NEAREST_AD', 'REL_HIGHEST_AD', 'REL_ASCENDING', 'REL_DESCENDING'
 */
export async function matchPlane(
  conn: KosConnection,
  timeRef = 'REL_NEAREST_AD'
): Promise<ManeuverResult> {
  // Check if target is set
  const hasTargetResult = await conn.execute('PRINT HASTARGET.', 2000);
  if (!hasTargetResult.output.includes('True')) {
    return {
      success: false,
      error: 'No target set. Use kos_set_target first.'
    };
  }

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:PLANE("${timeRef}").`;
  return executeManeuverCommand(conn, cmd);
}
