/**
 * Adjust Periapsis - Change orbit low point
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, formatResultingOrbit, type ManeuverResult } from '../shared.js';
import { validateVesselState, ORBITAL_REQUIREMENTS } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, distanceSchema } from '../../tool-types.js';
import { formatTime,  fmtVel } from '../../utils/format.js';

/**
 * Create a maneuver node to adjust periapsis.
 *
 * @param conn kOS connection
 * @param altitude Target periapsis altitude in meters
 * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'
 * @param xFromNowSeconds When using X_FROM_NOW, the time in seconds from now
 */
export async function adjustPeriapsis(
  conn: KosConnection,
  altitude: number,
  timeRef = 'APOAPSIS',
  xFromNowSeconds?: number
): Promise<ManeuverResult> {
  // Validate vessel state: must not be on ground
  const validation = await validateVesselState(conn, ORBITAL_REQUIREMENTS, 'adjust_periapsis');
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // Build command - use CHANGEPETIMED for X_FROM_NOW (thread-safe, no shared state)
  let cmd: string;
  if (timeRef === 'X_FROM_NOW' && xFromNowSeconds !== undefined) {
    cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CHANGEPETIMED(${altitude}, "${timeRef}", ${xFromNowSeconds}).`;
  } else {
    cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CHANGEPE(${altitude}, "${timeRef}").`;
  }
  return executeManeuverCommand(conn, cmd, 10_000, 'adjust_periapsis');
}

// ============================================================================
// Tool Definition
// ============================================================================

export const adjustPeriapsisTool: ToolDefinition = {
  name: 'adjust_periapsis',
  description: 'Change orbit low point. Use for deorbit or orbit adjustments.',
  inputSchema: {
    altitude: z.union([distanceSchema, z.literal('auto')])
      .optional()
      .default('auto')
      .describe('Target periapsis altitude in meters (default: current - 10km)'),
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

      // Resolve 'auto' altitude: current periapsis - 10km (minimum 0)
      const altArg = args.altitude as number | 'auto';
      let altitude: number;
      if (altArg === 'auto') {
        const orbitInfo = await ctx.getBasicOrbitInfo(conn);
        altitude = orbitInfo ? Math.max(0, orbitInfo.periapsis - 10_000) : 50_000;
      } else {
        altitude = altArg;
      }

      const result = await orchestrator.adjustPeriapsis(altitude, args.timeRef as string, {
        execute: args.execute as boolean,
        logger,
        callerTool: 'adjust_periapsis',
      });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        let text = `Node: ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, T-${formatTime(result.timeToNode ?? 0)}${execInfo}`;
        if (result.executed) {
          text += await formatResultingOrbit(conn);
        }
        return ctx.successResponse('adjust_periapsis', text);
      } else {
        return ctx.errorResponse('adjust_periapsis', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('adjust_periapsis', error instanceof Error ? error.message : String(error));
    }
  },
};
