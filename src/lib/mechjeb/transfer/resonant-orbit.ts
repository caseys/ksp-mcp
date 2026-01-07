/**
 * Resonant Orbit - Create orbit with specific period ratio
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';
import { validateVesselState, ORBITAL_REQUIREMENTS } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema } from '../../tool-types.js';
import { formatTime, fmtNum } from '../../utils/format.js';

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
 * @param xFromNowSeconds When using X_FROM_NOW, the time in seconds from now
 */
export async function resonantOrbit(
  conn: KosConnection,
  numerator: number,
  denominator: number,
  timeRef = 'APOAPSIS',
  xFromNowSeconds?: number
): Promise<ManeuverResult> {
  // Validate vessel state: must not be on ground
  const validation = await validateVesselState(conn, ORBITAL_REQUIREMENTS, 'resonant_orbit');
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  if (numerator <= 0 || denominator <= 0) {
    return {
      success: false,
      error: `Invalid resonance ratio: ${numerator}:${denominator}. Both values must be positive.`
    };
  }

  // Build command - use RESONANTORBITTIMED for X_FROM_NOW (thread-safe, no shared state)
  let cmd: string;
  if (timeRef === 'X_FROM_NOW' && xFromNowSeconds !== undefined) {
    cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:RESONANTORBITTIMED(${numerator}, ${denominator}, "${timeRef}", ${xFromNowSeconds}).`;
  } else {
    cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:RESONANTORBIT(${numerator}, ${denominator}, "${timeRef}").`;
  }
  return executeManeuverCommand(conn, cmd, 10_000, 'resonant_orbit');
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
  handler: async (args, ctx, extra) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);
      const logger = ctx.createLogger(extra);
      const result = await orchestrator.resonantOrbit(args.numerator as number, args.denominator as number, args.timeRef as string, {
        execute: args.execute as boolean,
        logger,
        callerTool: 'resonant_orbit',
      });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        let text = `Node: ${result.deltaV != null ? fmtNum(result.deltaV) : '?'} m/sec, T-${formatTime(result.timeToNode ?? 0)}${execInfo}`;
        if (result.executed) {
          const orbitInfo = await conn.execute('PRINT ROUND(SHIP:ORBIT:PERIOD, 1) + "|" + ROUND(APOAPSIS/1000, 1).', 2000);
          const match = orbitInfo.output.match(/([\d.]+)\|([\d.]+)/);
          if (match) {
            text += `\nNew orbit: period ${match[1]}s, apoapsis ${match[2]}km`;
          }
        }
        return ctx.successResponse('resonant_orbit', text);
      } else {
        return ctx.errorResponse('resonant_orbit', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('resonant_orbit', error instanceof Error ? error.message : String(error));
    }
  },
};
