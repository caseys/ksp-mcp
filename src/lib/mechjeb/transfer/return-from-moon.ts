/**
 * Return From Moon - Transfer back to parent body
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';
import { validateVesselState } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, distanceSchema } from '../../tool-types.js';
import { formatTime, fmtVel, fmtDist } from '../../utils/format.js';
import { warpTo } from '../../kos/warp.js';

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
          // Get moon name and trajectory info before warping
          const trajInfo = await conn.execute(
            'PRINT "RET|" + SHIP:BODY:NAME + "|" + ' +
            '(CHOOSE SHIP:ORBIT:NEXTPATCH:BODY:NAME IF SHIP:ORBIT:HASNEXTPATCH ELSE "?") + "|" + ' +
            '(CHOOSE ROUND(SHIP:ORBIT:NEXTPATCH:PERIAPSIS/1000, 1) IF SHIP:ORBIT:HASNEXTPATCH ELSE 0).',
            3000
          );
          const match = trajInfo.output.match(/RET\|([^|]+)\|([^|]+)\|([\d.-]+)/);

          let moonName = 'Moon';
          let parentBody = 'parent';

          if (match) {
            [, moonName, parentBody] = match;
          }

          logger.progress(`${moonName} escape burn complete. Warping to ${moonName} escape...`);

          // Warp to parent body SOI
          const warpResult = await warpTo(conn, 'soi', {
            leadTime: 10,
            timeout: 300_000,
            logger,
          });

          if (!warpResult.success) {
            return ctx.errorResponse('return_from_moon', `Escape burn complete but warp failed: ${warpResult.error}`);
          }

          // Align to equatorial orbit for optimal reentry
          logger.progress(`Arrived at ${parentBody}. Aligning to equatorial...`);
          const incResult = await orchestrator.changeInclination(0, 'EQ_NEAREST_AD', {
            execute: true,
            logger,
            callerTool: 'ensure_prograde_return',
          });

          if (!incResult.success) {
            // Non-fatal - continue with current inclination
            logger.warn(`[return_from_moon] Inclination change failed: ${incResult.error}`);
          }

          // Get updated trajectory info after SOI transition and inclination change
          const postWarpInfo = await conn.execute(
            'PRINT "POST|" + SHIP:BODY:NAME + "|" + ROUND(PERIAPSIS/1000, 1) + "|" + ' +
            'ROUND(SHIP:BODY:ATM:HEIGHT/1000) + "|" + ROUND(ALTITUDE).',
            3000
          );
          const postMatch = postWarpInfo.output.match(/POST\|([^|]+)\|([\d.-]+)\|(\d+)\|(\d+)/);

          if (postMatch) {
            const [, currentBody, peKmStr, atmKmStr, altStr] = postMatch;
            const peKm = parseFloat(peKmStr);
            const atmKm = parseInt(atmKmStr);
            const altitude = parseInt(altStr);

            // Ideal reentry periapsis is ~30km. 5-55km is acceptable.
            const isGoodPeriapsis = peKm >= 5 && peKm <= 55;
            const peDescriptor = peKm < 5 ? 'steep ' : (peKm > 55 ? 'shallow ' : '');

            let nextStep: string;
            if (atmKm > 0 && peKm > 0 && peKm < atmKm) {
              // Has atmosphere and will reenter
              nextStep = isGoodPeriapsis
                ? 'Align for reentry.'
                : 'Course correct for a more comfortable reentry.';
            } else if (peKm < 0) {
              nextStep = 'CRASH TRAJECTORY! Use crash_avoidance immediately.';
            } else {
              nextStep = 'Circularize to establish orbit.';
            }

            text = `Arrived at ${currentBody}\n` +
                   `Altitude: ${fmtDist(altitude)}, ${peDescriptor}Periapsis: ${peKm}km\n` +
                   `Next: ${nextStep}`;
          } else {
            text = `Arrived at ${warpResult.body ?? parentBody}. Altitude: ${fmtDist(warpResult.altitude ?? 0)}`;
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
