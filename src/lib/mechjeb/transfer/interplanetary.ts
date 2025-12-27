/**
 * Interplanetary Transfer - Plan transfer to another planet
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, requireTarget, getTargetName, type ManeuverResult } from '../shared.js';
import { type McpLogger, nullLogger } from '../../tool-types.js';

export interface InterplanetaryOptions {
  waitForPhaseAngle?: boolean;
  logger?: McpLogger;
}

/**
 * Create a maneuver node for an interplanetary transfer.
 * Requires a target planet to be set first.
 *
 * @param conn kOS connection
 * @param options Transfer options including waitForPhaseAngle and logger
 */
export async function interplanetaryTransfer(
  conn: KosConnection,
  options: InterplanetaryOptions = {}
): Promise<ManeuverResult> {
  const { waitForPhaseAngle = true, logger } = options;
  const log = logger ?? nullLogger;

  const targetError = await requireTarget(conn);
  if (targetError) return targetError;

  const targetName = await getTargetName(conn);

  if (waitForPhaseAngle) {
    log.progress(`[Transfer] Planning interplanetary transfer to ${targetName} (waiting for optimal phase angle)...`);
  } else {
    log.progress(`[Transfer] Planning immediate transfer to ${targetName}...`);
  }

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:INTERPLANETARY(${waitForPhaseAngle ? 'TRUE' : 'FALSE'}).`;
  const result = await executeManeuverCommand(conn, cmd);

  if (result.success) {
    log.progress(`[Transfer] Transfer node created to ${targetName}`);
  }

  return result;
}
