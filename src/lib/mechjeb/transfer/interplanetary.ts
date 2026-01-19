/**
 * Interplanetary Transfer - Plan transfer to another planet
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, queryTargetEncounterInfo, type ManeuverResult } from '../shared.js';
import { validateTarget } from '../../kos/target/validate.js';
import { validateVesselState } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, autoTargetSchema, type McpLogger, nullLogger } from '../../tool-types.js';
import { formatTime,  fmtVel } from '../../utils/format.js';

export interface InterplanetaryOptions {
  waitForPhaseAngle?: boolean;
  logger?: McpLogger;
}

/**
 * Create a maneuver node for an interplanetary transfer.
 * Requires a target planet to be set first.
 *
 * @param conn kOS connection
 * @param options Transfer options including waitForPhaseAngle and logger
 */
export async function interplanetaryTransfer(
  conn: KosConnection,
  options: InterplanetaryOptions = {}
): Promise<ManeuverResult> {
  const { waitForPhaseAngle = true, logger } = options;
  const log = logger ?? nullLogger;

  // Validate vessel state: must be ORBITING a planet (not a moon)
  const vesselValidation = await validateVesselState(conn, {
    allowedStatuses: ['orbiting'],
    requireAtPlanet: true,
  }, 'interplanetary_transfer');
  if (!vesselValidation.valid) {
    return { success: false, error: vesselValidation.error };
  }

  // Pre-validate target: must be a planet, and not the current SOI body
  const validation = await validateTarget(conn, {
    allowedClasses: ['planet'],
    forbidCurrentSOI: true,
  }, 'interplanetary_transfer');

  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const targetName = validation.targetInfo?.name ?? '';

  // Check if we already have a transfer trajectory to the target
  const encounterInfo = await queryTargetEncounterInfo(conn);
  const hasExistingTransfer = validation.targetInfo?.hasEncounter &&
      validation.targetInfo?.encounterBody?.toLowerCase() === targetName.toLowerCase();

  if (hasExistingTransfer && encounterInfo?.targetType === 'body') {
    const peAlt = encounterInfo.periapsisInTargetSOI ?? 0;
    const atmHeight = encounterInfo.atmosphereHeight ?? 0;
    const minSafePe = atmHeight > 0 ? atmHeight + 40_000 : 40_000;
    const optimalMaxPe = minSafePe + 50_000;
    const targetPeKm = Math.round(minSafePe / 1000);

    // Build response with labels (not raw numbers - LLMs misuse them)
    let text = `WARNING: Transfer to ${targetName} already in progress, no changes made.`;

    if (peAlt < minSafePe) {
      text += `\nEncounter: ${targetName} (UNSAFE - `;
      text += atmHeight > 0 ? `below atmosphere)` : `too low)`;
      text += `\nREQUIRED: course_correct with targetDistance ${targetPeKm}km`;
    } else if (peAlt <= optimalMaxPe) {
      text += `\nEncounter: ${targetName} (optimal)`;
      text += `\nNext: warp to SOI, then circularize`;
    } else if (peAlt <= 500_000) {
      text += `\nEncounter: ${targetName} (acceptable)`;
      text += `\nNext: course_correct to ${targetPeKm}km for efficient capture`;
    } else {
      text += `\nEncounter: ${targetName} (far encounter)`;
      text += `\nNext: course_correct to ${targetPeKm}km`;
    }

    return { success: true, warning: text };
  }

  if (waitForPhaseAngle) {
    log.progress(`[Transfer] Planning interplanetary transfer to ${targetName} (waiting for optimal phase angle)...`);
  } else {
    log.progress(`[Transfer] Planning immediate transfer to ${targetName}...`);
  }

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:INTERPLANETARY(${waitForPhaseAngle ? 'TRUE' : 'FALSE'}).`;
  const result = await executeManeuverCommand(conn, cmd);

  if (result.success) {
    log.progress(`[Transfer] Transfer node created to ${targetName}`);
  }

  return result;
}

// ============================================================================
// Tool Definition
// ============================================================================

export const interplanetaryTransferTool: ToolDefinition = {
  name: 'interplanetary_transfer',
  description: 'Calculate transfer to another planet, wait for planet alignment.',
  inputSchema: {
    target: autoTargetSchema,
    waitForPhaseAngle: z.boolean()
      .optional()
      .default(true)
      .describe('If true, waits for optimal phase angle. If false, transfers immediately.'),
    execute: executeSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: -1,
  handler: async (args, ctx, extra) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);
      const logger = ctx.createLogger(extra);

      // Auto-select furthest body if not provided (interplanetary = distant planets)
      let target = args.target as string | undefined;
      if (!target || target === 'auto') {
        const autoTarget = await ctx.selectTarget(orchestrator, 'furthest-body');
        target = autoTarget ?? undefined;  // Never pass 'auto' to kOS
      }

      const result = await orchestrator.interplanetaryTransfer(args.waitForPhaseAngle as boolean, {
        target,
        execute: args.execute as boolean,
        logger,
        callerTool: 'interplanetary_transfer',
      });

      if (result.success) {
        let text = result.executed
          ? 'Burn complete'
          : `Node: ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, in ${formatTime(result.timeToNode ?? 0)}`;

        // Include warning if present (crash trajectory, close approach, etc.)
        if (result.warning) {
          text += '\n\n' + result.warning;
        }

        // Query encounter info for guidance
        const { queryTargetEncounterInfo } = await import('../shared.js');
        const encounterInfo = await queryTargetEncounterInfo(conn);

        if (encounterInfo && encounterInfo.targetType === 'body') {
          const peAlt = encounterInfo.periapsisInTargetSOI ?? 0;
          const atmHeight = encounterInfo.atmosphereHeight ?? 0;
          const minSafePe = atmHeight > 0 ? atmHeight + 40_000 : 40_000;
          const optimalMaxPe = minSafePe + 50_000;
          const targetPeKm = Math.round(minSafePe / 1000);

          // Use labels, not raw numbers - LLMs pick up numbers and reuse them incorrectly
          if (peAlt < minSafePe) {
            text += `\nEncounter: ${encounterInfo.targetName} (UNSAFE - `;
            text += atmHeight > 0 ? `below atmosphere)` : `too low)`;
            text += `\nREQUIRED: course_correct with targetDistance ${targetPeKm}km`;
          } else if (peAlt <= optimalMaxPe) {
            text += `\nEncounter: ${encounterInfo.targetName} (optimal)`;
            text += `\nNext: warp to SOI, then circularize`;
          } else if (peAlt <= 500_000) {
            text += `\nEncounter: ${encounterInfo.targetName} (acceptable)`;
            text += `\nNext: course_correct to ${targetPeKm}km for efficient capture`;
          } else {
            text += `\nEncounter: ${encounterInfo.targetName} (far encounter)`;
            text += `\nNext: course_correct to ${targetPeKm}km`;
          }
        }

        return ctx.successResponse('interplanetary', text);
      } else {
        return ctx.errorResponse('interplanetary', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('interplanetary', error instanceof Error ? error.message : String(error));
    }
  },
};
