/**
 * Hohmann Transfer - Transfer to target body or vessel
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { queryNodeInfo, sanitizeError, type ManeuverResult } from '../shared.js';
import { validateTarget } from '../../kos/target/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, autoTargetSchema } from '../../tool-types.js';

/**
 * Create a maneuver node for a Hohmann transfer to the target.
 * Requires a target to be set first.
 *
 * Includes validation:
 * - Checks target is set before planning
 * - Verifies encounter exists after node creation
 * - Confirms encounter is with correct target
 *
 * @param conn kOS connection
 * @param timeRef When to execute: 'COMPUTED', 'PERIAPSIS', 'APOAPSIS'
 * @param capture Include capture burn
 */
export async function hohmannTransfer(
  conn: KosConnection,
  timeRef = 'COMPUTED',
  capture = false
): Promise<ManeuverResult> {
  // Pre-validate target: must be moon or vessel in same SOI
  const validation = await validateTarget(conn, {
    allowedClasses: ['moon', 'vessel'],
    requireSameSOI: true,
  }, 'hohmann_transfer');

  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const targetName = validation.targetInfo?.name ?? '';

  // Create the maneuver node
  const captureStr = capture ? 'TRUE' : 'FALSE';
  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:HOHMANN("${timeRef}", ${captureStr}).`;
  const result = await conn.execute(cmd, 10_000);

  const success = result.output.includes('True');
  if (!success) {
    return { success: false, error: sanitizeError(result.output, 'Hohmann transfer') };
  }

  // Query node info
  const nodeInfo = await queryNodeInfo(conn);

  // CRITICAL: Verify encounter exists AND is with the correct target
  const encounterCheck = await conn.execute(
    'IF NEXTNODE:ORBIT:HASNEXTPATCH { PRINT NEXTNODE:ORBIT:NEXTPATCH:BODY:NAME. } ELSE { PRINT "NO_ENCOUNTER". }',
    3000
  );
  const encounterBody = encounterCheck.output.trim();

  if (encounterBody === 'NO_ENCOUNTER') {
    return {
      success: false,
      error: '❌ Hohmann transfer nodes created but NO ENCOUNTER detected!\n' +
             'The transfer trajectory does not intersect the target.\n' +
             'Consider waiting for better phase angle or use interplanetary_transfer.'
    };
  }

  // Check if encounter is with the correct target (case-insensitive)
  if (targetName && encounterBody.toLowerCase() !== targetName.toLowerCase()) {
    return {
      success: false,
      error: `❌ Hohmann transfer creates WRONG ENCOUNTER!\n` +
             `Target: ${targetName}\n` +
             `Encounter: ${encounterBody}\n` +
             'The phase angle may be wrong - wait for better timing or use interplanetary_transfer.'
    };
  }

  // Query actual node count
  const nodeCountResult = await conn.execute('PRINT ALLNODES:LENGTH.', 2000);
  const nodesCreated = Number.parseInt(nodeCountResult.output.match(/\d+/)?.[0] || '1');

  return {
    success: true,
    deltaV: nodeInfo.deltaV,
    timeToNode: nodeInfo.timeToNode,
    nodesCreated,
  };
}

// ============================================================================
// Tool Definition
// ============================================================================

export const hohmannTransferTool: ToolDefinition = {
  name: 'hohmann_transfer',
  description: 'Go to a moon or vessel. Use for: fly to Mun, navigate to Minmus, transfer to vessel. NOT for planets - use interplanetary_transfer instead.',
  inputSchema: {
    target: autoTargetSchema,
    // Note: MechJeb does not have working capture logic - timeReference and capture temporarily disabled
    // timeReference: z.enum(['COMPUTED', 'PERIAPSIS', 'APOAPSIS'])
    //   .optional()
    //   .default('COMPUTED')
    //   .describe('When to execute: COMPUTED (optimal), PERIAPSIS, or APOAPSIS'),
    // capture: z.boolean()
    //   .optional()
    //   .default(false)
    //   .describe('Include capture burn for vessel rendezvous. Default: false (transfer only).'),
    execute: executeSchema,
    includeTelemetry: z.boolean()
      .optional()
      .default(false)
      .describe('Include ship telemetry in response'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 1,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);

      // Auto-select target if not provided
      let target = args.target as string | undefined;
      if (!target) {
        const autoTarget = await ctx.selectTarget(orchestrator, 'closest-body');
        if (autoTarget) {
          target = autoTarget;
        }
      }

      // Note: Using hardcoded defaults - MechJeb does not have working capture logic
      const result = await orchestrator.hohmannTransfer('COMPUTED', false, { target, execute: args.execute as boolean });

      if (result.success) {
        const nodeCount = result.nodesCreated ?? 1;
        const execInfo = result.executed ? ' (executed)' : '';
        let text = `${nodeCount} node(s): ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`;

        // Include warning if present (crash trajectory, close approach, etc.)
        if (result.error) {
          text += '\n\n' + result.error;
        }

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

        return ctx.successResponse('hohmann_transfer', text);
      } else {
        return ctx.errorResponse('hohmann_transfer', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('hohmann_transfer', error instanceof Error ? error.message : String(error));
    }
  },
};
