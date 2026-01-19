/**
 * Semi-Major Axis - Change orbital semi-major axis
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, distanceSchema } from '../../tool-types.js';
import { formatTime,  fmtVel } from '../../utils/format.js';

/**
 * Create a maneuver node to change the orbital semi-major axis.
 * The semi-major axis determines the orbital period.
 *
 * @param conn kOS connection
 * @param newSma Target semi-major axis in meters
 * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'
 * @param xFromNowSeconds When using X_FROM_NOW, the time in seconds from now
 */
export async function changeSemiMajorAxis(
  conn: KosConnection,
  newSma: number,
  timeRef = 'APOAPSIS',
  xFromNowSeconds?: number
): Promise<ManeuverResult> {
  // Build command - use SEMIMAJORTIMED for X_FROM_NOW (thread-safe, no shared state)
  let cmd: string;
  if (timeRef === 'X_FROM_NOW' && xFromNowSeconds !== undefined) {
    cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:SEMIMAJORTIMED(${newSma}, "${timeRef}", ${xFromNowSeconds}).`;
  } else {
    cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:SEMIMAJOR(${newSma}, "${timeRef}").`;
  }
  return executeManeuverCommand(conn, cmd, 10_000, 'change_semi_major_axis');
}

// ============================================================================
// Tool Definition
// ============================================================================

export const changeSemiMajorAxisTool: ToolDefinition = {
  name: 'change_semi_major_axis',
  description: 'Change orbital period.',
  inputSchema: {
    semiMajorAxis: distanceSchema.optional().default(1_000_000).describe('Target semi-major axis in meters (default: 1000km)'),
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
  tier: -1,
  handler: async (args, ctx, extra) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);
      const logger = ctx.createLogger(extra);
      const result = await orchestrator.changeSemiMajorAxis(args.semiMajorAxis as number, args.timeRef as string, {
        execute: args.execute as boolean,
        logger,
        callerTool: 'change_semi_major_axis',
      });

      if (result.success) {
        let text = result.executed
          ? 'Burn complete'
          : `Node: ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, in ${formatTime(result.timeToNode ?? 0)}`;
        if (result.executed) {
          const periodInfo = await conn.execute('PRINT ROUND(SHIP:ORBIT:PERIOD, 1).', 2000);
          const period = periodInfo.output.trim();
          text += `\nOrbital period: ${period}s`;
        }
        return ctx.successResponse('change_semi_major_axis', text);
      } else {
        return ctx.errorResponse('change_semi_major_axis', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('change_semi_major_axis', error instanceof Error ? error.message : String(error));
    }
  },
};
