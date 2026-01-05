/**
 * Unified Inclination Tool - Smart routing to change_inclination or match_planes
 *
 * Auto-detects whether to match a target's plane or change to a specific angle.
 * - If target specified/set → match_planes
 * - If angle specified → change_inclination to that angle
 * - Default (no target, no angle) → change_inclination to 0° (equatorial)
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import { hasTarget } from '../../kos/target/index.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, autoTargetSchema } from '../../tool-types.js';
import { formatTime, fmtNum } from '../../utils/format.js';

// ============================================================================
// Tool Definition
// ============================================================================

export const inclinationTool: ToolDefinition = {
  name: 'inclination',
  description: 'Change orbital inclination. If target set, matches target plane. Otherwise changes to specified angle (default: 0° equatorial).',
  inputSchema: {
    target: autoTargetSchema
      .describe('Target name to match planes with. If omitted and no target set, uses angle instead.'),
    angle: z.union([z.number(), z.literal('auto')])
      .optional()
      .default('auto')
      .describe('Target inclination in degrees. Default: 0° (equatorial) if no target, otherwise ignored.'),
    execute: executeSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 1,
  handler: async (args, ctx, extra) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);
      const logger = ctx.createLogger(extra);

      const targetArg = args.target as string | undefined;
      const angleArg = args.angle as number | 'auto' | undefined;

      // Determine which mode to use
      const { mode, target, angle } = await determineInclinationMode(
        conn,
        targetArg,
        angleArg
      );

      let result;
      let responseText: string;

      if (mode === 'match_planes') {
        logger.progress(`[Inclination] Matching orbital plane with target: ${target}`);

        // Set target if specified
        if (target && target !== 'auto') {
          const targetResult = await orchestrator.setTarget(target);
          if (!targetResult.success) {
            return ctx.errorResponse('inclination', targetResult.error ?? `Failed to set target "${target}"`);
          }
        }

        result = await orchestrator.matchPlane('REL_NEAREST_AD', {
          execute: args.execute as boolean,
          logger,
          callerTool: 'inclination',
        });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          responseText = `Match planes: ${result.deltaV != null ? fmtNum(result.deltaV) : '?'} m/sec, T-${formatTime(result.timeToNode ?? 0)}${execInfo}`;

          if (result.warning) {
            responseText += `\n${result.warning}`;
          }

          if (result.executed) {
            const incInfo = await conn.execute('PRINT ROUND(SHIP:ORBIT:INCLINATION, 2) + "|" + ROUND(TARGET:ORBIT:INCLINATION, 2).', 2000);
            const match = incInfo.output.match(/([\d.]+)\|([\d.]+)/);
            if (match) {
              responseText += `\nInclination: ${match[1]}° (target: ${match[2]}°)`;
            }
          }
        } else {
          return ctx.errorResponse('inclination', result.error ?? 'Match planes failed');
        }
      } else {
        // change_inclination mode
        const targetAngle = angle ?? 0;
        logger.progress(`[Inclination] Changing inclination to ${targetAngle}°`);

        result = await orchestrator.changeInclination(targetAngle, 'EQ_NEAREST_AD', {
          execute: args.execute as boolean,
          logger,
          callerTool: 'inclination',
        });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          responseText = `Change inclination to ${targetAngle}°: ${result.deltaV != null ? fmtNum(result.deltaV) : '?'} m/sec, T-${formatTime(result.timeToNode ?? 0)}${execInfo}`;

          if (result.warning) {
            responseText += `\n${result.warning}`;
          }

          if (result.executed) {
            const incInfo = await conn.execute('PRINT ROUND(SHIP:ORBIT:INCLINATION, 1).', 2000);
            const inc = incInfo.output.trim();
            responseText += `\nInclination: ${inc}°`;
          }
        } else {
          return ctx.errorResponse('inclination', result.error ?? 'Change inclination failed');
        }
      }

      return ctx.successResponse('inclination', responseText);
    } catch (error) {
      return ctx.errorResponse('inclination', error instanceof Error ? error.message : String(error));
    }
  },
};

// ============================================================================
// Mode Determination
// ============================================================================

interface InclinationModeResult {
  mode: 'match_planes' | 'change_inclination';
  target?: string;
  angle?: number;
}

/**
 * Determine whether to use match_planes or change_inclination.
 *
 * Priority:
 * 1. If target explicitly specified (not 'auto') → match_planes
 * 2. If angle explicitly specified (not 'auto') → change_inclination
 * 3. If target is 'auto' and a target is already set → match_planes
 * 4. Default → change_inclination to 0° (equatorial)
 */
async function determineInclinationMode(
  conn: KosConnection,
  targetArg: string | undefined,
  angleArg: number | 'auto' | undefined
): Promise<InclinationModeResult> {
  // Case 1: Target explicitly specified
  if (targetArg && targetArg !== 'auto') {
    return { mode: 'match_planes', target: targetArg };
  }

  // Case 2: Angle explicitly specified
  if (angleArg !== undefined && angleArg !== 'auto') {
    return { mode: 'change_inclination', angle: angleArg };
  }

  // Case 3: Check if a target is already set
  const targetSet = await hasTarget(conn);
  if (targetSet) {
    return { mode: 'match_planes' };
  }

  // Case 4: Default to equatorial
  return { mode: 'change_inclination', angle: 0 };
}
