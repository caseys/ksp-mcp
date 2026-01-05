/**
 * Ellipticize - Set both periapsis and apoapsis in a single burn
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, formatResultingOrbit, type ManeuverResult } from '../shared.js';
import { validateVesselState, ORBITAL_REQUIREMENTS } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, distanceSchema } from '../../tool-types.js';
import { formatTime, fmtNum } from '../../utils/format.js';

/**
 * Create a maneuver node to set both periapsis and apoapsis.
 * More efficient than separate Pe/Ap burns when changing both.
 *
 * @param conn kOS connection
 * @param newPeA Target periapsis altitude in meters
 * @param newApA Target apoapsis altitude in meters
 * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'
 */
export async function ellipticize(
  conn: KosConnection,
  newPeA: number,
  newApA: number,
  timeRef = 'APOAPSIS'
): Promise<ManeuverResult> {
  // Validate vessel state: must not be on ground
  const validation = await validateVesselState(conn, ORBITAL_REQUIREMENTS, 'ellipticize');
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:ELLIPTICIZE(${newPeA}, ${newApA}, "${timeRef}").`;
  return executeManeuverCommand(conn, cmd, 10_000, 'ellipticize');
}

// ============================================================================
// Tool Definition
// ============================================================================

export const ellipticizeTool: ToolDefinition = {
  name: 'ellipticize',
  description: 'Set both orbit high and low points in one maneuver.',
  inputSchema: {
    periapsis: z.union([distanceSchema, z.literal('auto')])
      .optional()
      .default('auto')
      .describe('Target periapsis altitude in meters (default: current periapsis)'),
    apoapsis: z.union([distanceSchema, z.literal('auto')])
      .optional()
      .default('auto')
      .describe('Target apoapsis altitude in meters (default: current apoapsis)'),
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

      // Resolve 'auto' to current orbital parameters
      const peArg = args.periapsis as number | 'auto';
      const apArg = args.apoapsis as number | 'auto';
      let periapsis: number;
      let apoapsis: number;
      if (peArg === 'auto' || apArg === 'auto') {
        const orbitInfo = await ctx.getBasicOrbitInfo(conn);
        periapsis = peArg === 'auto' ? (orbitInfo?.periapsis ?? 70_000) : peArg;
        apoapsis = apArg === 'auto' ? (orbitInfo?.apoapsis ?? 70_000) : apArg;
      } else {
        periapsis = peArg;
        apoapsis = apArg;
      }

      const result = await orchestrator.ellipticize(periapsis, apoapsis, args.timeRef as string, {
        execute: args.execute as boolean,
        logger,
        callerTool: 'ellipticize',
      });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        let text = `Node: ${result.deltaV != null ? fmtNum(result.deltaV) : '?'} m/sec, T-${formatTime(result.timeToNode ?? 0)}${execInfo}`;
        if (result.executed) {
          text += await formatResultingOrbit(conn);
        }
        return ctx.successResponse('ellipticize', text);
      } else {
        return ctx.errorResponse('ellipticize', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('ellipticize', error instanceof Error ? error.message : String(error));
    }
  },
};
