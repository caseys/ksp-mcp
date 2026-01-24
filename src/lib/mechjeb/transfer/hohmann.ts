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
  /** Close approach without SOI encounter (for low-gravity bodies like Minmus) */
  closeApproach?: {
    distance: number;  // meters
    time: number;      // seconds from now
  };
}

/**
 * Query close approach to target even without SOI encounter.
 * Uses the maneuver node's predicted orbit to check TARGETDISTANCE.
 */
async function queryCloseApproach(conn: KosConnection): Promise<{ distance: number; time: number } | null> {
  const result = await conn.queue(
    'IF HASTARGET AND NEXTNODE:ORBIT:TARGETDISTANCE > 0 { ' +
    'PRINT "CA|" + ROUND(NEXTNODE:ORBIT:TARGETDISTANCE) + "|" + ROUND(NEXTNODE:ORBIT:TARGETTIME). ' +
    '} ELSE { PRINT "NOCA". }',
    5000
  );

  const match = result.success ? result.output.match(/CA\|(\d+)\|(\d+)/) : null;
  if (match) {
    return {
      distance: Number.parseInt(match[1]),
      time: Number.parseInt(match[2]),
    };
  }
  return null;
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
  const result = await conn.queue(cmd, 10_000);

  const success = result.success && result.output.includes('True');
  if (!success) {
    return { success: false, error: sanitizeError(result.output, 'Hohmann transfer') };
  }

  // Verify MechJeb actually created a node (it returns True even when no node needed)
  const hasNodeCheck = await conn.queue('PRINT HASNODE.', 2000);
  if (!hasNodeCheck.success || !hasNodeCheck.output.includes('True')) {
    // MechJeb said success but didn't create a node - likely already on transfer
    return { success: false, noEncounter: false, error: 'MechJeb returned success but no node was created - vessel may already be on transfer trajectory' };
  }

  // Query node info
  const nodeInfo = await queryNodeInfo(conn);

  // Verify encounter exists AND is with the correct target
  const encounterCheck = await conn.queue(
    'IF NEXTNODE:ORBIT:HASNEXTPATCH { PRINT NEXTNODE:ORBIT:NEXTPATCH:BODY:NAME. } ELSE { PRINT "NO_ENCOUNTER". }',
    3000
  );
  const encounterBody = encounterCheck.success ? encounterCheck.output : 'NO_ENCOUNTER';

  if (encounterBody === 'NO_ENCOUNTER') {
    // No SOI encounter, but check for close approach (important for low-gravity bodies like Minmus)
    const closeApproach = await queryCloseApproach(conn);
    if (closeApproach) {
      // If we have a close approach, return success with the close approach info
      // The caller can decide based on distance whether this is acceptable
      return {
        success: true,
        deltaV: nodeInfo.deltaV,
        timeToNode: nodeInfo.timeToNode,
        nodesCreated: 1,
        closeApproach,
      };
    }
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
  const nodeCountResult = await conn.queue('PRINT ALLNODES:LENGTH.', 2000);
  const nodesCreated = nodeCountResult.success ? Number.parseInt(nodeCountResult.output.match(/\d+/)?.[0] || '1') : 1;

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

  // Check if target is current SOI body (can't transfer to where you already are)
  const soiResult = await conn.queue('PRINT SHIP:BODY:NAME.', 2000);
  const currentSOI = soiResult.success ? soiResult.output : '';
  if (targetName.toLowerCase() === currentSOI.toLowerCase()) {
    return {
      success: false,
      error: `Already orbiting ${targetName}! Cannot transfer to current SOI body.\n` +
             `Use adjust_orbit or circularize to modify your current orbit.`
    };
  }

  // Check if we already have a transfer trajectory to the target
  const encounterInfo = await queryTargetEncounterInfo(conn);
  const hasExistingTransfer = validation.targetInfo?.hasEncounter &&
      validation.targetInfo?.encounterBody?.toLowerCase() === targetName.toLowerCase();

  if (hasExistingTransfer && encounterInfo?.targetType === 'body') {
    const peAlt = encounterInfo.periapsisInTargetSOI ?? 0;
    const atmHeight = encounterInfo.atmosphereHeight ?? 0;
    const minSafePe = atmHeight > 0 ? atmHeight + 40_000 : 40_000;
    const optimalMaxPe = minSafePe + 50_000;
    const targetPeKm = Math.round(minSafePe / 1000);

    // Build response with labels (not raw numbers - LLMs misuse them)
    let text = `WARNING: Transfer to ${targetName} already in progress, no changes made.`;

    if (peAlt < minSafePe) {
      text += `\nEncounter: ${targetName} (UNSAFE - `;
      text += atmHeight > 0 ? `below atmosphere)` : `too low)`;
      text += `\nREQUIRED: course_correct with targetDistance ${targetPeKm}km`;
    } else if (peAlt <= optimalMaxPe) {
      text += `\nEncounter: ${targetName} (optimal)`;
      text += `\nNext: warp to SOI, then circularize`;
    } else if (peAlt <= 500_000) {
      text += `\nEncounter: ${targetName} (acceptable)`;
      text += `\nNext: course_correct to ${targetPeKm}km for efficient capture`;
    } else {
      text += `\nEncounter: ${targetName} (far encounter)`;
      text += `\nNext: course_correct to ${targetPeKm}km`;
    }

    return { success: true, warning: text };
  }

  // Check for close approach without SOI encounter (elliptical orbit reaching target plane)
  if (!hasExistingTransfer && validation.targetInfo?.class === 'moon') {
    const caCheck = await conn.queue(
      'IF HASTARGET AND TARGET:TYPENAME = "Body" { ' +
      'LOCAL tgtSma IS TARGET:ORBIT:SEMIMAJORAXIS. ' +
      'LOCAL shipApo IS SHIP:APOAPSIS + SHIP:BODY:RADIUS. ' +
      'IF shipApo >= tgtSma * 0.8 { PRINT "REACH|" + ROUND(shipApo) + "|" + ROUND(tgtSma). } ' +
      'ELSE { PRINT "NOREACH". } } ELSE { PRINT "NOTGT". }',
      3000
    );
    const reachMatch = caCheck.success ? caCheck.output.match(/REACH\|(\d+)\|(\d+)/) : null;
    if (reachMatch) {
      // Ship's apoapsis reaches target's orbital radius - check actual encounter/approach
      // Use ADDONS:MJ:TARGET (always available) not ADDONS:MJ:TGT (may not exist)
      const encCheck = await conn.queue(
        'LOCAL hasEnc IS SHIP:ORBIT:HASNEXTPATCH AND SHIP:ORBIT:NEXTPATCH:BODY:NAME = TARGET:NAME. ' +
        'SET MJTGT TO ADDONS:MJ:TARGET. ' +
        'LOCAL caDist IS MJTGT:CLOSESTAPPROACHDISTANCE. ' +
        'LOCAL caTime IS MJTGT:CLOSESTAPPROACHTIME. ' +
        'LOCAL tgtRad IS TARGET:RADIUS. ' +
        'LOCAL tgtSOI IS TARGET:SOIRADIUS. ' +
        'IF hasEnc { ' +
        '  LOCAL encPe IS SHIP:ORBIT:NEXTPATCH:PERIAPSIS. ' +
        '  LOCAL encEta IS SHIP:ORBIT:NEXTPATCHETA. ' +
        '  PRINT "ENC|" + ROUND(encPe) + "|" + ROUND(encEta) + "|" + ROUND(tgtRad) + "|" + ROUND(tgtSOI). ' +
        '} ELSE IF caDist > 0 AND caTime > 0 { ' +
        '  PRINT "CA|" + ROUND(caDist) + "|" + ROUND(caTime) + "|" + ROUND(tgtRad) + "|" + ROUND(tgtSOI). ' +
        '} ELSE { PRINT "NOAPPROACH". }',
        5000
      );

      // Parse encounter info
      const encMatch = encCheck.success ? encCheck.output.match(/ENC\|(-?\d+)\|(\d+)\|(\d+)\|(\d+)/) : null;
      if (encMatch) {
        const periapsis = parseInt(encMatch[1]);
        const caTime = parseInt(encMatch[2]);
        const tgtRadius = parseInt(encMatch[3]);
        const peKm = (periapsis / 1000).toFixed(0);

        // Check if periapsis is safe (above surface)
        if (periapsis < tgtRadius * 0.1) {
          return {
            success: true,
            warning: `Already on transfer to ${targetName} with SOI encounter!\n` +
                     `⚠️ CRASH WARNING: Periapsis ${peKm}km is dangerously low.\n` +
                     `Use course_correct with targetDistance=50000 to raise periapsis.`
          };
        } else if (periapsis < 30_000) {
          return {
            success: true,
            warning: `Already on transfer to ${targetName} with SOI encounter!\n` +
                     `Periapsis: ${peKm}km in ${formatTime(caTime)} (low but safe).\n` +
                     `Ready: warp to SOI, then circularize.`
          };
        } else {
          return {
            success: true,
            warning: `Already on transfer to ${targetName} with SOI encounter!\n` +
                     `Periapsis: ${peKm}km in ${formatTime(caTime)} (good).\n` +
                     `Ready: warp to SOI, then circularize.`
          };
        }
      }

      // Close approach without SOI encounter
      const closeMatch = encCheck.success ? encCheck.output.match(/CA\|(\d+)\|(\d+)\|(\d+)\|(\d+)/) : null;
      if (closeMatch) {
        const caDist = parseInt(closeMatch[1]);
        const caTime = parseInt(closeMatch[2]);
        const tgtSOI = parseInt(closeMatch[4]);
        const caKm = (caDist / 1000).toFixed(0);
        const soiKm = (tgtSOI / 1000).toFixed(0);

        if (caDist <= tgtSOI * 1.5) {
          return {
            success: true,
            warning: `Already on transfer to ${targetName}!\n` +
                     `Close approach: ${caKm}km in ${formatTime(caTime)} (SOI: ${soiKm}km).\n` +
                     `Use course_correct to refine approach and achieve SOI encounter.`
          };
        } else {
          return {
            success: true,
            warning: `Already on transfer trajectory toward ${targetName}.\n` +
                     `Close approach: ${caKm}km in ${formatTime(caTime)} (needs refinement, SOI: ${soiKm}km).\n` +
                     `Use course_correct to achieve SOI encounter.`
          };
        }
      }

      // Fallback: orbit reaches target plane but no approach data available
      const shipApo = parseInt(reachMatch[1]);
      const tgtSma = parseInt(reachMatch[2]);
      return {
        success: true,
        warning: `Current orbit (Ap: ${(shipApo / 1000).toFixed(0)}km) reaches ${targetName} orbit (${(tgtSma / 1000).toFixed(0)}km).\n` +
                 `Use course_correct to establish encounter with ${targetName}.`
      };
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
        const nodeCountResult = await conn.queue('PRINT ALLNODES:LENGTH.', 2000);
        const nodesCreated = nodeCountResult.success ? Number.parseInt(nodeCountResult.output.match(/\d+/)?.[0] || '1') : 1;

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
        const nodeCountResult = await conn.queue('PRINT ALLNODES:LENGTH.', 2000);
        const nodesCreated = nodeCountResult.success ? Number.parseInt(nodeCountResult.output.match(/\d+/)?.[0] || '1') : 1;

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
    await conn.raw(`SET TARGET TO BODY("${detourBody}").`, 3000);

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
    // Special case: MechJeb returned success but no node created - vessel likely already on transfer
    if (attempt.error?.includes('no node was created')) {
      // Check current close approach distance using MechJeb's target info
      // Use ADDONS:MJ:TARGET (always available) not ADDONS:MJ:TGT (may not exist)
      const caCheck = await conn.queue(
        'IF HASTARGET { SET MJTGT TO ADDONS:MJ:TARGET. PRINT "CA|" + ROUND(MJTGT:CLOSESTAPPROACHDISTANCE) + "|" + ROUND(MJTGT:CLOSESTAPPROACHTIME). } ELSE { PRINT "NOTGT". }',
        3000
      );
      const caMatch = caCheck.success ? caCheck.output.match(/CA\|(-?\d+)\|(-?\d+)/) : null;
      if (caMatch) {
        const caDist = parseInt(caMatch[1]);
        const caTime = parseInt(caMatch[2]);
        if (caDist > 0 && caTime > 0) {
          return {
            success: true,
            warning: `Already on transfer trajectory to ${targetName}!\n` +
                     `Closest approach: ${(caDist / 1000).toFixed(0)}km in ${formatTime(caTime)}\n` +
                     `Use course_correct to fine-tune approach or warp to SOI change.`
          };
        }
      }
    }
    return { success: false, error: attempt.error ?? 'Hohmann transfer failed' };
  }

  // Check if we have a close approach without SOI encounter (common for low-gravity bodies)
  if (attempt.closeApproach) {
    const distKm = (attempt.closeApproach.distance / 1000).toFixed(0);
    return {
      success: true,
      deltaV: attempt.deltaV,
      timeToNode: attempt.timeToNode,
      nodesCreated: attempt.nodesCreated,
      closeApproach: attempt.closeApproach,
      warning: `Close approach with ${targetName} at ${distKm}km (no SOI encounter yet).\n` +
               `Low-gravity bodies like Minmus may need fine-tuning.\n` +
               `After burn: use course_correct to refine approach and achieve encounter.`,
    };
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
  tier: -1,
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
          : `${nodeCount} node(s): ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, in ${formatTime(result.timeToNode ?? 0)}`;

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
            await conn.raw('SAS ON. WAIT 0.3. SET SASMODE TO "PROGRADE". RCS ON.', 5000);
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
            await conn.raw('SET SHIP:CONTROL:FORE TO 0. RCS OFF.', 3000);
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
          const finalAtmoHeight = finalEncounterInfo.atmosphereHeight ?? 0;
          const finalMinSafePe = finalAtmoHeight > 0 ? finalAtmoHeight + 40_000 : 40_000;
          const optimalMaxPe = finalMinSafePe + 50_000;
          const targetPeKm = Math.round(finalMinSafePe / 1000);

          // Use labels, not raw numbers - LLMs pick up numbers and reuse them incorrectly
          if (peAlt < finalMinSafePe) {
            text += `\nEncounter: ${finalEncounterInfo.targetName} (UNSAFE - `;
            text += finalAtmoHeight > 0 ? `below atmosphere)` : `too low)`;
            text += `\nREQUIRED: course_correct with targetDistance ${targetPeKm}km`;
          } else if (peAlt <= optimalMaxPe) {
            text += `\nEncounter: ${finalEncounterInfo.targetName} (optimal)`;
            text += `\nNext: warp to SOI, then circularize`;
          } else if (peAlt <= 500_000) {
            text += `\nEncounter: ${finalEncounterInfo.targetName} (acceptable)`;
            text += `\nNext: course_correct to ${targetPeKm}km for efficient capture`;
          } else {
            text += `\nEncounter: ${finalEncounterInfo.targetName} (far encounter)`;
            text += `\nNext: course_correct to ${targetPeKm}km`;
          }
        } else if (result.closeApproach) {
          // Close approach without SOI encounter (common for low-gravity bodies like Minmus)
          const caTime = formatTime(result.closeApproach.time);
          text += `\nClose approach in ${caTime} (no SOI encounter yet)`;
          text += `\nNext: course_correct to achieve encounter`;
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
