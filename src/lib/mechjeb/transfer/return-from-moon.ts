/**
 * Return From Moon - Transfer back to parent body
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, type ManeuverResult } from '../shared.js';
import { validateVesselState } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition, McpLogger } from '../../tool-types.js';
import { executeSchema, distanceSchema, nullLogger } from '../../tool-types.js';
import { formatTime, fmtVel, fmtDist } from '../../utils/format.js';
import { warpTo } from '../../kos/warp.js';

// ============================================================================
// Shared Arrival Advice Generation
// ============================================================================

/**
 * Generate smart advice for arrival at a celestial body.
 * Used by return_from_moon, warp (reentry mode), and transfer tools.
 */
export interface ArrivalAdviceParams {
  bodyName: string;
  periapsisKm: number;
  atmosphereKm: number;
  altitudeM: number;
}

export interface ArrivalAdvice {
  advice: string;
  periapsisDescriptor: string;  // '', 'steep ', or 'shallow '
  text: string;  // Full formatted text for tool response
}

/**
 * Generate arrival advice based on periapsis and atmosphere.
 * Consolidates advice logic from warp.ts and return-from-moon.ts.
 *
 * Kerbin-specific advice (atmosphere ~70km):
 * - Ideal reentry: 15-55km periapsis, target 35km
 * - < 15km: steep reentry, may need heat shield
 * - > 55km: shallow, multiple passes or use course_correct
 * - > 70km: above atmosphere, use course_correct to lower
 *
 * Other atmospheric bodies use percentage-based thresholds.
 */
export function generateArrivalAdvice(params: ArrivalAdviceParams): ArrivalAdvice {
  const { bodyName, periapsisKm, atmosphereKm, altitudeM } = params;
  const isKerbin = bodyName.toLowerCase() === 'kerbin';

  let advice: string;
  let periapsisDescriptor = '';

  if (periapsisKm < 0) {
    // Crash trajectory - same for all bodies
    advice = 'CRASH TRAJECTORY! Use crash_avoidance immediately.';
  } else if (isKerbin) {
    // Kerbin-specific advice matching course_correct's smart periapsis logic
    // Ideal range: 15-55km, target 35km for KSC landing
    if (periapsisKm >= atmosphereKm) {
      periapsisDescriptor = 'high ';
      advice = `Above atmosphere (${atmosphereKm}km). Use course_correct to lower periapsis for reentry.`;
    } else if (periapsisKm > 55) {
      periapsisDescriptor = 'shallow ';
      advice = `Shallow reentry (>55km). Use course_correct to lower to 30-40km, or land for aerobraking.`;
    } else if (periapsisKm < 15) {
      periapsisDescriptor = 'steep ';
      advice = `Steep reentry (<15km). Use land tool, or course_correct to raise to 30-40km.`;
    } else if (periapsisKm <= 35) {
      // 15-35km: ideal for direct landing
      advice = `Good reentry trajectory. Use land with target "KSC" for runway landing.`;
    } else {
      // 35-55km: good but slightly high
      advice = `Good trajectory. Use land for reentry, or circularize for orbit.`;
    }
  } else if (atmosphereKm > 0) {
    // Other atmospheric bodies - use percentage-based thresholds
    const steepThreshold = atmosphereKm * 0.2;   // < 20% of atm = steep
    const shallowThreshold = atmosphereKm * 0.7; // > 70% of atm = shallow

    if (periapsisKm >= atmosphereKm) {
      periapsisDescriptor = 'high ';
      advice = `Above atmosphere (${atmosphereKm}km). Use course_correct to lower for aerobraking.`;
    } else if (periapsisKm > shallowThreshold) {
      periapsisDescriptor = 'shallow ';
      advice = `Shallow approach (>${Math.round(shallowThreshold)}km). Use course_correct for steeper entry.`;
    } else if (periapsisKm < steepThreshold) {
      periapsisDescriptor = 'steep ';
      advice = `Steep entry (<${Math.round(steepThreshold)}km). Use land, or course_correct to raise periapsis.`;
    } else {
      // Good periapsis range
      advice = `Good for aerobraking. Use land, or circularize after atmosphere pass.`;
    }
  } else {
    // No atmosphere - use absolute thresholds
    if (periapsisKm < 20) {
      periapsisDescriptor = 'low ';
      advice = `Low orbit (<20km). Use land, or course_correct to raise periapsis.`;
    } else if (periapsisKm <= 250) {
      advice = `Good orbit. Use circularize at periapsis, or land.`;
    } else {
      periapsisDescriptor = 'high ';
      advice = `High orbit (>${periapsisKm}km). Use course_correct to lower, or circularize here.`;
    }
  }

  const text = `Arrived at ${bodyName}\n` +
               `Altitude: ${fmtDist(altitudeM)}, ${periapsisDescriptor}Periapsis: ${periapsisKm}km\n` +
               `Next: ${advice}`;

  return { advice, periapsisDescriptor, text };
}

// ============================================================================
// Shared Post-Escape Sequence
// ============================================================================

/**
 * Result from completing a moon return sequence
 */
export interface ReturnSequenceResult {
  success: boolean;
  error?: string;
  body?: string;
  altitude?: number;
  periapsisKm?: number;
  atmosphereKm?: number;
  advice?: string;
  /** Full formatted text for tool response */
  text?: string;
}

/**
 * Complete the return-from-moon sequence after escape burn.
 *
 * This function handles:
 * 1. Verifying escape trajectory
 * 2. Warping to parent body SOI
 * 3. Changing inclination to equatorial
 * 4. Determining appropriate next steps
 *
 * Shared between return_from_moon tool and transfer meta-tool.
 */
export async function completeReturnFromMoon(
  conn: KosConnection,
  orchestrator: ManeuverOrchestrator,
  logger: McpLogger = nullLogger
): Promise<ReturnSequenceResult> {
  // Check if we're still at a moon or already at a planet
  // If parent body is Sun, we're at a planet (already transitioned successfully)
  // If parent body is a planet (like Kerbin), we're at a moon (need to check escape)
  const bodyCheck = await conn.execute(
    'PRINT SHIP:BODY:NAME + "|" + SHIP:BODY:BODY:NAME.',
    3000
  );
  const bodyMatch = bodyCheck.output.match(/([^|]+)\|([^|]+)/);
  const currentBodyName = bodyMatch?.[1]?.trim() ?? 'Unknown';
  const parentBodyName = bodyMatch?.[2]?.trim() ?? 'Sun';

  // If parent is Sun, we're already at a planet - escape succeeded, skip to arrival handling
  const alreadyAtPlanet = parentBodyName.toLowerCase() === 'sun';
  if (alreadyAtPlanet) {
    logger.info(`[return_from_moon] Already at planet ${currentBodyName} - escape successful, skipping validation`);
    // Jump directly to post-arrival handling
    const postWarpInfo = await conn.execute(
      'PRINT "POST|" + SHIP:BODY:NAME + "|" + ROUND(PERIAPSIS/1000, 1) + "|" + ' +
      'ROUND(SHIP:BODY:ATM:HEIGHT/1000) + "|" + ROUND(ALTITUDE).',
      3000
    );
    const postMatch = postWarpInfo.output.match(/POST\|([^|]+)\|([\d.-]+)\|(\d+)\|(\d+)/);
    if (postMatch) {
      const [, body, peKmStr, atmKmStr, altStr] = postMatch;
      const peKm = parseFloat(peKmStr);
      const atmKm = parseInt(atmKmStr);
      const altitude = parseInt(altStr);
      const arrivalAdvice = generateArrivalAdvice({
        bodyName: body,
        periapsisKm: peKm,
        atmosphereKm: atmKm,
        altitudeM: altitude,
      });
      return {
        success: true,
        body,
        altitude,
        periapsisKm: peKm,
        atmosphereKm: atmKm,
        advice: arrivalAdvice.advice,
        text: arrivalAdvice.text,
      };
    }
    // Fallback
    return {
      success: true,
      body: currentBodyName,
      text: `Arrived at ${currentBodyName}. Use status for orbit details.`,
    };
  }

  // Still at a moon - need to verify escape trajectory
  let currentBody = currentBodyName;
  let parentBody = parentBodyName;
  let eccentricity = 0;
  let soiEtaSeconds = 0;
  let escapeConfirmed = false;

  const MAX_RETRIES = 5;
  const RETRY_DELAYS = [500, 1000, 1500, 2000, 2500]; // Increasing delays

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt]));

    // Get current body, escape trajectory info, and next body
    const trajInfo = await conn.execute(
      'LOCAL _ecc IS SHIP:ORBIT:ECCENTRICITY. ' +
      'LOCAL _hasPatch IS SHIP:ORBIT:HASNEXTPATCH. ' +
      'LOCAL _nextBody IS CHOOSE SHIP:ORBIT:NEXTPATCH:BODY:NAME IF _hasPatch ELSE "?". ' +
      'LOCAL _nextPeKm IS CHOOSE ROUND(SHIP:ORBIT:NEXTPATCH:PERIAPSIS/1000, 1) IF _hasPatch ELSE 0. ' +
      'LOCAL _patchEta IS CHOOSE ROUND(SHIP:ORBIT:NEXTPATCHETA) IF _hasPatch ELSE 0. ' +
      'PRINT "RET|" + SHIP:BODY:NAME + "|" + _nextBody + "|" + _nextPeKm + "|" + ROUND(_ecc, 3) + "|" + _patchEta.',
      3000
    );
    const match = trajInfo.output.match(/RET\|([^|]+)\|([^|]+)\|([\d.-]+)\|([\d.]+)\|(\d+)/);

    if (match) {
      [, currentBody, parentBody] = match;
      eccentricity = parseFloat(match[4]);
      soiEtaSeconds = parseInt(match[5]);

      // Got valid data - check if on escape trajectory
      if (eccentricity >= 1) {
        escapeConfirmed = true;
        break; // Success - exit retry loop
      }

      // Not yet hyperbolic - KSP may still be calculating, retry
      logger.info(`[return_from_moon] Waiting for escape trajectory (e=${eccentricity.toFixed(3)}, attempt ${attempt + 1}/${MAX_RETRIES})`);
    } else {
      // Regex failed - log for debugging
      logger.warn(`[return_from_moon] Failed to parse trajectory info (attempt ${attempt + 1}/${MAX_RETRIES}): ${trajInfo.output.slice(0, 100)}`);
    }
  }

  // After retries, check if we have escape trajectory
  if (!escapeConfirmed) {
    return {
      success: false,
      error: `Burn complete but not on escape trajectory (e=${eccentricity.toFixed(3)}).\n` +
             `Current orbit may be elliptical. Try return_from_moon again with more delta-v.`,
    };
  }

  logger.progress(`${currentBody} escape burn complete. Warping to ${currentBody} escape...`);

  // Warp to parent body SOI
  {
    let warpResult;
    if (parentBody !== '?' && soiEtaSeconds > 0) {
      // Normal case: SOI transition detected
      warpResult = await warpTo(conn, 'soi', {
        leadTime: 10,
        timeout: 300_000,
        logger,
      });
    } else {
      // Fallback: hyperbolic but no NEXTPATCH yet
      logger.warn(`[return_from_moon] No SOI patch detected (e=${eccentricity.toFixed(3)}). Waiting for KSP...`);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Retry the patch check
      const retryCheck = await conn.execute(
        'PRINT (CHOOSE SHIP:ORBIT:NEXTPATCHETA IF SHIP:ORBIT:HASNEXTPATCH ELSE 0).',
        3000
      );
      const retryEta = parseInt(retryCheck.output.match(/(\d+)/)?.[1] || '0');

      if (retryEta > 0) {
        warpResult = await warpTo(conn, 'soi', {
          leadTime: 10,
          timeout: 300_000,
          logger,
        });
      } else {
        return {
          success: false,
          error: `Escape trajectory confirmed (e=${eccentricity.toFixed(3)}) but no SOI transition detected.\n` +
                 `KSP may not have calculated the encounter. Try using warp with a time value.`,
        };
      }
    }

    if (!warpResult.success) {
      return {
        success: false,
        error: `Escape burn complete but warp failed: ${warpResult.error}`,
      };
    }

    // Wait for KSP to settle after SOI transition
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Align to equatorial orbit for optimal reentry
  logger.progress(`Arrived at ${currentBody}. Aligning to equatorial...`);
  const incResult = await orchestrator.changeInclination(0, 'EQ_NEAREST_AD', {
    execute: true,
    logger,
    callerTool: 'ensure_prograde_return',
  });

  if (!incResult.success) {
    // Non-fatal - continue with current inclination
    logger.warn(`[return_from_moon] Inclination change failed: ${incResult.error}`);
  }

  // Get updated trajectory info
  const postWarpInfo = await conn.execute(
    'PRINT "POST|" + SHIP:BODY:NAME + "|" + ROUND(PERIAPSIS/1000, 1) + "|" + ' +
    'ROUND(SHIP:BODY:ATM:HEIGHT/1000) + "|" + ROUND(ALTITUDE).',
    3000
  );
  const postMatch = postWarpInfo.output.match(/POST\|([^|]+)\|([\d.-]+)\|(\d+)\|(\d+)/);

  if (postMatch) {
    const [, currentBody, peKmStr, atmKmStr, altStr] = postMatch;
    const peKm = parseFloat(peKmStr);
    const atmKm = parseInt(atmKmStr);
    const altitude = parseInt(altStr);

    // Use shared advice generation
    const arrivalAdvice = generateArrivalAdvice({
      bodyName: currentBody,
      periapsisKm: peKm,
      atmosphereKm: atmKm,
      altitudeM: altitude,
    });

    return {
      success: true,
      body: currentBody,
      altitude,
      periapsisKm: peKm,
      atmosphereKm: atmKm,
      advice: arrivalAdvice.advice,
      text: arrivalAdvice.text,
    };
  }

  // Fallback if trajectory query failed
  return {
    success: true,
    body: currentBody,
    altitude: 0,
    text: `Arrived at ${currentBody}. Use status to check orbit details.`,
  };
}

/**
 * Create a maneuver node to return from a moon to its parent body.
 * Only works when orbiting a moon (e.g., Mun, Minmus).
 *
 * @param conn kOS connection
 * @param targetPeriapsis Target periapsis at parent body in meters (e.g., 100000 for 100km at Kerbin)
 */
export async function returnFromMoon(
  conn: KosConnection,
  targetPeriapsis: number
): Promise<ManeuverResult> {
  // Validate vessel state: must be orbiting a moon
  const validation = await validateVesselState(conn, {
    forbiddenStatuses: ['prelaunch', 'landed', 'splashed'],
    requireAtMoon: true,
  }, 'return_from_moon');

  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:MOONRETURN(${targetPeriapsis}).`;
  return executeManeuverCommand(conn, cmd);
}

// ============================================================================
// Tool Definition
// ============================================================================

export const returnFromMoonTool: ToolDefinition = {
  name: 'return_from_moon',
  description: 'Leave moon orbit to return to parent body SOI.',
  inputSchema: {
    targetPeriapsis: distanceSchema.optional().default(40_000).describe('Target periapsis at parent body in meters (default: 40km)'),
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
      const result = await orchestrator.returnFromMoon(args.targetPeriapsis as number, {
        execute: args.execute as boolean,
        logger,
        callerTool: 'return_from_moon',
      });

      if (result.success) {
        // Orchestrator handles full sequence (warp, inclination, advice) and returns text
        const text = result.text
          ?? (result.executed
            ? `Return complete`
            : `Node: ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, in ${formatTime(result.timeToNode ?? 0)}`);
        return ctx.successResponse('return_from_moon', text);
      } else {
        return ctx.errorResponse('return_from_moon', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('return_from_moon', error instanceof Error ? error.message : String(error));
    }
  },
};
