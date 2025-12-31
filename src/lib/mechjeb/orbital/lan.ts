/**
 * LAN - Change Longitude of Ascending Node
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';
import { validateVesselState, CLEAN_ORBIT_REQUIREMENTS } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema } from '../../tool-types.js';

/**
 * Create a maneuver node to change the Longitude of Ascending Node (LAN).
 * The LAN determines where the orbit crosses the equatorial plane northward.
 *
 * @param conn kOS connection
 * @param newLan Target LAN in degrees (0 to 360)
 * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'
 */
export async function changeLAN(
  conn: KosConnection,
  newLan: number,
  timeRef = 'APOAPSIS'
): Promise<ManeuverResult> {
  // Validate vessel state: must be in orbit with no encounters
  const validation = await validateVesselState(conn, CLEAN_ORBIT_REQUIREMENTS, 'change_ascending_node');
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:LAN(${newLan}, "${timeRef}").`;
  return executeManeuverCommand(conn, cmd, 10_000, 'change_ascending_node');
}

// ============================================================================
// Tool Definition
// ============================================================================

export const changeAscendingNodeTool: ToolDefinition = {
  name: 'change_ascending_node',
  description: 'Change LAN. Advanced orbital adjustment.',
  inputSchema: {
    lan: z.number().optional().default(90).describe('Target LAN in degrees (0 to 360, default: 90)'),
    timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
      .optional()
      .default('APOAPSIS')
      .describe('When to execute the maneuver'),
    execute: executeSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 3,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);
      const result = await orchestrator.changeLAN(args.lan as number, args.timeRef as string, { execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        let text = `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`;
        if (result.executed) {
          const lanInfo = await conn.execute('PRINT ROUND(SHIP:ORBIT:LAN, 2).', 2000);
          const lan = lanInfo.output.trim();
          text += `\nLAN: ${lan}°`;
        }
        return ctx.successResponse('change_ascending_node', text);
      } else {
        return ctx.errorResponse('change_ascending_node', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('change_ascending_node', error instanceof Error ? error.message : String(error));
    }
  },
};
