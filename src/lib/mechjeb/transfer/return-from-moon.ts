/**
 * Return From Moon - Transfer back to parent body
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';
import { validateVesselState } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, distanceSchema } from '../../tool-types.js';

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
  description: 'Return from Mun/Minmus to Kerbin. Sets up reentry trajectory.',
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
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);
      const result = await orchestrator.returnFromMoon(args.targetPeriapsis as number, { execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        return ctx.successResponse('return_from_moon',
          `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
      } else {
        return ctx.errorResponse('return_from_moon', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('return_from_moon', error instanceof Error ? error.message : String(error));
    }
  },
};
