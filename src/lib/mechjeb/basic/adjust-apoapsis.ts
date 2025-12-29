/**
 * Adjust Apoapsis - Change orbit high point
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, formatResultingOrbit, type ManeuverResult } from '../shared.js';
import { validateVesselState, STABLE_ORBIT_REQUIREMENTS } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, distanceSchema } from '../../tool-types.js';

/**
 * Create a maneuver node to adjust apoapsis.
 *
 * @param conn kOS connection
 * @param altitude Target apoapsis altitude in meters
 * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'
 */
export async function adjustApoapsis(
  conn: KosConnection,
  altitude: number,
  timeRef = 'PERIAPSIS'
): Promise<ManeuverResult> {
  // Validate vessel state: must be in stable orbit (not escaped, not on ground)
  const validation = await validateVesselState(conn, STABLE_ORBIT_REQUIREMENTS, 'adjust_apoapsis');
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CHANGEAP(${altitude}, "${timeRef}").`;
  return executeManeuverCommand(conn, cmd, 10_000, 'adjust_apoapsis');
}

// ============================================================================
// Tool Definition
// ============================================================================

export const adjustApoapsisTool: ToolDefinition = {
  name: 'adjust_apoapsis',
  description: 'Change orbit high point. Use to raise/lower orbit.',
  inputSchema: {
    altitude: distanceSchema.optional().describe('Target apoapsis altitude in meters (default: current + 10km)'),
    timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
      .optional()
      .default('PERIAPSIS')
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
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);

      // Default altitude: current apoapsis + 10km
      let altitude = args.altitude as number | undefined;
      if (altitude === undefined) {
        const orbitInfo = await ctx.getBasicOrbitInfo(conn);
        altitude = orbitInfo ? orbitInfo.apoapsis + 10_000 : 100_000;
      }

      const result = await orchestrator.adjustApoapsis(altitude, args.timeRef as string, { execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        let text = `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`;
        if (result.executed) {
          text += await formatResultingOrbit(conn);
        }
        return ctx.successResponse('adjust_apoapsis', text);
      } else {
        return ctx.errorResponse('adjust_apoapsis', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('adjust_apoapsis', error instanceof Error ? error.message : String(error));
    }
  },
};
