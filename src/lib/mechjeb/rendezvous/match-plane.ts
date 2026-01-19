/**
 * Match Plane - Match orbital plane with target
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, checkPostBurnPeriapsis, type ManeuverResult } from '../shared.js';
import { validateTarget } from '../../kos/target/validate.js';
import { validateVesselState, CLEAN_ORBIT_REQUIREMENTS } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, autoTargetSchema } from '../../tool-types.js';
import { formatTime,  fmtVel } from '../../utils/format.js';

/**
 * Create a maneuver node to match orbital plane with the target.
 * Requires a target to be set first.
 *
 * @param conn kOS connection
 * @param timeRef When to execute: 'REL_NEAREST_AD', 'REL_HIGHEST_AD', 'REL_ASCENDING', 'REL_DESCENDING'
 */
export async function matchPlane(
  conn: KosConnection,
  timeRef = 'REL_NEAREST_AD'
): Promise<ManeuverResult> {
  // Validate vessel state: must be in orbit with no encounters
  const vesselValidation = await validateVesselState(conn, CLEAN_ORBIT_REQUIREMENTS, 'match_planes');
  if (!vesselValidation.valid) {
    return { success: false, error: vesselValidation.error };
  }

  // Pre-validate target: must be in same SOI (can be moon, vessel, or even planet if orbiting it)
  const validation = await validateTarget(conn, {
    requireSameSOI: true,
  }, 'match_planes');

  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:PLANE("${timeRef}").`;
  const result = await executeManeuverCommand(conn, cmd, 10_000, 'match_planes');

  // Check for dangerous post-burn trajectory
  if (result.success) {
    result.warning = await checkPostBurnPeriapsis(conn);
  }

  return result;
}

// ============================================================================
// Tool Definition
// ============================================================================

export const matchPlanesTool: ToolDefinition = {
  name: 'match_planes',
  description: 'Align orbit with target for rendezvous or docking in same SOI.',
  inputSchema: {
    target: autoTargetSchema,
    timeRef: z.enum(['REL_NEAREST_AD', 'REL_HIGHEST_AD', 'REL_ASCENDING', 'REL_DESCENDING'])
      .optional()
      .default('REL_NEAREST_AD')
      .describe('When to execute: nearest AN/DN, highest AN/DN, ascending node, or descending node'),
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

      // Auto-select closest vessel if not provided
      let target = args.target as string | undefined;
      if (!target || target === 'auto') {
        const autoTarget = await ctx.selectTarget(orchestrator, 'closest-vessel');
        target = autoTarget ?? undefined;  // Never pass 'auto' to kOS
      }

      const result = await orchestrator.matchPlane(args.timeRef as string, {
        target,
        execute: args.execute as boolean,
        logger,
        callerTool: 'match_planes',
      });

      if (result.success) {
        let text = result.executed
          ? 'Burn complete'
          : `Node: ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, in ${formatTime(result.timeToNode ?? 0)}`;
        if (result.warning) {
          text += `\n${result.warning}`;
        }
        if (result.executed) {
          // Show both inclinations - relative inc is complex to calculate
          const incInfo = await conn.execute('PRINT ROUND(SHIP:ORBIT:INCLINATION, 2) + "|" + ROUND(TARGET:ORBIT:INCLINATION, 2).', 2000);
          const match = incInfo.output.match(/([\d.]+)\|([\d.]+)/);
          if (match) {
            text += `\nInclination: ${match[1]}° (target: ${match[2]}°)`;
          }
        }
        return ctx.successResponse('match_planes', text);
      } else {
        return ctx.errorResponse('match_planes', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('match_planes', error instanceof Error ? error.message : String(error));
    }
  },
};
