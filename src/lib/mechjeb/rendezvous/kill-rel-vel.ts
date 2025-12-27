/**
 * Kill Relative Velocity - Match velocity with target
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, requireTarget, type ManeuverResult } from '../shared.js';

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
  const targetError = await requireTarget(conn);
  if (targetError) return targetError;

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:KILLRELVEL("${timeRef}").`;
  return executeManeuverCommand(conn, cmd);
}
