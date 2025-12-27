/**
 * Match Plane - Match orbital plane with target
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, requireTarget, type ManeuverResult } from '../shared.js';

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
  const targetError = await requireTarget(conn);
  if (targetError) return targetError;

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:PLANE("${timeRef}").`;
  return executeManeuverCommand(conn, cmd);
}
