/**
 * Course Correction - Fine-tune approach trajectory
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { queryNodeInfo, type ManeuverResult } from '../shared.js';
import { getTargetValidationInfo } from '../../kos/target/validate.js';
import { validateVesselState, ORBITAL_REQUIREMENTS } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition, McpLogger } from '../../tool-types.js';
import { executeSchema, distanceSchema, parseTarget } from '../../tool-types.js';
import { formatTime, fmtVel } from '../../utils/format.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Query the periapsis that the current maneuver node would produce at the target.
 * Uses NEXTNODE:ORBIT:NEXTPATCH:PERIAPSIS to get the periapsis in the target's SOI.
 */
async function queryNodePeriapsis(conn: KosConnection): Promise<{ hasEncounter: boolean; periapsis: number }> {
  const result = await conn.execute(
    'IF HASNODE AND NEXTNODE:ORBIT:HASNEXTPATCH { ' +
    'PRINT "ENC|" + ROUND(NEXTNODE:ORBIT:NEXTPATCH:PERIAPSIS). ' +
    '} ELSE IF HASNODE { PRINT "NOENC". } ELSE { PRINT "NONODE". }',
    3000
  );

  if (result.output.includes('NONODE') || result.output.includes('NOENC')) {
    return { hasEncounter: false, periapsis: 0 };
  }

  const match = result.output.match(/ENC\|(-?[\d.]+)/);
  return { hasEncounter: true, periapsis: match ? parseFloat(match[1]) : 0 };
}

/**
 * Query the current periapsis from actual orbit (not a node prediction).
 * Uses MechJeb INFO:TPERI which reliably calculates encounter periapsis.
 */
async function queryActualPeriapsis(conn: KosConnection): Promise<{ hasEncounter: boolean; periapsis: number }> {
  // Use MechJeb INFO accessor - TPERI gives periapsis in target SOI
  const result = await conn.execute(
    'IF HASTARGET { PRINT "ENC|" + ADDONS:MJ:INFO:TPERI. } ELSE { PRINT "NOTGT". }',
    3000
  );

  if (result.output.includes('NOTGT')) {
    return { hasEncounter: false, periapsis: 0 };
  }

  // Parse distance with units (e.g., "214.1 km", "50000 m", etc.)
  const match = result.output.match(/ENC\|([0-9.]+)\s*(m|km|Mm|Gm)?/i);
  if (!match) {
    return { hasEncounter: false, periapsis: 0 };
  }

  let value = parseFloat(match[1]);
  const unit = (match[2] || 'm').toLowerCase();

  // Convert to meters
  switch (unit) {
  case 'km': {
  value *= 1000;
  break;
  }
  case 'mm': {
  value *= 1_000_000;
  break;
  }
  case 'gm': {
  value *= 1_000_000_000;
  // No default
  }
  break;
  }

  return { hasEncounter: true, periapsis: value };
}

// RCS pulses removed - prograde/retrograde thrust doesn't map directly to
// periapsis changes at distant targets due to orbital geometry. Instead,
// use iterative MechJeb course correction nodes.

// Extended result type with iteration info
export interface IterativeCourseResult extends ManeuverResult {
  attempts: number;
  finalPeriapsis: number;
}

/**
 * Create a maneuver node for course correction.
 * Simply creates the node - actual refinement via burns happens in the handler.
 *
 * @param conn kOS connection
 * @param targetPeriapsis Target periapsis in meters
 * @param logger Optional logger for notifications
 */
export async function courseCorrection(
  conn: KosConnection,
  targetPeriapsis: number,
  logger?: McpLogger
): Promise<IterativeCourseResult> {
  // Validate vessel state: must not be on ground
  const vesselValidation = await validateVesselState(conn, ORBITAL_REQUIREMENTS, 'course_correct');
  if (!vesselValidation.valid) {
    return { success: false, error: vesselValidation.error, attempts: 0, finalPeriapsis: 0 };
  }

  // Check target exists and has encounter
  const targetInfo = await getTargetValidationInfo(conn);
  if (!targetInfo) {
    return {
      success: false,
      error: 'No target set. Use set_target first, then hohmann_transfer to establish an encounter.',
      attempts: 0,
      finalPeriapsis: 0,
    };
  }

  if (!targetInfo.hasEncounter) {
    return {
      success: false,
      error: `No encounter with ${targetInfo.name}.\ncourse_correct requires an existing encounter (trajectory through target's SOI).\n\nUse hohmann_transfer first to establish an encounter.`,
      attempts: 0,
      finalPeriapsis: 0,
    };
  }

  logger?.info(`[CourseCorrect] Creating node for ${(targetPeriapsis / 1000).toFixed(1)}km target`);

  // Clear any existing node and create new one
  await conn.execute('IF HASNODE { REMOVE NEXTNODE. }', 2000);
  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:COURSECORRECTION(${targetPeriapsis}).`;
  const result = await conn.execute(cmd, 10_000);

  if (!result.output.includes('True')) {
    return {
      success: false,
      error: 'Failed to create course correction node',
      attempts: 1,
      finalPeriapsis: 0,
    };
  }

  // Adjust node timing if too soon - need time to align
  // Target: ~1 hour ahead, but before apoapsis
  const MIN_NODE_ETA = 1800; // 30 minutes minimum
  const TARGET_NODE_ETA = 3600; // 1 hour ideal
  try {
    const etaResult = await conn.execute('PRINT NEXTNODE:ETA.', 2000);
    const currentEta = parseFloat(etaResult.output.match(/[\d.]+/)?.[0] || '0');

    if (currentEta < MIN_NODE_ETA) {
      // Get time to apoapsis to ensure we don't schedule past it
      const apoResult = await conn.execute('PRINT ETA:APOAPSIS.', 2000);
      const etaApo = parseFloat(apoResult.output.match(/[\d.]+/)?.[0] || '0');

      // New ETA: 1 hour, or 10 min before apoapsis, whichever is smaller
      const newEta = Math.min(TARGET_NODE_ETA, etaApo > 600 ? etaApo - 600 : etaApo / 2);

      if (newEta > currentEta + 60) {
        // Recreate node at new time by adjusting the node's UT
        const adjustCmd = `SET N TO NEXTNODE. SET NEWUT TO TIME:SECONDS + ${newEta}. SET NEWNODE TO NODE(NEWUT, N:RADIALOUT, N:NORMAL, N:PROGRADE). REMOVE N. ADD NEWNODE.`;
        await conn.execute(adjustCmd, 5000);
        logger?.info(`[CourseCorrect] Moved node from T-${Math.round(currentEta)}s to T-${Math.round(newEta)}s`);

        // Check resulting periapsis after move
        const peAfterMove = await queryNodePeriapsis(conn);
        if (peAfterMove.hasEncounter) {
          logger?.progress(`[CourseCorrect] Node adjusted: T-${formatTime(newEta)}, Pe ${(peAfterMove.periapsis / 1000).toFixed(0)}km`);
        } else {
          logger?.warn(`[CourseCorrect] Node moved but encounter lost - may need different timing`);
        }
      }
    }
  } catch {
    // Non-fatal - proceed with original node timing
  }

  // Check resulting periapsis from node prediction
  const nodeResult = await queryNodePeriapsis(conn);
  if (!nodeResult.hasEncounter) {
    return {
      success: false,
      error: 'Course correction resulted in no encounter',
      attempts: 1,
      finalPeriapsis: 0,
    };
  }

  const nodeInfo = await queryNodeInfo(conn);
  return {
    success: true,
    deltaV: nodeInfo.deltaV,
    timeToNode: nodeInfo.timeToNode,
    attempts: 1,
    finalPeriapsis: nodeResult.periapsis,
  };
}

// ============================================================================
// Tool Definition
// ============================================================================

export const courseCorrectTool: ToolDefinition = {
  name: 'course_correct',
  description: 'Fine tune arrival periapsis at target body. Use 50-100km for safe orbit insertion, 10-30km for aerobraking. Max 2500km.',
  inputSchema: {
    target: z.preprocess(parseTarget, z.union([z.string(), z.literal('auto')]))
      .optional()
      .default('auto')
      .describe('Target name (body or vessel) set by previous tool. Use get_targets to list available names.'),
    targetDistance: distanceSchema.optional().default(50_000).describe('Target periapsis in meters. Range: 10km-2500km. Default 50km. Use 100km for landing approach.'),
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
      const { queryTargetEncounterInfo } = await import('../shared.js');

      // Auto-select 2nd closest body if no target provided
      let target = args.target as string | undefined;
      if (!target || target === 'auto') {
        const autoTarget = await ctx.selectTarget(orchestrator, 'second-closest');
        target = autoTarget ?? undefined;  // Never pass 'auto' to kOS
      }

      const targetDistance = args.targetDistance as number;
      const shouldExecute = args.execute as boolean;

      // Validate target distance range
      const MIN_DISTANCE = 10_000;      // 10km minimum
      const MAX_DISTANCE = 2_500_000;   // 2500km maximum

      if (targetDistance < MIN_DISTANCE) {
        return ctx.errorResponse('course_correct',
          `Target periapsis ${(targetDistance / 1000).toFixed(1)}km is too low (min: 10km).\n` +
          `For landing, use 50-100km periapsis, then use landing tools.`);
      }

      if (targetDistance > MAX_DISTANCE) {
        return ctx.errorResponse('course_correct',
          `Target periapsis ${(targetDistance / 1000).toFixed(0)}km is too high (max: 2500km).\n` +
          `For orbit insertion, use 50-100km. For landing approach, use 100km.\n` +
          `Received value may have wrong units - use "50km" or "100000" (meters).`);
      }

      const TOLERANCE = 0.25; // 25% tolerance for actual result
      const MAX_BURNS = 3; // Max correction burns

      // History for secant method: [{input, result}, ...]
      const history: Array<{ input: number; result: number }> = [];
      let inputPe = targetDistance; // Current input to MechJeb
      let actualPe = 0;
      let totalBurns = 0;

      for (let burn = 0; burn < MAX_BURNS; burn++) {
        logger?.info(`[CourseCorrect] Burn ${burn + 1}/${MAX_BURNS}: requesting ${(inputPe / 1000).toFixed(1)}km`);

        const result = await orchestrator.courseCorrection(inputPe, {
          target: burn === 0 ? target : undefined, // Only set target on first attempt
          execute: shouldExecute,
          logger,
          callerTool: 'course_correct',
        });

        // If no encounter on first try, do hohmann transfer first
        if (burn === 0 && !result.success && result.error?.toLowerCase().includes('no encounter')) {
          logger?.info(`[CourseCorrect] No encounter, attempting Hohmann transfer first`);
          const hohmannResult = await orchestrator.hohmannTransfer('COMPUTED', false, {
            target,
            execute: shouldExecute,
            logger,
            callerTool: 'course_correct',
          });
          if (!hohmannResult.success) {
            return ctx.errorResponse('course_correct', result.error ?? 'No encounter and hohmann failed');
          }
          // Retry course correction after hohmann (don't increment burn counter)
          continue;
        }

        if (!result.success) {
          return ctx.errorResponse('course_correct', result.error ?? 'Failed');
        }

        if (!shouldExecute) {
          // Not executing - just return node info
          return ctx.successResponse('course_correct',
            `Node: ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, T-${formatTime(result.timeToNode ?? 0)}\nTarget: ${(targetDistance / 1000).toFixed(0)}km`);
        }

        totalBurns++;

        // Check actual post-burn periapsis
        const postBurn = await queryActualPeriapsis(conn);
        if (!postBurn.hasEncounter) {
          return ctx.errorResponse('course_correct', 'Lost encounter after burn');
        }

        actualPe = postBurn.periapsis;
        const error = Math.abs(actualPe - targetDistance) / targetDistance;
        logger?.info(`[CourseCorrect] Post-burn ${totalBurns}: actual=${(actualPe / 1000).toFixed(1)}km (target: ${(targetDistance / 1000).toFixed(0)}km, error: ${(error * 100).toFixed(1)}%)`);

        // Record for secant method
        history.push({ input: inputPe, result: actualPe });

        // Check if we're within tolerance
        if (error <= TOLERANCE) {
          const encounterInfo = await queryTargetEncounterInfo(conn);
          let text = `Course corrected (${totalBurns} burn${totalBurns !== 1 ? 's' : ''})`;
          text += `\nTarget: ${(targetDistance / 1000).toFixed(0)}km → Achieved: ${(actualPe / 1000).toFixed(0)}km`;
          if (encounterInfo && encounterInfo.targetType === 'body') {
            text += `\nEncounter: ${encounterInfo.targetName} at ${(actualPe / 1000).toFixed(0)}km`;
            text += `\nNext: warp to ${encounterInfo.targetName} SOI, then circularize`;
          }
          return ctx.successResponse('course_correct', text);
        }

        // Calculate next input using secant method
        if (history.length >= 2) {
          const [p1, p2] = history.slice(-2);
          const slope = (p2.input - p1.input) / (p2.result - p1.result);
          inputPe = p2.input + (targetDistance - p2.result) * slope;
          // Clamp to reasonable bounds
          inputPe = Math.max(targetDistance * 0.01, Math.min(targetDistance * 100, inputPe));
          logger?.info(`[CourseCorrect] Secant: slope=${slope.toFixed(4)}, next input=${(inputPe / 1000).toFixed(1)}km`);
        } else {
          // First iteration: use ratio adjustment
          const ratio = targetDistance / actualPe;
          inputPe = inputPe * ratio;
          logger?.info(`[CourseCorrect] Ratio: ${ratio.toFixed(3)}, next input=${(inputPe / 1000).toFixed(1)}km`);
        }
      }

      // Max burns reached
      const encounterInfo = await queryTargetEncounterInfo(conn);
      const finalError = Math.abs(actualPe - targetDistance) / targetDistance;
      let text = `Partial correction (${totalBurns} burn${totalBurns !== 1 ? 's' : ''})`;
      text += `\nTarget: ${(targetDistance / 1000).toFixed(0)}km → Achieved: ${(actualPe / 1000).toFixed(0)}km`;

      if (encounterInfo && encounterInfo.targetType === 'body') {
        text += `\nEncounter: ${encounterInfo.targetName} at ${(actualPe / 1000).toFixed(0)}km`;
        if (finalError <= TOLERANCE) {
          text += `\nNext: warp to ${encounterInfo.targetName} SOI, then circularize`;
        } else if (actualPe >= 10_000) {
          text += ` (acceptable)\nNext: warp to ${encounterInfo.targetName} SOI, then circularize`;
        } else {
          text += ` (may need additional correction)`;
        }
      }

      return ctx.successResponse('course_correct', text);
    } catch (error) {
      return ctx.errorResponse('course_correct', error instanceof Error ? error.message : String(error));
    }
  },
};
