/**
 * Unified Transfer Tool - Smart routing to transfer operations
 *
 * Auto-detects target type and vessel location, routes to:
 * - hohmann_transfer: moons/vessels in same SOI
 * - interplanetary_transfer: planets from planet orbit
 * - return_from_moon: parent planet from moon orbit
 */

import { ManeuverOrchestrator } from '../orchestrator.js';
import { getTargetValidationInfo, type TargetClass } from '../../kos/target/validate.js';
import { getVesselStateInfo, validateVesselState, ORBITING_ONLY_REQUIREMENTS, type BodyType } from '../../kos/vessel/validate.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, autoTargetSchema } from '../../tool-types.js';
import { formatTime,  fmtVel } from '../../utils/format.js';

// ============================================================================
// Tool Definition
// ============================================================================

export const transferTool: ToolDefinition = {
  name: 'transfer',
  description: 'Start transfer to vessel, moon or planet. Usually followed by course_correct.',
  inputSchema: {
    target: autoTargetSchema,
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

      // Validate vessel state FIRST: must be in orbit before checking SOI/target
      const vesselValidation = await validateVesselState(conn, ORBITING_ONLY_REQUIREMENTS, 'transfer');
      if (!vesselValidation.valid) {
        return ctx.errorResponse('transfer', vesselValidation.error ?? 'Invalid vessel state');
      }

      // Auto-select target if not provided (use 2nd closest like hohmann)
      let target = args.target as string | undefined;
      if (!target || target === 'auto') {
        const autoTarget = await ctx.selectTarget(orchestrator, 'second-closest');
        target = autoTarget ?? undefined;  // Never pass 'auto' to kOS
      }

      // Set target if provided
      if (target) {
        const targetResult = await orchestrator.setTarget(target);
        if (!targetResult.success) {
          return ctx.errorResponse('transfer', targetResult.error ?? `Failed to set target "${target}"`);
        }
      }

      // Get target classification
      const targetInfo = await getTargetValidationInfo(conn);
      if (!targetInfo) {
        return ctx.errorResponse('transfer',
          'No target set. Set target first or specify target name.\n' +
          'Example: transfer target="Mun" or transfer target="Duna"');
      }

      // Get vessel state to know if we're at a moon or planet
      const vesselState = await getVesselStateInfo(conn);

      // Check if already at target SOI
      if ((targetInfo.class === 'moon' || targetInfo.class === 'planet') && vesselState.bodyName.toLowerCase() === targetInfo.name.toLowerCase()) {
          // Already at target - check orbit type
          if (vesselState.eccentricity >= 1) {
            return ctx.successResponse('transfer',
              `Transfer complete - already at ${targetInfo.name}!\n` +
              `Orbit is hyperbolic (ecc=${vesselState.eccentricity.toFixed(2)}).\n` +
              `Next: Use circularize to establish stable orbit.`);
          }
          return ctx.successResponse('transfer',
            `Transfer complete - already orbiting ${targetInfo.name}!\n` +
            `Orbit: Pe=${Math.round(vesselState.periapsis / 1000)}km, Ap=${Math.round(vesselState.apoapsis / 1000)}km`);
        }

      // Check for hyperbolic orbit before planning transfer
      if (vesselState.eccentricity >= 1) {
        return ctx.errorResponse('transfer',
          `Cannot plan transfer from hyperbolic trajectory (ecc=${vesselState.eccentricity.toFixed(2)}).\n` +
          `Use circularize first to establish stable orbit, then transfer.`);
      }

      // Route based on target class and vessel location
      const { transferType, error } = determineTransferType(
        targetInfo.class,
        targetInfo.name,
        targetInfo.isInShipSOI,
        vesselState.bodyType,
        vesselState.bodyName,
        vesselState.parentBodyName
      );

      if (error) {
        return ctx.errorResponse('transfer', error);
      }

      // Execute the appropriate transfer
      logger.progress(`[Transfer] Using ${transferType} for ${targetInfo.class}: ${targetInfo.name}`);
      const result = await executeSmartTransfer(orchestrator, transferType, {
        // target already set above via orchestrator.setTarget()
        execute: args.execute as boolean,
        logger,
        callerTool: 'transfer',
      });

      if (result.success) {
        const nodeCount = result.nodesCreated ?? 1;
        let text = result.executed
          ? `Transfer to ${targetInfo.name} (${transferType}) burn complete`
          : `Transfer to ${targetInfo.name} (${transferType}): ${nodeCount} node(s), ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, T-${formatTime(result.timeToNode ?? 0)}`;

        // Include warning if present
        if (result.warning) {
          text += '\n\n' + result.warning;
        }

        // Add trajectory info based on transfer type
        if (transferType === 'return_from_moon' && result.executed) {
          // Show return trajectory info
          const trajInfo = await conn.execute(
            'IF SHIP:ORBIT:HASNEXTPATCH { PRINT "RET|" + SHIP:ORBIT:NEXTPATCH:BODY:NAME + "|" + ROUND(SHIP:ORBIT:NEXTPATCH:PERIAPSIS/1000, 1). } ELSE { PRINT "NOPATCH". }',
            3000
          );
          const match = trajInfo.output.match(/RET\|([^|]+)\|([\d.-]+)/);
          if (match) {
            text += `\nReturn trajectory: ${match[1]} periapsis ${match[2]}km`;
            text += `\nNext: warp to ${match[1]} SOI, then circularize`;
          }
        } else if (result.executed) {
          // Wait for physics to settle after burn before querying encounter
          await new Promise(r => setTimeout(r, 1500));

          // Query encounter info for hohmann/interplanetary transfers
          const { queryTargetEncounterInfo } = await import('../shared.js');
          const encounterInfo = await queryTargetEncounterInfo(conn);

          if (encounterInfo) {
            if (encounterInfo.targetType === 'body') {
              const peAlt = encounterInfo.periapsisInTargetSOI;

              if (peAlt != null && peAlt > 0) {
                const encPeKm = (peAlt / 1000).toFixed(0);
                text += `\nEncounter: ${encounterInfo.targetName} at ${encPeKm}km`;

                if (peAlt < 10_000) {
                  text += ` - UNSAFE trajectory!`;
                  text += `\nREQUIRED: Use course_correct to fix trajectory before doing anything else.`;
                } else if (peAlt < 30_000) {
                  text += ` (close)`;
                  text += `\nNext: warp to ${encounterInfo.targetName} SOI, then circularize`;
                } else if (peAlt > 500_000) {
                  text += ` (far)`;
                  text += `\nNext: warp to ${encounterInfo.targetName} SOI, then circularize or use course_correct to tighten`;
                } else {
                  text += ` (safe)`;
                  text += `\nNext: warp to ${encounterInfo.targetName} SOI, then circularize`;
                }
              } else {
                // Couldn't determine periapsis
                text += `\nEncounter: ${encounterInfo.targetName} (periapsis unknown)`;
                text += `\nNext: Use course_correct to verify/adjust approach`;
              }
            } else {
              // Vessel target
              const caDistKm = encounterInfo.closestApproachDistance != null
                ? (encounterInfo.closestApproachDistance / 1000).toFixed(1)
                : '?';
              const caRelVel = encounterInfo.closestApproachRelVel != null
                ? fmtVel(encounterInfo.closestApproachRelVel)
                : '?';
              text += `\nClosest approach: ${caDistKm}km at ${caRelVel} relative`;
              text += `\nNext: warp to closest approach, then match_velocities`;
            }
          }
        }

        return ctx.successResponse('transfer', text);
      } else {
        return ctx.errorResponse('transfer', result.error ?? 'Transfer failed');
      }
    } catch (error) {
      return ctx.errorResponse('transfer', error instanceof Error ? error.message : String(error));
    }
  },
};

// ============================================================================
// Transfer Type Determination
// ============================================================================

export type TransferType = 'hohmann' | 'interplanetary' | 'return_from_moon';

// ============================================================================
// Shared Transfer Execution
// ============================================================================

export interface ExecuteTransferOptions {
  target?: string;
  execute: boolean;
  logger?: import('../../tool-types.js').McpLogger;
  callerTool: string;
}

/**
 * Execute the appropriate transfer based on transfer type.
 * Shared between transfer tool and course_correct fallback.
 */
export async function executeSmartTransfer(
  orchestrator: ManeuverOrchestrator,
  transferType: TransferType,
  options: ExecuteTransferOptions
): Promise<import('../orchestrator.js').OrchestratedResult> {
  const { target, execute, logger, callerTool } = options;

  if (transferType === 'hohmann') {
    return orchestrator.hohmannTransfer('COMPUTED', false, {
      target,
      execute,
      logger,
      callerTool,
      rendezvous: true,
    });
  } else if (transferType === 'return_from_moon') {
    return orchestrator.returnFromMoon(40_000, {
      execute,
      logger,
      callerTool,
    });
  } else {
    return orchestrator.interplanetaryTransfer(true, {
      target,
      execute,
      logger,
      callerTool,
    });
  }
}

export interface TransferTypeResult {
  transferType: TransferType;
  error?: string;
}

/**
 * Determine which transfer type to use based on target class and vessel location.
 */
export function determineTransferType(
  targetClass: TargetClass,
  targetName: string,
  isInShipSOI: boolean,
  shipBodyType: BodyType,
  shipBodyName: string,
  shipParentBodyName: string
): TransferTypeResult {
  // Planet target
  if (targetClass === 'planet') {
    // Special case: at a moon, targeting the parent planet → return_from_moon
    if (shipBodyType === 'moon' && targetName.toLowerCase() === shipParentBodyName.toLowerCase()) {
      return { transferType: 'return_from_moon' };
    }

    // Cannot do interplanetary from a moon to a different planet - need to leave first
    if (shipBodyType === 'moon') {
      return {
        transferType: 'interplanetary',
        error:
          `Cannot transfer to planet ${targetName} from moon orbit.\n` +
          `You are currently orbiting ${shipBodyName} (a moon of ${shipParentBodyName}).\n` +
          `Use return_from_moon first to return to ${shipParentBodyName} orbit, then transfer.`,
      };
    }

    // Check if targeting current SOI body
    if (targetName.toLowerCase() === shipBodyName.toLowerCase()) {
      return {
        transferType: 'interplanetary',
        error: `Already at ${targetName}! Cannot transfer to current SOI body.`,
      };
    }
    return { transferType: 'interplanetary' };
  }

  // Moon target
  if (targetClass === 'moon') {
    if (!isInShipSOI) {
      return {
        transferType: 'hohmann',
        error:
          `Target moon ${targetName} is not in your current SOI.\n` +
          `You are orbiting ${shipBodyName}.\n` +
          `Use interplanetary_transfer to reach the target planet first.`,
      };
    }
    return { transferType: 'hohmann' };
  }

  // Vessel target
  if (targetClass === 'vessel') {
    if (!isInShipSOI) {
      return {
        transferType: 'hohmann',
        error:
          `Target vessel "${targetName}" is in a different SOI.\n` +
          `You are orbiting ${shipBodyName}.\n` +
          `Use interplanetary_transfer to reach the target's SOI first.`,
      };
    }
    return { transferType: 'hohmann' };
  }

  // No valid target
  return {
    transferType: 'hohmann',
    error: 'No valid target. Set a target body or vessel first.',
  };
}
