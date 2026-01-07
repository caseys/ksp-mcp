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

  // Validate vessel state: must be orbiting a planet (not a moon)
  const vesselValidation = await validateVesselState(conn, {
    forbiddenStatuses: ['prelaunch', 'landed', 'splashed'],
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
  description: 'Calculate transfer to another planet then waits for planet aligment.  NOT for moons - use hohmann_transfer instead.',
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
        if (autoTarget) {
          target = autoTarget;
        }
      }

      const result = await orchestrator.interplanetaryTransfer(args.waitForPhaseAngle as boolean, {
        target,
        execute: args.execute as boolean,
        logger,
        callerTool: 'interplanetary_transfer',
      });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        let text = `Node: ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, T-${formatTime(result.timeToNode ?? 0)}${execInfo}`;

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

          if (peAlt < 10_000) {
            text += ` - UNSAFE trajectory!`;
            text += `\nREQUIRED: Use course_correct to fix trajectory before doing anything else.`;
          } else {
            text += ` (safe)`;
            text += `\nNext: warp to ${encounterInfo.targetName} SOI, then circularize`;
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
