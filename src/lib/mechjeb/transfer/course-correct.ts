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
import { formatTime,  fmtVel } from '../../utils/format.js';

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
 * Calculate the next input value using interpolation from previous attempts.
 * Uses secant method when we have 2+ data points, simple scaling otherwise.
 */
function calculateNextInput(target: number, history: Array<{ input: number; result: number }>): number {
  const MIN_INPUT = target * 0.1;
  const MAX_INPUT = target * 10;

  // Helper to clamp and validate
  const clampResult = (value: number): number => {
    if (!Number.isFinite(value)) return target;  // Fallback for NaN/Infinity
    return Math.max(MIN_INPUT, Math.min(MAX_INPUT, value));
  };

  if (history.length < 2) {
    // Not enough data - use simple scaling
    const last = history.at(-1);
    if (!last) return target; // Shouldn't happen, but fallback to target
    if (last.result === Infinity) return clampResult(last.input * 2); // No encounter
    if (last.result === 0) return target; // Avoid division by zero
    const ratio = target / last.result;
    return clampResult(last.input * ratio);
  }

  // Use secant method with last two points
  const [p1, p2] = history.slice(-2);

  // Handle no-encounter cases
  if (p2.result === Infinity) return clampResult(p2.input * 2);
  if (p1.result === Infinity) {
    // Interpolate between p2 and infinity
    return clampResult(p2.input + (p2.input - p1.input) * 0.5);
  }

  // Check for identical results (would cause division by zero)
  const resultDiff = p2.result - p1.result;
  if (Math.abs(resultDiff) < 1) {
    // Results too similar - try adjusting input by 20%
    // If result < target, increase input; if result > target, decrease input
    const adjustmentFactor = p2.result < target ? 1.2 : 0.8;
    return clampResult(p2.input * adjustmentFactor);
  }

  // Secant method: find input that would give target result
  const slope = (p2.input - p1.input) / resultDiff;
  const newInput = p2.input + (target - p2.result) * slope;

  return clampResult(newInput);
}

// Extended result type with iteration info
export interface IterativeCourseResult extends ManeuverResult {
  attempts: number;
  finalPeriapsis: number;
}

/**
 * Create a maneuver node for course correction using iterative refinement.
 * Adjusts trajectory to achieve desired periapsis at target within 15% tolerance.
 *
 * The function iteratively:
 * 1. Creates a course correction node with current input
 * 2. Checks the resulting periapsis via NEXTNODE:ORBIT:NEXTPATCH:PERIAPSIS
 * 3. If not within tolerance, clears the node and adjusts input using interpolation
 * 4. Repeats until within tolerance or max attempts reached
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
  const MAX_ATTEMPTS = 10;
  const TOLERANCE = 0.15; // 15%

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

  // For bodies, MechJeb expects distance from body center, but user provides altitude above surface
  // Convert altitude → distance by adding body radius
  const bodyRadius = targetInfo.radius ?? 0;
  const isBody = targetInfo.class !== 'vessel';
  const targetDistanceFromCenter = isBody ? targetPeriapsis + bodyRadius : targetPeriapsis;

  // Track attempts for interpolation: [inputValue, resultingPeriapsis]
  const history: Array<{ input: number; result: number }> = [];
  let currentInput = targetDistanceFromCenter;
  let bestResult: { input: number; result: number; error: number } | null = null;

  if (isBody && bodyRadius > 0) {
    logger?.info(`[CourseCorrect] Target: ${(targetPeriapsis / 1000).toFixed(1)}km altitude (${targetInfo.name} radius: ${(bodyRadius / 1000).toFixed(0)}km)`);
  } else {
    logger?.info(`[CourseCorrect] Target: ${(targetPeriapsis / 1000).toFixed(1)}km, tolerance: ${TOLERANCE * 100}%`);
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Clear any existing node
    await conn.execute('IF HASNODE { REMOVE NEXTNODE. }', 2000);

    // Create node with current input
    const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:COURSECORRECTION(${currentInput}).`;
    const result = await conn.execute(cmd, 10_000);

    if (!result.output.includes('True')) {
      logger?.warn(`[CourseCorrect] Attempt ${attempt}: Failed to create node`);
      continue;
    }

    // Check resulting periapsis (kOS returns altitude above surface)
    const nodeResult = await queryNodePeriapsis(conn);
    if (!nodeResult.hasEncounter) {
      // No encounter - need higher input to get closer
      logger?.info(`[CourseCorrect] Attempt ${attempt}: No encounter, increasing input`);
      history.push({ input: currentInput, result: Infinity });
      currentInput *= 2; // Double if no encounter
      continue;
    }

    // kOS returns altitude; convert to distance-from-center for consistent iteration
    const resultAltitude = nodeResult.periapsis;
    const resultDistFromCenter = isBody ? resultAltitude + bodyRadius : resultAltitude;
    const error = (resultDistFromCenter - targetDistanceFromCenter) / targetDistanceFromCenter;

    // Log in altitude terms (what user understands)
    logger?.info(`[CourseCorrect] Attempt ${attempt}: input=${((currentInput - bodyRadius) / 1000).toFixed(1)}km → result=${(resultAltitude / 1000).toFixed(1)}km (error=${(error * 100).toFixed(1)}%)`);

    history.push({ input: currentInput, result: resultDistFromCenter });

    // Track best result (store altitude for display)
    if (!bestResult || Math.abs(error) < Math.abs(bestResult.error)) {
      bestResult = { input: currentInput, result: resultAltitude, error };
    }

    // Check if within tolerance
    if (Math.abs(error) <= TOLERANCE) {
      const nodeInfo = await queryNodeInfo(conn);
      logger?.info(`[CourseCorrect] Success! Achieved ${(resultAltitude / 1000).toFixed(1)}km altitude in ${attempt} attempt(s)`);
      return {
        success: true,
        deltaV: nodeInfo.deltaV,
        timeToNode: nodeInfo.timeToNode,
        attempts: attempt,
        finalPeriapsis: resultAltitude,  // Return altitude, not distance-from-center
      };
    }

    // Adjust input using interpolation/secant method (in distance-from-center space)
    currentInput = calculateNextInput(targetDistanceFromCenter, history);
  }

  // All attempts exhausted - use best result if reasonable
  if (bestResult && Math.abs(bestResult.error) < 0.5) {
    // Within 50% - acceptable with warning
    logger?.warn(`[CourseCorrect] Max attempts reached. Using best result: ${(bestResult.result / 1000).toFixed(1)}km altitude (${(bestResult.error * 100).toFixed(1)}% error)`);

    // Re-create with best input
    await conn.execute('IF HASNODE { REMOVE NEXTNODE. }', 2000);
    await conn.execute(`SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PLANNER:COURSECORRECTION(${bestResult.input}).`, 10_000);
    const nodeInfo = await queryNodeInfo(conn);
    return {
      success: true,
      deltaV: nodeInfo.deltaV,
      timeToNode: nodeInfo.timeToNode,
      attempts: MAX_ATTEMPTS,
      finalPeriapsis: bestResult.result,  // Already storing altitude
    };
  }

  return {
    success: false,
    error: `Could not achieve target periapsis after ${MAX_ATTEMPTS} attempts. Best result: ${bestResult ? (bestResult.result / 1000).toFixed(1) + 'km altitude' : 'none'}`,
    attempts: MAX_ATTEMPTS,
    finalPeriapsis: bestResult?.result ?? 0,
  };
}

// ============================================================================
// Tool Definition
// ============================================================================

export const courseCorrectTool: ToolDefinition = {
  name: 'course_correct',
  description: 'Fine tune arrival at target after starting trasfer.',
  inputSchema: {
    target: z.preprocess(parseTarget, z.union([z.string(), z.literal('auto')]))
      .optional()
      .default('auto')
      .describe('Target name (body or vessel) set by previous tool. Use get_targets to list available names.'),
    targetDistance: distanceSchema.optional().default(50_000).describe('Target periapsis (bodies) or closest approach (vessels) in meters (default: 50km)'),
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

      // Auto-select 2nd closest body if no target provided
      let target = args.target as string | undefined;
      if (!target || target === 'auto') {
        const autoTarget = await ctx.selectTarget(orchestrator, 'second-closest');
        target = autoTarget ?? undefined;  // Never pass 'auto' to kOS
      }

      // Try course correction
      let result = await orchestrator.courseCorrection(args.targetDistance as number, {
        target,
        execute: args.execute as boolean,
        logger,
        callerTool: 'course_correct',
      });

      // If no encounter, do hohmann transfer first
      if (!result.success && result.error?.toLowerCase().includes('no encounter')) {
        const hohmannResult = await orchestrator.hohmannTransfer('COMPUTED', false, {
          target,
          execute: args.execute as boolean,
          logger,
          callerTool: 'course_correct',
        });
        if (hohmannResult.success) {
          result = await orchestrator.courseCorrection(args.targetDistance as number, {
            execute: args.execute as boolean,
            logger,
            callerTool: 'course_correct',
          });
        }
      }

      if (!result.success) {
        return ctx.errorResponse('course_correct', result.error ?? 'Failed');
      }

      const targetDistance = args.targetDistance as number;
      const attempts = (result as { attempts?: number }).attempts ?? 1;
      const finalPe = (result as { finalPeriapsis?: number }).finalPeriapsis ?? 0;

      let text = result.executed
        ? 'Burn complete'
        : `Node: ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, T-${formatTime(result.timeToNode ?? 0)}`;
      text += `\nTarget: ${(targetDistance / 1000).toFixed(0)}km → Achieved: ${(finalPe / 1000).toFixed(0)}km (${attempts} attempt${attempts !== 1 ? 's' : ''})`;

      // Show trajectory status - critical for LLM to know state
      const { queryTargetEncounterInfo } = await import('../shared.js');
      const encounterInfo = await queryTargetEncounterInfo(conn);
      if (encounterInfo && encounterInfo.targetType === 'body') {
        const peAlt = encounterInfo.periapsisInTargetSOI ?? finalPe;
        const encPeKm = (peAlt / 1000).toFixed(0);
        if (peAlt >= 10_000) {
          text += `\nTrajectory corrected! Encounter: ${encounterInfo.targetName} at ${encPeKm}km (safe)`;
          text += `\nNext: warp to ${encounterInfo.targetName} SOI, then circularize`;
        } else if (peAlt > 0) {
          text += `\nEncounter: ${encounterInfo.targetName} at ${encPeKm}km (low but safe)`;
          text += `\nNext: warp to ${encounterInfo.targetName} SOI, then circularize`;
        } else {
          text += `\nEncounter: ${encounterInfo.targetName} at ${encPeKm}km - still unsafe, run course_correct again`;
        }
      }

      return ctx.successResponse('course_correct', text);
    } catch (error) {
      return ctx.errorResponse('course_correct', error instanceof Error ? error.message : String(error));
    }
  },
};
