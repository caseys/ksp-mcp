/**
 * Interplanetary Transfer - Plan transfer to another planet
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, requireTarget, getTargetName, type ManeuverResult } from '../shared.js';
import { logProgress } from '../../utils/progress.js';

export interface InterplanetaryOptions {
  waitForPhaseAngle?: boolean;
  onProgress?: (message: string) => void;
}

/**
 * Create a maneuver node for an interplanetary transfer.
 * Requires a target planet to be set first.
 *
 * @param conn kOS connection
 * @param options Transfer options including waitForPhaseAngle and onProgress callback
 */
export async function interplanetaryTransfer(
  conn: KosConnection,
  options: InterplanetaryOptions = {}
): Promise<ManeuverResult> {
  const { waitForPhaseAngle = true, onProgress } = options;
  const log = (msg: string) => logProgress(msg, onProgress);

  const targetError = await requireTarget(conn);
  if (targetError) return targetError;

  const targetName = await getTargetName(conn);

  if (waitForPhaseAngle) {
    log(`[Transfer] Planning interplanetary transfer to ${targetName} (waiting for optimal phase angle)...`);
  } else {
    log(`[Transfer] Planning immediate transfer to ${targetName}...`);
  }

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:INTERPLANETARY(${waitForPhaseAngle ? 'TRUE' : 'FALSE'}).`;
  const result = await executeManeuverCommand(conn, cmd);

  if (result.success) {
    log(`[Transfer] Transfer node created to ${targetName}`);
  }

  return result;
}
