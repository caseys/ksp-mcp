/**
 * Kill Relative Velocity - Match velocity with target
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { queryNodeInfo, sanitizeError, validateNodeInCurrentPatch, type ManeuverResult } from '../shared.js';
import { validateTarget } from '../../kos/target/validate.js';
import { validateVesselState, ORBITAL_REQUIREMENTS } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, autoTargetSchema } from '../../tool-types.js';
import { formatTime,  fmtVel } from '../../utils/format.js';

/**
 * Create a maneuver node to kill relative velocity with the target.
 * After executing this maneuver, relative velocity with target should be ~0 m/s.
 * Requires a target to be set first.
 *
 * @param conn kOS connection
 * @param timeRef When to execute: 'CLOSEST_APPROACH', 'X_FROM_NOW'
 * @param xFromNowSeconds When using X_FROM_NOW, the time in seconds from now
 */
export async function killRelativeVelocity(
  conn: KosConnection,
  timeRef = 'CLOSEST_APPROACH',
  xFromNowSeconds?: number
): Promise<ManeuverResult> {
  // Validate vessel state: must not be on ground
  const vesselValidation = await validateVesselState(conn, ORBITAL_REQUIREMENTS, 'match_velocities');
  if (!vesselValidation.valid) {
    return { success: false, error: vesselValidation.error };
  }

  // Pre-validate target: must be in same SOI (typically used for vessel rendezvous)
  const validation = await validateTarget(conn, {
    requireSameSOI: true,
  }, 'match_velocities');

  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // Build command - use KILLRELVELTIMED for X_FROM_NOW (thread-safe, no shared state)
  let cmd: string;
  if (timeRef === 'X_FROM_NOW' && xFromNowSeconds !== undefined) {
    cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:KILLRELVELTIMED("${timeRef}", ${xFromNowSeconds}).`;
  } else {
    cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:KILLRELVEL("${timeRef}").`;
  }
  const result = await conn.execute(cmd, 10_000);

  const success = result.output.includes('True');
  if (!success) {
    return { success: false, error: sanitizeError(result.output, 'Match velocities') };
  }

  // Validate node is in current patch
  const patchValidation = await validateNodeInCurrentPatch(conn, 'match_velocities');
  if (!patchValidation.valid) {
    return { success: false, error: patchValidation.error };
  }

  const nodeInfo = await queryNodeInfo(conn);
  return { success: true, deltaV: nodeInfo.deltaV, timeToNode: nodeInfo.timeToNode };
}

// ============================================================================
// Tool Definition
// ============================================================================

export const matchVelocitiesTool: ToolDefinition = {
  name: 'match_velocities',
  description: 'Match speed with target for docking in same SOI.',
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

      const result = await orchestrator.killRelVel(args.timeRef as string, {
        target,
        execute: args.execute as boolean,
        logger,
        callerTool: 'match_velocities',
      });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        let text = `Node: ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, T-${formatTime(result.timeToNode ?? 0)}${execInfo}`;
        if (result.executed) {
          const relVelInfo = await conn.execute('PRINT ROUND((TARGET:VELOCITY:ORBIT - SHIP:VELOCITY:ORBIT):MAG, 1).', 2000);
          const relVel = parseFloat(relVelInfo.output.trim()) || 0;
          text += `\nRelative velocity: ${fmtVel(relVel)}`;
        }
        return ctx.successResponse('match_velocities', text);
      } else {
        return ctx.errorResponse('match_velocities', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('match_velocities', error instanceof Error ? error.message : String(error));
    }
  },
};
