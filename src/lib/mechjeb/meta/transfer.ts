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
import { getVesselStateInfo, type BodyType } from '../../kos/vessel/validate.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, autoTargetSchema } from '../../tool-types.js';
import { formatTime, fmtNum } from '../../utils/format.js';

// ============================================================================
// Tool Definition
// ============================================================================

export const transferTool: ToolDefinition = {
  name: 'transfer',
  description: 'Transfer to target. Auto-detects: hohmann_transfer (moons/vessels), interplanetary_transfer (planets), or return_from_moon (parent planet from moon). Usually followed by course_correct.',
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

      // Auto-select target if not provided (use 2nd closest like hohmann)
      let target = args.target as string | undefined;
      if (!target || target === 'auto') {
        const autoTarget = await ctx.selectTarget(orchestrator, 'second-closest');
        if (autoTarget) {
          target = autoTarget;
        }
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
      let result;
      if (transferType === 'hohmann') {
        logger.progress(`[Transfer] Using hohmann_transfer for ${targetInfo.class}: ${targetInfo.name}`);
        result = await orchestrator.hohmannTransfer('COMPUTED', false, {
          // target already set above
          execute: args.execute as boolean,
          logger,
          callerTool: 'transfer',
          rendezvous: true,  // default to rendezvous mode
        });
      } else if (transferType === 'return_from_moon') {
        logger.progress(`[Transfer] Using return_from_moon to return to ${targetInfo.name}`);
        result = await orchestrator.returnFromMoon(40_000, {  // default 40km periapsis
          execute: args.execute as boolean,
          logger,
          callerTool: 'transfer',
        });
      } else {
        logger.progress(`[Transfer] Using interplanetary_transfer for planet: ${targetInfo.name}`);
        result = await orchestrator.interplanetaryTransfer(true, {
          // target already set above
          execute: args.execute as boolean,
          logger,
          callerTool: 'transfer',
        });
      }

      if (result.success) {
        const nodeCount = result.nodesCreated ?? 1;
        const execInfo = result.executed ? ' (executed)' : '';
        let text = `Transfer to ${targetInfo.name} (${transferType}): `;
        text += `${nodeCount} node(s), ${result.deltaV != null ? fmtNum(result.deltaV) : '?'} m/sec, T-${formatTime(result.timeToNode ?? 0)}${execInfo}`;

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
        } else {
          // Query encounter info for hohmann/interplanetary transfers
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

interface TransferTypeResult {
  transferType: 'hohmann' | 'interplanetary' | 'return_from_moon';
  error?: string;
}

/**
 * Determine which transfer type to use based on target class and vessel location.
 */
function determineTransferType(
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
