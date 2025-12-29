/**
 * Change Inclination - Tilt orbit
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';
import { validateVesselState, ORBITAL_REQUIREMENTS } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema } from '../../tool-types.js';

/**
 * Create a maneuver node to change orbital inclination.
 *
 * @param conn kOS connection
 * @param newInclination Target inclination in degrees
 * @param timeRef When to execute
 */
export async function changeInclination(
  conn: KosConnection,
  newInclination: number,
  timeRef = 'EQ_NEAREST_AD'
): Promise<ManeuverResult> {
  // Validate vessel state: must not be on ground
  const validation = await validateVesselState(conn, ORBITAL_REQUIREMENTS, 'change_inclination');
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CHANGEINCLINATION(${newInclination}, "${timeRef}").`;
  return executeManeuverCommand(conn, cmd);
}

// ============================================================================
// Tool Definition
// ============================================================================

export const changeInclinationTool: ToolDefinition = {
  name: 'change_inclination',
  description: 'Tilt orbit. Use for polar orbit or equatorial orbit.',
  inputSchema: {
    newInclination: z.number().optional().default(0).describe('Target inclination in degrees (default: 0 for equatorial)'),
    timeRef: z.enum(['EQ_ASCENDING', 'EQ_DESCENDING', 'EQ_NEAREST_AD', 'EQ_HIGHEST_AD', 'X_FROM_NOW'])
      .optional()
      .default('EQ_NEAREST_AD')
      .describe('When to execute: at ascending node, descending node, nearest AN/DN, or highest AD'),
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
      const result = await orchestrator.changeInclination(args.newInclination as number, args.timeRef as string, { execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        return ctx.successResponse('change_inclination',
          `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
      } else {
        return ctx.errorResponse('change_inclination', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('change_inclination', error instanceof Error ? error.message : String(error));
    }
  },
};
