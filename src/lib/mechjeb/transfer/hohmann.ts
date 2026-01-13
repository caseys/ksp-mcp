/**
 * Hohmann Transfer - Transfer to target body or vessel
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { queryNodeInfo, queryTargetEncounterInfo, queryWrongEncounterDetails, sanitizeError, type ManeuverResult } from '../shared.js';
import { rcsFineTune, createPeriapsisQuery } from '../execute-node.js';
import { clearNodes } from '../../kos/nodes.js';
import { delay } from '../../utils/progress.js';
import { validateTarget } from '../../kos/target/validate.js';
import { validateVesselState, ORBITING_ONLY_REQUIREMENTS } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import { z } from 'zod';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, autoTargetSchema } from '../../tool-types.js';
import { formatTime,  fmtVel } from '../../utils/format.js';

/**
 * Result from a single transfer attempt (before retry logic)
 */
interface TransferAttemptResult {
  success: boolean;
  noEncounter?: boolean;  // true if failed specifically due to no encounter
  wrongEncounter?: string;  // name of wrong body if encounter is with wrong target
  error?: string;
  deltaV?: number;
  timeToNode?: number;
  nodesCreated?: number;
}

/**
 * Attempt a single Hohmann transfer with given mode.
 * Does not include retry logic - just tries once and reports result.
 */
async function attemptHohmannTransfer(
  conn: KosConnection,
  timeRef: string,
  capture: boolean,
  rendezvous: boolean,
  targetName: string
): Promise<TransferAttemptResult> {
  const captureStr = capture ? 'TRUE' : 'FALSE';
  const rendezvousStr = rendezvous ? 'TRUE' : 'FALSE';
  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. SET PLANNER:HOHMANNRENDEZVOUS TO ${rendezvousStr}. PRINT PLANNER:HOHMANN("${timeRef}", ${captureStr}).`;
  const result = await conn.execute(cmd, 10_000);

  const success = result.output.includes('True');
  if (!success) {
    return { success: false, error: sanitizeError(result.output, 'Hohmann transfer') };
  }

  // Query node info
  const nodeInfo = await queryNodeInfo(conn);

  // Verify encounter exists AND is with the correct target
  const encounterCheck = await conn.execute(
    'IF NEXTNODE:ORBIT:HASNEXTPATCH { PRINT NEXTNODE:ORBIT:NEXTPATCH:BODY:NAME. } ELSE { PRINT "NO_ENCOUNTER". }',
    3000
  );
  const encounterBody = encounterCheck.output.trim();

  if (encounterBody === 'NO_ENCOUNTER') {
    return { success: false, noEncounter: true };
  }

  // Check if encounter is with the correct target (case-insensitive)
  if (targetName && encounterBody.toLowerCase() !== targetName.toLowerCase()) {
    // Include node info so caller can decide whether to keep nodes
    return {
      success: false,
      wrongEncounter: encounterBody,
      deltaV: nodeInfo.deltaV,
      timeToNode: nodeInfo.timeToNode,
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

/**
 * Create a maneuver node for a Hohmann transfer to the target.
 * Requires a target to be set first.
 *
 * Includes validation:
 * - Checks target is set before planning
 * - Verifies encounter exists after node creation
 * - Confirms encounter is with correct target
 * - Auto-retries with opposite mode if NO_ENCOUNTER on first attempt
 *
 * @param conn kOS connection
 * @param timeRef When to execute: 'COMPUTED', 'PERIAPSIS', 'APOAPSIS'
 * @param capture Include capture burn
 * @param rendezvous true for rendezvous mode (optimizes encounter timing), false for simple transfer
 */
export async function hohmannTransfer(
  conn: KosConnection,
  timeRef = 'COMPUTED',
  capture = false,
  rendezvous = true
): Promise<ManeuverResult> {
  // Validate vessel state: must be in stable orbit
  const vesselValidation = await validateVesselState(conn, ORBITING_ONLY_REQUIREMENTS, 'hohmann_transfer');
  if (!vesselValidation.valid) {
    return { success: false, error: vesselValidation.error };
  }

  // Pre-validate target: must be moon or vessel in same SOI
  const validation = await validateTarget(conn, {
    allowedClasses: ['moon', 'vessel'],
    requireSameSOI: true,
  }, 'hohmann_transfer');

  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const targetName = validation.targetInfo?.name ?? '';

  // Check if we already have an encounter with the target
  if (validation.targetInfo?.hasEncounter &&
      validation.targetInfo?.encounterBody?.toLowerCase() === targetName.toLowerCase()) {

    // Reuse existing helper to get encounter details
    const encounterInfo = await queryTargetEncounterInfo(conn);
    if (encounterInfo?.targetType === 'body') {
      const peAlt = encounterInfo.periapsisInTargetSOI ?? 0;
      const encPeKm = (peAlt / 1000).toFixed(0);

      // Same advice pattern as post-transfer logic
      if (peAlt < 10_000) {
        return {
          success: false,
          error: `Already have encounter with ${targetName} at ${encPeKm}km - UNSAFE trajectory!\n` +
                 `REQUIRED: Use course_correct to fix trajectory before doing anything else.`
        };
      } else {
        return {
          success: false,
          error: `Already have encounter with ${targetName} at ${encPeKm}km (safe).\n` +
                 `Next: warp to ${targetName} SOI, then circularize\n` +
                 `Use course_correct if you need to adjust approach.`
        };
      }
    }
  }

  const firstMode = rendezvous ? 'rendezvous' : 'transfer';
  const secondMode = rendezvous ? 'transfer' : 'rendezvous';

  // First attempt with requested mode
  let attempt = await attemptHohmannTransfer(conn, timeRef, capture, rendezvous, targetName);

  // If NO_ENCOUNTER, retry with opposite mode
  if (attempt.noEncounter) {
    await clearNodes(conn);

    // Retry with opposite mode
    attempt = await attemptHohmannTransfer(conn, timeRef, capture, !rendezvous, targetName);

    if (attempt.noEncounter) {
      // Both modes failed - return error
      await clearNodes(conn);
      return {
        success: false,
        error: `❌ Hohmann transfer NO ENCOUNTER with both modes!\n` +
               `Tried: ${firstMode}, then ${secondMode}\n` +
               'The transfer trajectory does not intersect the target.\n' +
               'Consider waiting for better phase angle.'
      };
    }
  }

  // Handle wrong encounter - analyze trajectory and decide best approach
  if (attempt.wrongEncounter) {
    const originalTarget = targetName;
    const detourBody = attempt.wrongEncounter;

    // Query encounter details BEFORE clearing nodes
    const details = await queryWrongEncounterDetails(conn, detourBody);

    // Decision tree based on trajectory analysis
    if (details) {
      const encPeKm = (details.encounterPeriapsis / 1000).toFixed(0);
      const xferApMm = (details.transferApoapsis / 1_000_000).toFixed(1);
      const tgtSmaMm = (details.targetSMA / 1_000_000).toFixed(1);

      // Case 1: Crash trajectory - keep nodes, warn about course_correct required
      if (details.isCrash) {
        // Query node count for the kept nodes
        const nodeCountResult = await conn.execute('PRINT ALLNODES:LENGTH.', 2000);
        const nodesCreated = Number.parseInt(nodeCountResult.output.match(/\d+/)?.[0] || '1');

        return {
          success: true,
          deltaV: attempt.deltaV,
          timeToNode: attempt.timeToNode,
          nodesCreated,
          warning: `⚠️ CRASH TRAJECTORY at ${detourBody}! Periapsis: ${encPeKm}km\n` +
                   `Target was ${originalTarget}, but ${detourBody} is in the way.\n` +
                   `Transfer apoapsis: ${xferApMm}Mm (target orbit: ${tgtSmaMm}Mm)\n` +
                   `REQUIRED: Use course_correct immediately to raise periapsis and adjust trajectory.`
        };
      }

      // Case 2: Safe encounter + close approach to target - keep nodes, suggest course_correct
      if (details.hasCloseApproach) {
        // Query node count for the kept nodes
        const nodeCountResult = await conn.execute('PRINT ALLNODES:LENGTH.', 2000);
        const nodesCreated = Number.parseInt(nodeCountResult.output.match(/\d+/)?.[0] || '1');

        return {
          success: true,
          deltaV: attempt.deltaV,
          timeToNode: attempt.timeToNode,
          nodesCreated,
          warning: `${detourBody} flyby en route to ${originalTarget}.\n` +
                   `Encounter periapsis: ${encPeKm}km (safe)\n` +
                   `Transfer apoapsis: ${xferApMm}Mm reaches ${originalTarget} orbit (${tgtSmaMm}Mm)\n` +
                   `After ${detourBody} flyby: use course_correct to fine-tune approach to ${originalTarget}.`
        };
      }
    }

    // Case 3: Safe but no close approach - replan detour to encountered body
    await clearNodes(conn);

    // Set new target to the accidentally-encountered body
    await conn.execute(`SET TARGET TO BODY("${detourBody}").`, 3000);

    // Replan Hohmann transfer to detour body - use same two-step retry logic
    let detourAttempt = await attemptHohmannTransfer(conn, timeRef, capture, rendezvous, detourBody);

    // If NO_ENCOUNTER on first try, retry with opposite mode
    if (detourAttempt.noEncounter) {
      await clearNodes(conn);
      detourAttempt = await attemptHohmannTransfer(conn, timeRef, capture, !rendezvous, detourBody);
    }

    if (!detourAttempt.success) {
      // Build descriptive error message
      let errorDetail = detourAttempt.error ?? '';
      if (detourAttempt.noEncounter) errorDetail = 'no encounter with either mode';
      if (detourAttempt.wrongEncounter) errorDetail = `wrong encounter: ${detourAttempt.wrongEncounter}`;
      return {
        success: false,
        error: `Failed to plan detour to ${detourBody}: ${errorDetail || 'unknown error'}`
      };
    }

    // Return success with warning about the detour
    return {
      success: true,
      deltaV: detourAttempt.deltaV,
      timeToNode: detourAttempt.timeToNode,
      nodesCreated: detourAttempt.nodesCreated,
      warning: `Direct transfer to ${originalTarget} not possible - ${detourBody} is in the way.\n` +
               `Transfer does not reach ${originalTarget} orbit, so detour planned to ${detourBody}.\n` +
               `After ${detourBody} encounter: use course_correct for gravity assist toward ${originalTarget}.`
    };
  }

  // Handle other errors
  if (!attempt.success) {
    return { success: false, error: attempt.error ?? 'Hohmann transfer failed' };
  }

  return {
    success: true,
    deltaV: attempt.deltaV,
    timeToNode: attempt.timeToNode,
    nodesCreated: attempt.nodesCreated,
  };
}

// ============================================================================
// Tool Definition
// ============================================================================

export const hohmannTransferTool: ToolDefinition = {
  name: 'hohmann_transfer',
  description: 'Transfer to moon or vessel.',
  inputSchema: {
    target: autoTargetSchema,
    mode: z.enum(['rendezvous', 'transfer'])
      .optional()
      .default('rendezvous')
      .describe('Transfer mode: "rendezvous" (default) optimizes encounter timing, "transfer" for simple orbit change'),
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

      // Auto-select target if not provided (use 2nd closest to avoid targeting current SOI body)
      let target = args.target as string | undefined;
      if (!target || target === 'auto') {
        const autoTarget = await ctx.selectTarget(orchestrator, 'second-closest');
        target = autoTarget ?? undefined;  // Never pass 'auto' to kOS
      }

      // Convert mode to rendezvous boolean
      const mode = (args.mode as string | undefined) ?? 'rendezvous';
      const rendezvous = mode === 'rendezvous';

      // Note: Using hardcoded defaults for timeRef/capture - MechJeb does not have working capture logic
      const result = await orchestrator.hohmannTransfer('COMPUTED', false, {
        target,
        execute: args.execute as boolean,
        logger,
        callerTool: 'hohmann_transfer',
        rendezvous,
      });

      if (result.success) {
        const nodeCount = result.nodesCreated ?? 1;
        let text = result.executed
          ? 'Burn complete'
          : `${nodeCount} node(s): ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, T-${formatTime(result.timeToNode ?? 0)}`;

        // Query current encounter info for guidance
        const encounterInfo = await queryTargetEncounterInfo(conn);

        // Post-burn RCS fine-tune: IMPROVE accuracy after main burn executes
        // Only applies when burn was executed and we have an encounter that needs refinement
        let didFineTune = false;
        if (result.executed && encounterInfo?.targetType === 'body') {
          const currentPe = encounterInfo.periapsisInTargetSOI ?? 0;
          const atmosphereHeight = encounterInfo.atmosphereHeight ?? 0;

          // Acceptable range: 40km (or atmo+40km) to 1000km
          const minSafePe = atmosphereHeight > 0 ? atmosphereHeight + 40_000 : 40_000;
          const maxAcceptablePe = 1_000_000; // 1000km

          // Fine-tune target: minimum safe altitude
          const targetPe = minSafePe;

          // Fine-tune if periapsis is outside acceptable range
          const needsFineTune = currentPe < minSafePe || currentPe > maxAcceptablePe;

          if (needsFineTune) {
            const atmNote = atmosphereHeight > 0 ? ` (atmo: ${(atmosphereHeight / 1000).toFixed(0)}km)` : '';
            logger.info?.(`[Hohmann] Post-burn Pe: ${(currentPe / 1000).toFixed(0)}km${atmNote}, fine-tuning to ${targetPe / 1000}km...`);

            // Align and enable RCS for fine-tuning
            await conn.execute('SAS ON. WAIT 0.3. SET SASMODE TO "PROGRADE". RCS ON.', 5000);
            await delay(2000);

            const fineTuneResult = await rcsFineTune(conn, {
              queryProperty: createPeriapsisQuery(),
              targetValue: targetPe,
              controlAxis: 'fore',
              directionStrategy: 'higher-means-negative',
              tolerance: { relative: 0.25 },
              limits: { maxPulses: 15, maxReversals: 3 },
              logger,
              logPrefix: 'Hohmann',
            });

            // Cleanup RCS
            await conn.execute('SET SHIP:CONTROL:FORE TO 0. RCS OFF.', 3000);
            didFineTune = true;

            if (fineTuneResult.success) {
              const finalPeKm = (fineTuneResult.finalValue / 1000).toFixed(0);
              text += `\nRCS fine-tuned: ${(currentPe / 1000).toFixed(0)}km → ${finalPeKm}km`;
              logger.progress?.(`[Hohmann] Fine-tuned to ${finalPeKm}km (${fineTuneResult.pulsesUsed} pulses)`);
            } else {
              logger.info?.(`[Hohmann] Fine-tune incomplete: ${fineTuneResult.reason}`);
            }
          }
        }

        // Re-query encounter info if fine-tuning occurred (to get updated periapsis)
        const finalEncounterInfo = didFineTune ? await queryTargetEncounterInfo(conn) : encounterInfo;

        if (finalEncounterInfo && finalEncounterInfo.targetType === 'body') {
          const peAlt = finalEncounterInfo.periapsisInTargetSOI ?? 0;
          const encPeKm = (peAlt / 1000).toFixed(0);
          const finalAtmoHeight = finalEncounterInfo.atmosphereHeight ?? 0;
          const finalMinSafePe = finalAtmoHeight > 0 ? finalAtmoHeight + 40_000 : 40_000;

          text += `\nEncounter: ${finalEncounterInfo.targetName} at ${encPeKm}km`;

          // CLEAR directive based on trajectory safety (must be above atmosphere + 40km, or 40km for airless)
          if (peAlt < finalMinSafePe) {
            // Unsafe trajectory - MUST fix before warping
            const reason = finalAtmoHeight > 0
              ? `below safe altitude (atmo: ${(finalAtmoHeight / 1000).toFixed(0)}km)`
              : 'too low';
            text += ` - UNSAFE (${reason})!`;
            text += `\nREQUIRED: Use course_correct to fix trajectory before doing anything else.`;
          } else {
            // Safe trajectory - can proceed
            text += ` (safe)`;
            text += `\nNext: warp to ${finalEncounterInfo.targetName} SOI, then circularize`;
          }
        }

        // Add warning if present (e.g., detour due to wrong encounter)
        if (result.warning) {
          text += `\n\nWARNING: ${result.warning}`;
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
