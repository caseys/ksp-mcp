/**
 * Circularize - Make orbit circular at current altitude
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema } from '../../tool-types.js';

/**
 * Create a maneuver node to circularize the orbit.
 *
 * @param conn kOS connection
 * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW'
 */
export async function circularize(
  conn: KosConnection,
  timeRef = 'APOAPSIS'
): Promise<ManeuverResult> {
  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CIRCULARIZE("${timeRef}").`;
  return executeManeuverCommand(conn, cmd);
}

// ============================================================================
// Tool Definition
// ============================================================================

export const circularizeTool: ToolDefinition = {
  name: 'circularize',
  description: 'Make orbit circular. Use after launch or transfer.',
  inputSchema: {
    timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW'])
      .optional()
      .describe('When to circularize. If omitted, auto-picks based on orbit (periapsis for hyperbolic, nearest apse for elliptical)'),
    execute: executeSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 1,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();

      // Auto-detect best timeRef if not specified
      let timeRef = args.timeRef as string | undefined;
      if (!timeRef) {
        const orbitInfo = await conn.execute(
          'PRINT SHIP:ORBIT:ECCENTRICITY + "|" + ETA:APOAPSIS + "|" + ETA:PERIAPSIS.'
        );
        const parts = orbitInfo.output.split('|').map(s => Number.parseFloat(s.trim()));
        const [ecc, etaApo, etaPe] = parts;

        if (ecc >= 1) {
          timeRef = 'PERIAPSIS';  // Hyperbolic orbit - no apoapsis
        } else {
          timeRef = etaApo < etaPe ? 'APOAPSIS' : 'PERIAPSIS';  // Nearest apse
        }
      }

      const orchestrator = new ManeuverOrchestrator(conn);
      const result = await orchestrator.circularize(timeRef, { execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        return ctx.successResponse('circularize',
          `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
      } else {
        return ctx.errorResponse('circularize', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('circularize', error instanceof Error ? error.message : String(error));
    }
  },
};
