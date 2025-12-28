/**
 * Kill Relative Velocity - Match velocity with target
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { queryNodeInfo, sanitizeError, requireTarget, type ManeuverResult } from '../shared.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, autoTargetSchema } from '../../tool-types.js';

/**
 * Create a maneuver node to kill relative velocity with the target.
 * After executing this maneuver, relative velocity with target should be ~0 m/s.
 * Requires a target to be set first.
 *
 * @param conn kOS connection
 * @param timeRef When to execute: 'CLOSEST_APPROACH', 'X_FROM_NOW'
 */
export async function killRelativeVelocity(
  conn: KosConnection,
  timeRef = 'CLOSEST_APPROACH'
): Promise<ManeuverResult> {
  const targetError = await requireTarget(conn);
  if (targetError) return targetError;

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:KILLRELVEL("${timeRef}").`;
  const result = await conn.execute(cmd, 10_000);

  const success = result.output.includes('True');
  if (!success) {
    return { success: false, error: sanitizeError(result.output, 'Match velocities') };
  }

  const nodeInfo = await queryNodeInfo(conn);
  return { success: true, deltaV: nodeInfo.deltaV, timeToNode: nodeInfo.timeToNode };
}

// ============================================================================
// Tool Definition
// ============================================================================

export const matchVelocitiesTool: ToolDefinition = {
  name: 'match_velocities',
  description: 'Match speed with target for docking. Use at closest approach.',
  inputSchema: {
    target: autoTargetSchema,
    timeRef: z.enum(['CLOSEST_APPROACH', 'X_FROM_NOW'])
      .optional()
      .default('CLOSEST_APPROACH')
      .describe('When to execute: at closest approach or after X seconds'),
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

      // Auto-select closest vessel if not provided
      let target = args.target as string | undefined;
      if (!target) {
        const autoTarget = await ctx.selectTarget(orchestrator, 'closest-vessel');
        if (autoTarget) {
          target = autoTarget;
        }
      }

      const result = await orchestrator.killRelVel(args.timeRef as string, { target, execute: args.execute as boolean });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        return ctx.successResponse('match_velocities',
          `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
      } else {
        return ctx.errorResponse('match_velocities', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('match_velocities', error instanceof Error ? error.message : String(error));
    }
  },
};
