/**
 * Course Correction - Fine-tune approach trajectory
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { queryNodeInfo, queryWrongEncounterDetails, type ManeuverResult } from '../shared.js';
import { getTargetValidationInfo, type TargetInfo } from '../../kos/target/validate.js';
import { validateVesselState, ORBITAL_REQUIREMENTS, getVesselStateInfo } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition, McpLogger } from '../../tool-types.js';
import { executeSchema, distanceSchema, parseTarget } from '../../tool-types.js';
import { formatTime, fmtVel } from '../../utils/format.js';
import { determineTransferType, executeSmartTransfer } from '../meta/transfer.js';

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
 * Check if a pending maneuver node would create an encounter with the target.
 * Returns encounter info from the node's predicted orbit.
 */
async function queryNodeEncounter(conn: KosConnection): Promise<{ hasNode: boolean; hasEncounter: boolean; encounterBody?: string }> {
  const result = await conn.execute(
    'IF HASNODE { ' +
    'IF NEXTNODE:ORBIT:HASNEXTPATCH { ' +
    'PRINT "NODE_ENC|" + NEXTNODE:ORBIT:NEXTPATCH:BODY:NAME. ' +
    '} ELSE { PRINT "NODE_NOENC". } ' +
    '} ELSE { PRINT "NONODE". }',
    3000
  );

  if (result.output.includes('NONODE')) {
    return { hasNode: false, hasEncounter: false };
  }
  if (result.output.includes('NODE_NOENC')) {
    return { hasNode: true, hasEncounter: false };
  }

  const match = result.output.match(/NODE_ENC\|(\w+)/);
  return {
    hasNode: true,
    hasEncounter: match !== null,
    encounterBody: match?.[1],
  };
}

/**
 * Query the current periapsis from actual orbit (not a node prediction).
 * Uses MechJeb INFO:TPERI which reliably calculates encounter periapsis.
 * Retries with delay to handle physics settling after burns.
 */
async function queryActualPeriapsis(conn: KosConnection, retries = 3): Promise<{ hasEncounter: boolean; periapsis: number }> {
  for (let attempt = 0; attempt < retries; attempt++) {
    if (attempt > 0) {
      // Wait for physics to settle before retry
      await new Promise(r => setTimeout(r, 1000));
    }

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
      // Couldn't parse - retry
      continue;
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
      break;
    }
    }

    if (value > 0) {
      return { hasEncounter: true, periapsis: value };
    }
  }

  return { hasEncounter: false, periapsis: 0 };
}

/**
 * Info about closest approach to target (even without formal SOI encounter)
 */
interface ClosestApproachInfo {
  hasApproach: boolean;
  distance: number;          // meters
  time: number;              // seconds from now
  inCurrentPatch: boolean;   // true if in current orbit, false if future patch
  patchBody?: string;        // body name if in future patch
  intermediateBody?: string; // if there's an encounter with a body before reaching target
}

/**
 * Query closest approach to target, even if no formal SOI encounter exists.
 * Uses MechJeb TGT module first, then kOS orbit suffixes, then geometric check.
 */
async function queryClosestApproach(conn: KosConnection): Promise<ClosestApproachInfo> {
  const script = `
    LOCAL found IS FALSE.
    LOCAL dist IS 0.
    LOCAL t IS 0.
    LOCAL inCurrent IS TRUE.
    LOCAL patchBody IS "".
    LOCAL intermediate IS "".

    // First try MechJeb TGT module - works even for non-intersecting orbits
    IF HASTARGET AND ADDONS:MJ:HASSUFFIX("TGT") {
      LOCAL mjDist IS ADDONS:MJ:TGT:CLOSESTAPPROACHDISTANCE.
      LOCAL mjTime IS ADDONS:MJ:TGT:CLOSESTAPPROACHTIME.
      IF mjDist > 0 AND mjTime > 0 {
        SET found TO TRUE.
        SET dist TO mjDist.
        SET t TO mjTime.
      }
    }

    // Check for intermediate body (transfer through wrong moon)
    IF SHIP:ORBIT:HASNEXTPATCH {
      LOCAL nextBody IS SHIP:ORBIT:NEXTPATCH:BODY:NAME.
      IF HASTARGET AND nextBody <> TARGET:NAME {
        SET intermediate TO nextBody.
      }
    }

    // Fallback: kOS orbit suffixes (only works for intersecting orbits)
    IF NOT found AND HASTARGET AND SHIP:ORBIT:TARGETDISTANCE > 0 {
      SET found TO TRUE.
      SET dist TO SHIP:ORBIT:TARGETDISTANCE.
      SET t TO SHIP:ORBIT:TARGETTIME.
    }

    // Fallback: check future patches
    IF NOT found {
      LOCAL patch IS SHIP:ORBIT.
      LOCAL count IS 0.
      UNTIL count > 5 {
        IF patch:HASNEXTPATCH {
          SET patch TO patch:NEXTPATCH.
          SET patchBody TO patch:BODY:NAME.
          IF HASTARGET AND patch:TARGETDISTANCE > 0 {
            SET found TO TRUE.
            SET dist TO patch:TARGETDISTANCE.
            SET t TO patch:TARGETTIME.
            SET inCurrent TO FALSE.
            BREAK.
          }
        } ELSE { BREAK. }
        SET count TO count + 1.
      }
    }

    // Final fallback: geometric check - does our orbit reach the target's orbital radius?
    // If apoapsis >= target's semi-major axis * 0.8, we're in a potential transfer orbit
    IF NOT found AND HASTARGET AND TARGET:TYPENAME = "Body" AND TARGET:HASSUFFIX("ORBIT") {
      LOCAL tgtSma IS TARGET:ORBIT:SEMIMAJORAXIS.
      LOCAL shipApo IS APOAPSIS + SHIP:BODY:RADIUS.
      IF shipApo >= tgtSma * 0.8 {
        SET found TO TRUE.
        SET dist TO TARGET:DISTANCE.
        SET t TO ETA:APOAPSIS.
      }
    }

    IF found {
      PRINT "CA|" + ROUND(dist) + "|" + ROUND(t) + "|" + inCurrent + "|" + patchBody + "|" + intermediate.
    } ELSE {
      PRINT "NOCA".
    }
  `.trim().replaceAll('\n', ' ');

  const result = await conn.execute(script, 10_000);
  const output = result.output.trim();

  // Check for no closest approach
  if (output.endsWith('NOCA')) {
    return { hasApproach: false, distance: 0, time: 0, inCurrentPatch: true };
  }

  // Parse CA|dist|time|inCurrent|patchBody|intermediate
  const match = output.match(/CA\|(\d+)\|(\d+)\|(True|False)\|([^|]*)\|([^|]*)$/i);
  if (!match) {
    return { hasApproach: false, distance: 0, time: 0, inCurrentPatch: true };
  }

  return {
    hasApproach: true,
    distance: parseInt(match[1]),
    time: parseInt(match[2]),
    inCurrentPatch: match[3].toLowerCase() === 'true',
    patchBody: match[4] || undefined,
    intermediateBody: match[5] || undefined,
  };
}

/**
 * Handle detour scenario when an intermediate body is between us and target.
 * Analyzes trajectory and returns appropriate guidance or error.
 */
async function handleDetourScenario(
  conn: KosConnection,
  caInfo: ClosestApproachInfo,
  targetInfo: TargetInfo,
  logger?: McpLogger
): Promise<IterativeCourseResult | null> {
  const intermediateBody = caInfo.intermediateBody!;

  // Query encounter details with intermediate body
  // Note: This function expects nodes to exist, but we may not have nodes yet
  // We'll need to check what we can query without nodes
  const details = await queryWrongEncounterDetails(conn, intermediateBody);

  if (!details) {
    // Can't get details - just inform user about the situation
    logger?.info(`[CourseCorrect] Intermediate body ${intermediateBody} detected but can't query details`);
    return {
      success: false,
      error: `Encounter with ${intermediateBody} before reaching ${targetInfo.name}.\n` +
             `Closest approach to ${targetInfo.name}: ${(caInfo.distance / 1000).toFixed(0)}km in ${formatTime(caInfo.time)}\n\n` +
             `Options:\n` +
             `1. Complete ${intermediateBody} flyby first, then retarget ${targetInfo.name}\n` +
             `2. Use course_correct with target=${intermediateBody} to adjust flyby`,
      attempts: 0,
      finalPeriapsis: 0,
    };
  }

  const encPeKm = (details.encounterPeriapsis / 1000).toFixed(0);

  if (details.isCrash) {
    // Crash trajectory with intermediate - must fix first
    return {
      success: false,
      error: `CRASH TRAJECTORY at ${intermediateBody}! Periapsis: ${encPeKm}km\n` +
             `Target was ${targetInfo.name}, but ${intermediateBody} is in the way.\n\n` +
             `REQUIRED: Use course_correct with target=${intermediateBody} to raise periapsis first.`,
      attempts: 0,
      finalPeriapsis: details.encounterPeriapsis,
    };
  }

  if (details.hasCloseApproach) {
    // Safe flyby of intermediate, close approach to actual target exists
    logger?.info(`[CourseCorrect] Safe ${intermediateBody} flyby (${encPeKm}km) en route to ${targetInfo.name}`);
    // Return null to signal "proceed with normal course correction"
    return null;
  }

  // Safe encounter but no close approach to target - suggest detour
  return {
    success: false,
    error: `Encounter with ${intermediateBody} (Pe: ${encPeKm}km) blocks direct path to ${targetInfo.name}.\n` +
           `Closest approach to ${targetInfo.name}: ${(caInfo.distance / 1000).toFixed(0)}km\n\n` +
           `Suggestion: Complete ${intermediateBody} flyby first, then retarget ${targetInfo.name}.`,
    attempts: 0,
    finalPeriapsis: 0,
  };
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
    // No formal SOI encounter from ship's current orbit
    // Check if there's a pending node that WOULD create an encounter
    const nodeEnc = await queryNodeEncounter(conn);
    if (nodeEnc.hasNode && nodeEnc.hasEncounter) {
      // There's already a transfer node planned - user needs to execute it first
      const isCorrectTarget = nodeEnc.encounterBody?.toLowerCase() === targetInfo.name.toLowerCase();
      if (isCorrectTarget) {
        logger?.info(`[CourseCorrect] Pending node creates ${targetInfo.name} encounter - execute it first`);
        return {
          success: false,
          error: `Transfer node already planned with ${targetInfo.name} encounter.\n` +
                 `Execute the existing node first (use execute_node), then course_correct.`,
          attempts: 0,
          finalPeriapsis: 0,
        };
      } else {
        // Node creates encounter with different body
        logger?.info(`[CourseCorrect] Pending node creates ${nodeEnc.encounterBody} encounter, not ${targetInfo.name}`);
      }
    }

    // Check for closest approach
    const caInfo = await queryClosestApproach(conn);

    if (!caInfo.hasApproach) {
      // No approach at all - suggest hohmann transfer
      return {
        success: false,
        error: `No trajectory toward ${targetInfo.name}.\nUse hohmann_transfer first to establish a transfer orbit.`,
        attempts: 0,
        finalPeriapsis: 0,
      };
    }

    // Check for intermediate body (detour scenario)
    if (caInfo.intermediateBody) {
      logger?.info(`[CourseCorrect] Intermediate encounter: ${caInfo.intermediateBody}`);
      const detourResult = await handleDetourScenario(conn, caInfo, targetInfo, logger);
      if (detourResult !== null) {
        // Detour handler returned a result (error or guidance)
        return detourResult;
      }
      // null means "proceed with normal course correction" (safe flyby en route)
    }

    // Have closest approach but no SOI entry - log and continue
    logger?.info(`[CourseCorrect] Closest approach: ${(caInfo.distance / 1000).toFixed(0)}km in ${formatTime(caInfo.time)}` +
                 (caInfo.inCurrentPatch ? ' (current patch)' : ` (after ${caInfo.patchBody} encounter)`));
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

      // Validate target context before course correction
      if (target) {
        // Set target first to get proper info
        const targetResult = await orchestrator.setTarget(target);
        if (!targetResult.success) {
          return ctx.errorResponse('course_correct', targetResult.error ?? `Failed to set target "${target}"`);
        }

        const targetInfo = await getTargetValidationInfo(conn);
        if (!targetInfo) {
          return ctx.errorResponse('course_correct', `Target "${target}" not found`);
        }

        const bodyResult = await conn.execute('PRINT SHIP:BODY:NAME.', 2000);
        const currentBody = bodyResult.output.trim().split('\n').pop()?.trim() ?? '';

        // Body targets: must NOT be in current SOI (we're transferring TO it)
        if ((targetInfo.class === 'planet' || targetInfo.class === 'moon') && currentBody.toLowerCase() === target.toLowerCase()) {
            const orbitInfo = await ctx.getBasicOrbitInfo(conn);
            return ctx.successResponse('course_correct',
              `Already at ${target}! No course correction needed.\n` +
              `Orbit: Pe=${Math.round((orbitInfo?.periapsis ?? 0) / 1000)}km, Ap=${Math.round((orbitInfo?.apoapsis ?? 0) / 1000)}km`);
          }

        // Vessel targets: must be IN current SOI
        if (targetInfo.class === 'vessel' && !targetInfo.isInShipSOI) {
            return ctx.errorResponse('course_correct',
              `Vessel "${target}" is not in your current SOI (${currentBody}).\n` +
              `Course correction only works for vessels in the same sphere of influence.\n` +
              `Use transfer or interplanetary_transfer to reach the target's SOI first.`);
          }
      }

      let targetDistance = args.targetDistance as number;
      const shouldExecute = args.execute as boolean;

      // Validate target distance range
      const MIN_DISTANCE = 10_000;      // 10km minimum
      const MAX_DISTANCE = 2_500_000;   // 2500km maximum

      if (targetDistance < MIN_DISTANCE) {
        return ctx.errorResponse('course_correct',
          `Target periapsis ${(targetDistance / 1000).toFixed(1)}km is too low (min: 10km).\n` +
          `For landing, use 50-100km periapsis, then use landing tools.`);
      }

      // Clamp to max instead of erroring - user likely passed distance-to-target instead of periapsis
      if (targetDistance > MAX_DISTANCE) {
        logger.info(`[CourseCorrect] Requested ${(targetDistance / 1000).toFixed(0)}km exceeds max, using ${MAX_DISTANCE / 1000}km`);
        targetDistance = MAX_DISTANCE;
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

        // If no encounter on first try, do smart transfer (works for moons, planets, vessels)
        if (burn === 0 && !result.success && (result.error?.toLowerCase().includes('no encounter') || result.error?.toLowerCase().includes('no trajectory'))) {
          // Get target and vessel info to determine transfer type
          const targetInfo = await getTargetValidationInfo(conn);
          const vesselState = await getVesselStateInfo(conn);

          if (!targetInfo) {
            return ctx.errorResponse('course_correct', 'No target set');
          }

          const { transferType, error: transferError } = determineTransferType(
            targetInfo.class,
            targetInfo.name,
            targetInfo.isInShipSOI,
            vesselState.bodyType,
            vesselState.bodyName,
            vesselState.parentBodyName
          );

          if (transferError) {
            return ctx.errorResponse('course_correct', transferError);
          }

          // Execute the appropriate transfer using shared function
          logger?.info(`[CourseCorrect] No trajectory, using ${transferType} transfer to ${targetInfo.name}`);
          const transferResult = await executeSmartTransfer(orchestrator, transferType, {
            target,
            execute: shouldExecute,
            logger,
            callerTool: 'course_correct',
          });

          if (!transferResult.success) {
            return ctx.errorResponse('course_correct', transferResult.error ?? `${transferType} transfer failed`);
          }

          logger?.info(`[CourseCorrect] Transfer complete, now fine-tuning approach`);
          // Continue to retry course correction (don't increment burn counter)
          continue;
        }

        if (!result.success) {
          return ctx.errorResponse('course_correct', result.error ?? 'Failed');
        }

        // Post-creation validation: reject invalid nodes
        if (result.deltaV != null && result.deltaV < 0.1) {
          // Node is essentially 0 m/s - no correction needed or invalid
          await conn.execute('IF HASNODE { REMOVE NEXTNODE. }', 2000);
          return ctx.errorResponse('course_correct',
            `Course correction node is 0 m/s - no adjustment needed or trajectory already optimal.\n` +
            `Current trajectory may already be at target periapsis.`);
        }

        // Check if node is in current SOI (before any SOI transition)
        if (result.timeToNode != null) {
          const soiCheck = await conn.execute(
            'IF SHIP:ORBIT:HASNEXTPATCH { PRINT "SOI|" + ROUND(SHIP:ORBIT:NEXTPATCHETA). } ELSE { PRINT "NOSOI". }',
            2000
          );
          const soiMatch = soiCheck.output.match(/SOI\|(\d+)/);
          if (soiMatch) {
            const timeToSOI = parseInt(soiMatch[1]);
            if (result.timeToNode > timeToSOI) {
              // Node is after SOI transition - invalid
              await conn.execute('IF HASNODE { REMOVE NEXTNODE. }', 2000);
              return ctx.errorResponse('course_correct',
                `Course correction node is scheduled after SOI transition (T-${formatTime(result.timeToNode)} vs SOI in ${formatTime(timeToSOI)}).\n` +
                `Execute the transfer first, warp to SOI, then course correct.`);
            }
          }
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
