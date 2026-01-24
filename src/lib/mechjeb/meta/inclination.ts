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
import { clearNodes } from '../../kos/nodes.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, autoTargetSchema } from '../../tool-types.js';
import { formatTime,  fmtVel } from '../../utils/format.js';

// ============================================================================
// Tool Definition
// ============================================================================

export const inclinationTool: ToolDefinition = {
  name: 'inclination',
  description: 'Change inclination to match target or specified angle.',
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

      // Clear any leftover nodes from failed operations
      await clearNodes(conn);

      const targetArg = args.target as string | undefined;
      const angleArg = args.angle as number | 'auto' | undefined;

      // Determine which mode to use
      const { mode, target, angle } = await determineInclinationMode(
        conn,
        targetArg,
        angleArg
      );

      // Check current inclination to see if change is needed
      const incCheck = await conn.queue('PRINT ROUND(SHIP:ORBIT:INCLINATION, 2).', 2000);
      const currentInc = incCheck.success ? Number.parseFloat(incCheck.output.match(/[\d.]+/)?.[0] ?? '0') : 0;
      const INCLINATION_TOLERANCE = 0.5; // 0.5 degree tolerance

      let result;
      let responseText: string;

      if (mode === 'match_planes') {
        // For match_planes, check if already matched with target
        if (target && target !== 'auto') {
          await conn.raw(`SET TARGET TO ${target.includes(' ') ? `"${target}"` : target}.`, 3000);
        }
        const targetIncCheck = await conn.queue(
          'IF HASTARGET { PRINT ROUND(TARGET:ORBIT:INCLINATION, 2). } ELSE { PRINT "NOTGT". }',
          2000
        );
        if (targetIncCheck.success && !targetIncCheck.output.includes('NOTGT')) {
          const targetInc = Number.parseFloat(targetIncCheck.output.match(/[\d.]+/)?.[0] ?? '-999');
          if (Math.abs(currentInc - targetInc) < INCLINATION_TOLERANCE) {
            return ctx.successResponse('inclination',
              `Already matched with target plane!\n` +
              `Inclination: ${currentInc}° (target: ${targetInc}°)`);
          }
        }
      } else {
        // For change_inclination, check if already at target angle
        const targetAngle = angle ?? 0;
        if (Math.abs(currentInc - targetAngle) < INCLINATION_TOLERANCE) {
          return ctx.successResponse('inclination',
            `Already at target inclination!\n` +
            `Current: ${currentInc}° (target: ${targetAngle}°)`);
        }
      }

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
          responseText = result.executed
            ? 'Match planes: burn complete'
            : `Match planes: ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, in ${formatTime(result.timeToNode ?? 0)}`;

          if (result.warning) {
            responseText += `\n${result.warning}`;
          }

          if (result.executed) {
            const incInfo = await conn.queue('PRINT ROUND(SHIP:ORBIT:INCLINATION, 2) + "|" + ROUND(TARGET:ORBIT:INCLINATION, 2).', 2000);
            const match = incInfo.success ? incInfo.output.match(/([\d.]+)\|([\d.]+)/) : null;
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
          responseText = result.executed
            ? `Change inclination to ${targetAngle}°: burn complete`
            : `Change inclination to ${targetAngle}°: ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, in ${formatTime(result.timeToNode ?? 0)}`;

          if (result.warning) {
            responseText += `\n${result.warning}`;
          }

          if (result.executed) {
            const incInfo = await conn.queue('PRINT ROUND(SHIP:ORBIT:INCLINATION, 1).', 2000);
            const inc = incInfo.success ? incInfo.output : '?';
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
