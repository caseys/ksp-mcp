/**
 * Interplanetary Transfer - Plan transfer to another planet
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';

/**
 * Helper to log and send progress notifications.
 */
function logProgress(message: string, onProgress?: (msg: string) => void): void {
  console.error(message);
  onProgress?.(message);
}

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

  // Check if target is set
  const hasTargetResult = await conn.execute('PRINT HASTARGET.', 2000);
  if (!hasTargetResult.output.includes('True')) {
    return {
      success: false,
      error: 'No target set. Use kos_set_target first.'
    };
  }

  // Get target name for logging
  const targetResult = await conn.execute('PRINT TARGET:NAME.', 2000);
  const targetName = targetResult.output.trim().replace(/[>\s]+$/, '');

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
