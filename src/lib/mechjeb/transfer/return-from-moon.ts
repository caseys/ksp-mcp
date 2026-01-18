/**
 * Return From Moon - Transfer back to parent body
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';
import { validateVesselState } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, distanceSchema } from '../../tool-types.js';
import { formatTime,  fmtVel } from '../../utils/format.js';

/**
 * Create a maneuver node to return from a moon to its parent body.
 * Only works when orbiting a moon (e.g., Mun, Minmus).
 *
 * @param conn kOS connection
 * @param targetPeriapsis Target periapsis at parent body in meters (e.g., 100000 for 100km at Kerbin)
 */
export async function returnFromMoon(
  conn: KosConnection,
  targetPeriapsis: number
): Promise<ManeuverResult> {
  // Validate vessel state: must be orbiting a moon
  const validation = await validateVesselState(conn, {
    forbiddenStatuses: ['prelaunch', 'landed', 'splashed'],
    requireAtMoon: true,
  }, 'return_from_moon');

  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:MOONRETURN(${targetPeriapsis}).`;
  return executeManeuverCommand(conn, cmd);
}

// ============================================================================
// Tool Definition
// ============================================================================

export const returnFromMoonTool: ToolDefinition = {
  name: 'return_from_moon',
  description: 'Leave moon orbit to return to parent body SOI.',
  inputSchema: {
    targetPeriapsis: distanceSchema.optional().default(40_000).describe('Target periapsis at parent body in meters (default: 40km)'),
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
      const result = await orchestrator.returnFromMoon(args.targetPeriapsis as number, {
        execute: args.execute as boolean,
        logger,
        callerTool: 'return_from_moon',
      });

      if (result.success) {
        let text: string;
        if (result.executed) {
          // Show moon name and return trajectory info
          const trajInfo = await conn.execute(
            'PRINT "RET|" + SHIP:BODY:NAME + "|" + ' +
            '(CHOOSE SHIP:ORBIT:NEXTPATCH:BODY:NAME IF SHIP:ORBIT:HASNEXTPATCH ELSE "?") + "|" + ' +
            '(CHOOSE ROUND(SHIP:ORBIT:NEXTPATCH:PERIAPSIS/1000, 1) IF SHIP:ORBIT:HASNEXTPATCH ELSE 0).',
            3000
          );
          const match = trajInfo.output.match(/RET\|([^|]+)\|([^|]+)\|([\d.-]+)/);
          if (match) {
            const [, moonName, parentBody, peKm] = match;
            const peKmNum = parseFloat(peKm);

            // Ideal reentry periapsis is ~30km. 5-55km is acceptable.
            const isGoodPeriapsis = peKmNum >= 5 && peKmNum <= 55;
            const peDescriptor = peKmNum < 5 ? 'steep ' : (peKmNum > 55 ? 'shallow ' : '');
            const nextStep = isGoodPeriapsis
              ? `Warp to ${parentBody} and align for reentry.`
              : 'Course correct for a more comfortable reentry.';

            text = `${moonName} escape burn complete\n` +
                   `Return trajectory: ${parentBody} reentry with ${peDescriptor}periapsis ${peKm}km\n` +
                   `Next: ${nextStep}`;
          } else {
            text = 'Escape burn complete';
          }
        } else {
          text = `Node: ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, in ${formatTime(result.timeToNode ?? 0)}`;
        }
        return ctx.successResponse('return_from_moon', text);
      } else {
        return ctx.errorResponse('return_from_moon', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('return_from_moon', error instanceof Error ? error.message : String(error));
    }
  },
};
