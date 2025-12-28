/**
 * Course Correction - Fine-tune approach trajectory
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { queryNodeInfo, sanitizeError, type ManeuverResult } from '../shared.js';
import { getTargetValidationInfo } from '../../kos/target/validate.js';
import { areWorkaroundsEnabled } from '../../../config/workarounds.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition, McpLogger } from '../../tool-types.js';
import { executeSchema, targetSchema, distanceSchema } from '../../tool-types.js';

/**
 * Create a maneuver node for course correction.
 * Adjusts trajectory to achieve desired periapsis at target.
 *
 * Includes workaround for MechJeb's imprecise course correction algorithm.
 *
 * @param conn kOS connection
 * @param targetPeriapsis Target periapsis in meters
 * @param logger Optional logger for notifications
 */
export async function courseCorrection(
  conn: KosConnection,
  targetPeriapsis: number,
  logger?: McpLogger
): Promise<ManeuverResult> {
  // Check target exists and has encounter
  const targetInfo = await getTargetValidationInfo(conn);
  if (!targetInfo) {
    return {
      success: false,
      error: 'No target set. Use set_target first, then hohmann_transfer to establish an encounter.',
    };
  }

  if (!targetInfo.hasEncounter) {
    return {
      success: false,
      error: `No encounter with ${targetInfo.name}.\ncourse_correct requires an existing encounter (trajectory through target's SOI).\n\nUse hohmann_transfer first to establish an encounter.`,
    };
  }

  let adjustedPeA = targetPeriapsis;

  if (areWorkaroundsEnabled()) {
    // WORKAROUND: MechJeb's course correction algorithm produces results that vary
    // with trajectory geometry. Using 3x multiplier to err on the safe side
    // (higher periapsis than requested, avoiding surface impact).
    adjustedPeA = targetPeriapsis * 3;
    logger?.warn(`[CourseCorrection] WORKAROUND: Requested ${targetPeriapsis}m, using ${adjustedPeA}m (3x safe margin)`);
  }

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:COURSECORRECTION(${adjustedPeA}).`;
  const result = await conn.execute(cmd, 10_000);

  const success = result.output.includes('True');
  if (!success) {
    return { success: false, error: sanitizeError(result.output, 'Course correction') };
  }

  const nodeInfo = await queryNodeInfo(conn);
  return { success: true, deltaV: nodeInfo.deltaV, timeToNode: nodeInfo.timeToNode };
}

// ============================================================================
// Tool Definition
// ============================================================================

export const courseCorrectTool: ToolDefinition = {
  name: 'course_correct',
  description: 'Fine-tune approach after transfer. Requires existing encounter - use hohmann_transfer first if none.',
  inputSchema: {
    target: targetSchema,
    targetDistance: distanceSchema.optional().default(50_000).describe('Target periapsis (bodies) or closest approach (vessels) in meters (default: 50km)'),
    execute: executeSchema,
    includeTelemetry: z.boolean()
      .optional()
      .default(false)
      .describe('Include ship telemetry in response (slower but more info)'),
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

      // Auto-select 2nd closest body if no target provided
      let target = args.target as string | undefined;
      if (!target) {
        const autoTarget = await ctx.selectTarget(orchestrator, 'second-closest');
        if (autoTarget) {
          target = autoTarget;
        }
      }

      // Try course correction
      let result = await orchestrator.courseCorrection(args.targetDistance as number, { target, execute: args.execute as boolean, logger });

      // If no encounter, do hohmann transfer first
      if (!result.success && result.error?.toLowerCase().includes('no encounter')) {
        const hohmannResult = await orchestrator.hohmannTransfer('COMPUTED', false, { target, execute: args.execute as boolean, logger });
        if (hohmannResult.success) {
          result = await orchestrator.courseCorrection(args.targetDistance as number, { execute: args.execute as boolean, logger });
        }
      }

      if (!result.success) {
        return ctx.errorResponse('course_correct', result.error ?? 'Failed');
      }

      const execInfo = result.executed ? ' (executed)' : '';
      let text = `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`;

      if (args.includeTelemetry) {
        const { queryTargetEncounterInfo } = await import('../shared.js');
        const { getShipTelemetry, formatTargetEncounterInfo } = await import('../telemetry.js');
        const targetInfo = await queryTargetEncounterInfo(conn);
        if (targetInfo) {
          text += '\n\n' + formatTargetEncounterInfo(targetInfo);
        }
        const telemetry = await getShipTelemetry(conn, { timeoutMs: 2500 });
        text += '\n\n' + telemetry.formatted;
      }

      return ctx.successResponse('course_correct', text);
    } catch (error) {
      return ctx.errorResponse('course_correct', error instanceof Error ? error.message : String(error));
    }
  },
};
