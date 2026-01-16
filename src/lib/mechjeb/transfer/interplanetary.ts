/**
 * Interplanetary Transfer - Plan transfer to another planet
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';
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
  tier: 2,
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
          : `Node: ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, T-${formatTime(result.timeToNode ?? 0)}`;

        // Include warning if present (crash trajectory, close approach, etc.)
        if (result.warning) {
          text += '\n\n' + result.warning;
        }

        // Query encounter info for guidance
        const { queryTargetEncounterInfo } = await import('../shared.js');
        const encounterInfo = await queryTargetEncounterInfo(conn);

        if (encounterInfo && encounterInfo.targetType === 'body') {
          const peAlt = encounterInfo.periapsisInTargetSOI ?? 0;
          const encPeKm = (peAlt / 1000).toFixed(0);
          text += `\nEncounter: ${encounterInfo.targetName} at ${encPeKm}km`;

          // Use atmosphere-aware thresholds
          const atmHeight = encounterInfo.atmosphereHeight ?? 0;
          const minSafePe = atmHeight > 0 ? atmHeight + 40_000 : 40_000;
          const optimalMaxPe = minSafePe + 50_000;

          if (peAlt < minSafePe) {
            const reason = atmHeight > 0
              ? `below safe altitude (atmo: ${(atmHeight / 1000).toFixed(0)}km)`
              : 'too low';
            text += ` - UNSAFE (${reason})!`;
            text += `\nREQUIRED: Use course_correct to raise periapsis before proceeding.`;
          } else if (peAlt <= optimalMaxPe) {
            text += ` (optimal)`;
            text += `\nNext: Execute transfer, warp to SOI, then circularize.`;
          } else if (peAlt <= 500_000) {
            text += ` (acceptable)`;
            text += `\nNext: Use course_correct to tighten approach to ~${(minSafePe / 1000).toFixed(0)}km for efficient capture.`;
          } else {
            text += ` (far)`;
            text += `\nNext: Use course_correct to reduce periapsis to ~${(minSafePe / 1000).toFixed(0)}km before proceeding.`;
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
