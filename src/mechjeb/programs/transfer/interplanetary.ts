/**
 * Interplanetary Transfer - Plan transfer to another planet
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';

/**
 * Create a maneuver node for an interplanetary transfer.
 * Requires a target planet to be set first.
 *
 * @param conn kOS connection
 * @param waitForPhaseAngle If true, waits for optimal phase angle. If false, transfers immediately.
 */
export async function interplanetaryTransfer(
  conn: KosConnection,
  waitForPhaseAngle = true
): Promise<ManeuverResult> {
  // Check if target is set
  const hasTargetResult = await conn.execute('PRINT HASTARGET.', 2000);
  if (!hasTargetResult.output.includes('True')) {
    return {
      success: false,
      error: 'No target set. Use kos_set_target first.'
    };
  }

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:INTERPLANETARY(${waitForPhaseAngle ? 'TRUE' : 'FALSE'}).`;
  return executeManeuverCommand(conn, cmd);
}
