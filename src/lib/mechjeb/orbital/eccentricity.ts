/**
 * Eccentricity - Change orbital eccentricity
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';
import { validateVesselState, CLEAN_ORBIT_REQUIREMENTS } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema } from '../../tool-types.js';
import { formatTime,  fmtVel } from '../../utils/format.js';

/**
 * Create a maneuver node to change orbital eccentricity.
 * Eccentricity ranges from 0 (circular) to just under 1 (parabolic).
 *
 * @param conn kOS connection
 * @param newEcc Target eccentricity (0 to <1)
 * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'
 * @param xFromNowSeconds When using X_FROM_NOW, the time in seconds from now (default: 30)
 */
export async function changeEccentricity(
  conn: KosConnection,
  newEcc: number,
  timeRef = 'APOAPSIS',
  xFromNowSeconds?: number
): Promise<ManeuverResult> {
  // Validate vessel state: must be in orbit with no encounters
  const validation = await validateVesselState(conn, CLEAN_ORBIT_REQUIREMENTS, 'change_eccentricity');
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  if (newEcc < 0 || newEcc >= 1) {
    return {
      success: false,
      error: `Invalid eccentricity: ${newEcc}. Must be between 0 (circular) and 1 (parabolic).`
    };
  }

  // Build command - use ECCENTRICITYTIMED for X_FROM_NOW (thread-safe, no shared state)
  let cmd: string;
  if (timeRef === 'X_FROM_NOW' && xFromNowSeconds !== undefined) {
    // ECCENTRICITYTIMED: 3-arg form that passes seconds directly (thread-safe)
    cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:ECCENTRICITYTIMED(${newEcc}, "${timeRef}", ${xFromNowSeconds}).`;
  } else {
    // ECCENTRICITY: standard 2-arg form
    cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:ECCENTRICITY(${newEcc}, "${timeRef}").`;
  }
  return executeManeuverCommand(conn, cmd, 10_000, 'change_eccentricity');
}

// ============================================================================
// Tool Definition
// ============================================================================

export const changeEccentricityTool: ToolDefinition = {
  name: 'change_eccentricity',
  description: 'Change orbit shape (0=circular).',
  inputSchema: {
    eccentricity: z.number().min(0).max(0.99).optional().default(0).describe('Target eccentricity (0 = circular, <1 = elliptical, default: 0)'),
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
      const result = await orchestrator.changeEccentricity(args.eccentricity as number, args.timeRef as string, {
        execute: args.execute as boolean,
        logger,
        callerTool: 'change_eccentricity',
      });

      if (result.success) {
        let text = result.executed
          ? 'Burn complete'
          : `Node: ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, in ${formatTime(result.timeToNode ?? 0)}`;
        if (result.executed) {
          const eccInfo = await conn.queue('PRINT ROUND(SHIP:ORBIT:ECCENTRICITY, 4).', 2000);
          const ecc = eccInfo.success ? eccInfo.output : '?';
          text += `\nEccentricity: ${ecc}`;
        }
        return ctx.successResponse('change_eccentricity', text);
      } else {
        return ctx.errorResponse('change_eccentricity', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('change_eccentricity', error instanceof Error ? error.message : String(error));
    }
  },
};
