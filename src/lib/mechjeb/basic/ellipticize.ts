/**
 * Ellipticize - Set both periapsis and apoapsis in a single burn
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, distanceSchema } from '../../tool-types.js';

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
  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:ELLIPTICIZE(${newPeA}, ${newApA}, "${timeRef}").`;
  return executeManeuverCommand(conn, cmd);
}

// ============================================================================
// Tool Definition
// ============================================================================

export const ellipticizeTool: ToolDefinition = {
  name: 'ellipticize',
  description: 'Set both orbit high and low points in one maneuver.',
  inputSchema: {
    periapsis: distanceSchema.optional().describe('Target periapsis altitude in meters (default: current periapsis)'),
    apoapsis: distanceSchema.optional().describe('Target apoapsis altitude in meters (default: current apoapsis)'),
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
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);

      // Default to current orbital parameters
      let periapsis = args.periapsis as number | undefined;
      let apoapsis = args.apoapsis as number | undefined;
      if (periapsis === undefined || apoapsis === undefined) {
        const orbitInfo = await ctx.getBasicOrbitInfo(conn);
        if (orbitInfo) {
          periapsis = periapsis ?? orbitInfo.periapsis;
          apoapsis = apoapsis ?? orbitInfo.apoapsis;
        } else {
          periapsis = periapsis ?? 70_000;
          apoapsis = apoapsis ?? 70_000;
        }
      }

      const result = await orchestrator.ellipticize(periapsis, apoapsis, args.timeRef as string, { execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        return ctx.successResponse('ellipticize',
          `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
      } else {
        return ctx.errorResponse('ellipticize', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('ellipticize', error instanceof Error ? error.message : String(error));
    }
  },
};
