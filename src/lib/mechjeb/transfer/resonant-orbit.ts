/**
 * Resonant Orbit - Create orbit with specific period ratio
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema } from '../../tool-types.js';

/**
 * Create a maneuver node to establish a resonant orbit.
 * Useful for satellite constellations where you want to deploy
 * satellites at evenly spaced intervals.
 *
 * Example: 2:3 resonance means completing 2 orbits while the
 * original position completes 3, allowing periodic rendezvous.
 *
 * @param conn kOS connection
 * @param numerator Numerator of the resonance ratio
 * @param denominator Denominator of the resonance ratio
 * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW'
 */
export async function resonantOrbit(
  conn: KosConnection,
  numerator: number,
  denominator: number,
  timeRef = 'APOAPSIS'
): Promise<ManeuverResult> {
  if (numerator <= 0 || denominator <= 0) {
    return {
      success: false,
      error: `Invalid resonance ratio: ${numerator}:${denominator}. Both values must be positive.`
    };
  }

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:RESONANTORBIT(${numerator}, ${denominator}, "${timeRef}").`;
  return executeManeuverCommand(conn, cmd);
}

// ============================================================================
// Tool Definition
// ============================================================================

export const resonantOrbitTool: ToolDefinition = {
  name: 'resonant_orbit',
  description: 'Create orbit for deploying satellite constellation.',
  inputSchema: {
    numerator: z.number().int().positive().optional().default(2).describe('Numerator of resonance ratio (default: 2 for 2:3)'),
    denominator: z.number().int().positive().optional().default(3).describe('Denominator of resonance ratio (default: 3 for 2:3)'),
    timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW'])
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
      const result = await orchestrator.resonantOrbit(args.numerator as number, args.denominator as number, args.timeRef as string, { execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        return ctx.successResponse('resonant_orbit',
          `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
      } else {
        return ctx.errorResponse('resonant_orbit', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('resonant_orbit', error instanceof Error ? error.message : String(error));
    }
  },
};
