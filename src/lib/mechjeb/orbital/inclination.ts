/**
 * Change Inclination - Tilt orbit
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, checkPostBurnPeriapsis, type ManeuverResult } from '../shared.js';
import { validateVesselState, CLEAN_ORBIT_REQUIREMENTS } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema } from '../../tool-types.js';
import { formatTime,  fmtVel } from '../../utils/format.js';

/**
 * Create a maneuver node to change orbital inclination.
 *
 * @param conn kOS connection
 * @param newInclination Target inclination in degrees
 * @param timeRef When to execute
 * @param xFromNowSeconds When using X_FROM_NOW, the time in seconds from now
 */
export async function changeInclination(
  conn: KosConnection,
  newInclination: number,
  timeRef = 'EQ_NEAREST_AD',
  xFromNowSeconds?: number
): Promise<ManeuverResult> {
  // Validate vessel state: must be in orbit with no encounters
  const validation = await validateVesselState(conn, CLEAN_ORBIT_REQUIREMENTS, 'change_inclination');
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // Build command - use CHANGEINCLINATIONTIMED for X_FROM_NOW (thread-safe, no shared state)
  let cmd: string;
  if (timeRef === 'X_FROM_NOW' && xFromNowSeconds !== undefined) {
    cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CHANGEINCLINATIONTIMED(${newInclination}, "${timeRef}", ${xFromNowSeconds}).`;
  } else {
    cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CHANGEINCLINATION(${newInclination}, "${timeRef}").`;
  }
  const result = await executeManeuverCommand(conn, cmd, 10_000, 'change_inclination');

  // Check for dangerous post-burn trajectory
  if (result.success) {
    result.warning = await checkPostBurnPeriapsis(conn);
  }

  return result;
}

// ============================================================================
// Tool Definition
// ============================================================================

export const changeInclinationTool: ToolDefinition = {
  name: 'change_inclination',
  description: 'Change angle of orbit plane angle.',
  inputSchema: {
    newInclination: z.number().optional().default(0).describe('Target inclination in degrees (default: 0 for equatorial)'),
    timeRef: z.enum(['EQ_ASCENDING', 'EQ_DESCENDING', 'EQ_NEAREST_AD', 'EQ_HIGHEST_AD', 'X_FROM_NOW'])
      .optional()
      .default('EQ_NEAREST_AD')
      .describe('When to execute: at nearest AN/DN (defualt), ascending node, descending node, highest AD'),
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
      const result = await orchestrator.changeInclination(args.newInclination as number, args.timeRef as string, {
        execute: args.execute as boolean,
        logger,
        callerTool: 'change_inclination',
      });

      if (result.success) {
        let text = result.executed
          ? 'Burn complete'
          : `Node: ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, T-${formatTime(result.timeToNode ?? 0)}`;
        if (result.warning) {
          text += `\n${result.warning}`;
        }
        if (result.executed) {
          const incInfo = await conn.execute('PRINT ROUND(SHIP:ORBIT:INCLINATION, 1).', 2000);
          const inc = incInfo.output.trim();
          text += `\nInclination: ${inc}°`;
        }
        return ctx.successResponse('change_inclination', text);
      } else {
        return ctx.errorResponse('change_inclination', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('change_inclination', error instanceof Error ? error.message : String(error));
    }
  },
};
