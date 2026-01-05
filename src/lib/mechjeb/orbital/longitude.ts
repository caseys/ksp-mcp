/**
 * Longitude of Periapsis - Change where periapsis occurs in the orbit
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';
import { validateVesselState, CLEAN_ORBIT_REQUIREMENTS } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema } from '../../tool-types.js';
import { formatTime, fmtNum } from '../../utils/format.js';

/**
 * Create a maneuver node to change the Longitude of Periapsis.
 * This rotates the orbit so periapsis occurs at the specified longitude.
 *
 * @param conn kOS connection
 * @param newLong Target longitude in degrees (-180 to 180)
 * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'
 */
export async function changeLongitudeOfPeriapsis(
  conn: KosConnection,
  newLong: number,
  timeRef = 'APOAPSIS'
): Promise<ManeuverResult> {
  // Validate vessel state: must be in orbit with no encounters
  const validation = await validateVesselState(conn, CLEAN_ORBIT_REQUIREMENTS, 'change_periapsis_longitude');
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:LONGITUDE(${newLong}, "${timeRef}").`;
  return executeManeuverCommand(conn, cmd, 10_000, 'change_periapsis_longitude');
}

// ============================================================================
// Tool Definition
// ============================================================================

export const changePeriapsisLongitudeTool: ToolDefinition = {
  name: 'change_periapsis_longitude',
  description: 'Rotate orbit orientation. Advanced.',
  inputSchema: {
    longitude: z.number().optional().default(90).describe('Target longitude in degrees (-180 to 180, default: 90)'),
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
  tier: 2,
  handler: async (args, ctx, extra) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);
      const logger = ctx.createLogger(extra);
      const result = await orchestrator.changeLongitude(args.longitude as number, args.timeRef as string, {
        execute: args.execute as boolean,
        logger,
        callerTool: 'change_periapsis_longitude',
      });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        let text = `Node: ${result.deltaV != null ? fmtNum(result.deltaV) : '?'} m/sec, T-${formatTime(result.timeToNode ?? 0)}${execInfo}`;
        if (result.executed) {
          const argPeInfo = await conn.execute('PRINT ROUND(SHIP:ORBIT:ARGUMENTOFPERIAPSIS, 2).', 2000);
          const argPe = argPeInfo.output.trim();
          text += `\nArgument of periapsis: ${argPe}°`;
        }
        return ctx.successResponse('change_periapsis_longitude', text);
      } else {
        return ctx.errorResponse('change_periapsis_longitude', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('change_periapsis_longitude', error instanceof Error ? error.message : String(error));
    }
  },
};
