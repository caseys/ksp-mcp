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
import { parseNumber } from '../shared.js';
import type { FineTuneFunction } from '../execute-node.js';
import type { KosConnection } from '../../../transport/kos-connection.js';

// ============================================================================
// Tool Definition
// ============================================================================

export const transferTool: ToolDefinition = {
  name: 'transfer',
  description: 'Begin transfer or return to or from planet, moon, or vessel.',
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

      // Create fine-tune function for hohmann transfers when executing
      let fineTuneFunction: FineTuneFunction | undefined;
      if (args.execute && transferType === 'hohmann' && targetInfo.class === 'moon') {
        fineTuneFunction = await createTransferFineTune(conn, targetInfo.name);
      }

      // Execute the appropriate transfer
      logger.progress(`[Transfer] Using ${transferType} for ${targetInfo.class}: ${targetInfo.name}`);
      const result = await executeSmartTransfer(orchestrator, transferType, {
        // target already set above via orchestrator.setTarget()
        execute: args.execute as boolean,
        logger,
        callerTool: 'transfer',
        fineTuneFunction,
      });

      if (result.success) {
        // If the orchestrator provided pre-formatted text (e.g., return_from_moon), use it directly
        if (result.text) {
          return ctx.successResponse('transfer', result.text);
        }

        const nodeCount = result.nodesCreated ?? 1;
        let text = result.executed
          ? `Transfer to ${targetInfo.name} (${transferType}) burn complete`
          : `Transfer to ${targetInfo.name} (${transferType}): ${nodeCount} node(s), ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, in ${formatTime(result.timeToNode ?? 0)}`;

        // Include warning if present
        if (result.warning) {
          text += '\n\n' + result.warning;
        }

        // Add trajectory info for hohmann/interplanetary transfers
        if (result.executed) {
          // Wait for physics to settle after burn before querying encounter
          await new Promise(r => setTimeout(r, 1500));

          // Query encounter info for hohmann/interplanetary transfers
          const { queryTargetEncounterInfo } = await import('../shared.js');
          const encounterInfo = await queryTargetEncounterInfo(conn);

          if (encounterInfo) {
            if (encounterInfo.targetType === 'body') {
              const peAlt = encounterInfo.periapsisInTargetSOI;

              if (peAlt != null && peAlt > 0) {
                // Use atmosphere-aware thresholds
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
              } else {
                text += `\nEncounter: ${encounterInfo.targetName}`;
                text += `\nNext: course_correct to verify approach`;
              }
            } else {
              // Vessel target - keep distance for rendezvous context
              const caDistKm = encounterInfo.closestApproachDistance != null
                ? (encounterInfo.closestApproachDistance / 1000).toFixed(1)
                : '?';
              text += `\nClosest approach: ${caDistKm}km`;
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
  fineTuneFunction?: FineTuneFunction;
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
  const { target, execute, logger, callerTool, fineTuneFunction } = options;

  if (transferType === 'hohmann') {
    return orchestrator.hohmannTransfer('COMPUTED', false, {
      target,
      execute,
      logger,
      callerTool,
      rendezvous: true,
      fineTuneFunction,
    });
  } else if (transferType === 'return_from_moon') {
    return orchestrator.returnFromMoon('auto', {
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
  // Safety check: already orbiting the target body
  if ((targetClass === 'planet' || targetClass === 'moon') &&
      targetName.toLowerCase() === shipBodyName.toLowerCase()) {
    return {
      transferType: 'hohmann',
      error: `Already orbiting ${targetName}! Cannot transfer to current location.\n` +
             `If returning to parent body, use return_from_moon.`,
    };
  }

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

// ============================================================================
// Fine-Tune Function for Transfers
// ============================================================================

/**
 * Create a fine tune function for transfers to body targets.
 * Queries target's atmosphere to determine optimal periapsis range.
 */
async function createTransferFineTune(conn: KosConnection, _targetName: string): Promise<FineTuneFunction | undefined> {
  // Query target body's atmosphere height
  const atmResult = await conn.queue(
    'IF HASTARGET AND TARGET:ISTYPE("Body") { PRINT TARGET:ATM:HEIGHT. } ELSE { PRINT -1. }',
    3000
  );

  if (!atmResult.success) {
    return undefined;
  }

  const atmHeight = parseNumber(atmResult.output.trim()) ?? 0;
  const minSafePe = atmHeight > 0 ? atmHeight + 40_000 : 40_000;
  const maxOptimalPe = minSafePe + 50_000;

  // Return fine-tune function that checks periapsis against optimal range
  return async (conn: KosConnection): Promise<number> => {
    // Query periapsis from current trajectory (after burn, no node)
    // Use marker concatenation to avoid matching echo in output
    const result = await conn.queue(
      'IF SHIP:ORBIT:HASNEXTPATCH { PRINT "["+"PE"+"]" + ROUND(SHIP:ORBIT:NEXTPATCH:PERIAPSIS). } ELSE { PRINT "["+"NOENC"+"]". }',
      3000
    );

    if (!result.success) {
      console.error('[fine-tune] Query failed:', result.output);
      return 0;
    }

    // Check for no encounter
    if (result.output.includes('[NOENC]')) {
      console.error('[fine-tune] No encounter detected');
      return 0;
    }

    // Parse periapsis from [PE]<value> format
    const match = result.output.match(/\[PE\](-?\d+)/);
    if (!match) {
      console.error('[fine-tune] Failed to parse periapsis from:', result.output);
      return 0;
    }

    const periapsis = parseInt(match[1]);
    console.error(`[fine-tune] Periapsis: ${periapsis}m, optimal range: [${minSafePe}, ${maxOptimalPe}]`);

    // In optimal range - no adjustment needed
    if (periapsis >= minSafePe && periapsis <= maxOptimalPe) {
      console.error('[fine-tune] In optimal range, no adjustment needed');
      return 0;
    }

    // Below optimal (including negative/impact): need prograde
    if (periapsis < minSafePe) {
      const error = periapsis - minSafePe;
      console.error(`[fine-tune] Below optimal, error: ${error}m (need prograde)`);
      return error;
    }

    // Above optimal: need retrograde
    const error = periapsis - maxOptimalPe;
    console.error(`[fine-tune] Above optimal, error: ${error}m (need retrograde)`);
    return error;
  };
}
