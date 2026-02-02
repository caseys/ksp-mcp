/**
 * Course Correction - Fine-tune approach trajectory
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { queryNodeInfo, queryWrongEncounterDetails, parseNumber, getBodyPeriapsisTargets, type BodyPeriapsisTargets, type ManeuverResult } from '../shared.js';
import type { FineTuneFunction } from '../execute-node.js';
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

// ============================================================================
// Planet Type Classification for Smart Periapsis Selection
// ============================================================================

/**
 * Planet information for smart course correction
 */
interface PlanetInfo {
  name: string;
  hasAtmosphere: boolean;
  atmosphereHeight: number;  // 0 if no atmosphere
  isGasGiant: boolean;       // true if no surface accessible
  isKerbin: boolean;
}

/**
 * Query planet information for smart periapsis selection
 */
async function queryPlanetInfo(conn: KosConnection, targetName: string): Promise<PlanetInfo | null> {
  const result = await conn.queue(
    `IF EXISTS(BODY("${targetName}")) { ` +
    `LOCAL b IS BODY("${targetName}"). ` +
    `LOCAL hasAtm IS b:ATM:EXISTS. ` +
    `LOCAL atmH IS CHOOSE b:ATM:HEIGHT IF hasAtm ELSE 0. ` +
    // Gas giant heuristic: atmosphere extends beyond what would be surface
    // Jool has radius 6000km, atm 200km but no surface - check if ALT:RADAR would be negative
    `LOCAL isGas IS hasAtm AND (atmH > b:RADIUS * 0.03). ` +
    `PRINT "PI|" + b:NAME + "|" + hasAtm + "|" + ROUND(atmH) + "|" + isGas. ` +
    `} ELSE { PRINT "NOPLANET". }`,
    3000
  );

  if (!result.success || result.output.includes('NOPLANET')) {
    return null;
  }

  const match = result.output.match(/PI\|([^|]+)\|(True|False)\|(\d+)\|(True|False)/i);
  if (!match) return null;

  return {
    name: match[1].trim(),
    hasAtmosphere: match[2].toLowerCase() === 'true',
    atmosphereHeight: parseInt(match[3]),
    isGasGiant: match[4].toLowerCase() === 'true',
    isKerbin: match[1].trim().toLowerCase() === 'kerbin',
  };
}

/**
 * Smart periapsis selection result
 */
interface SmartPeriapsisResult {
  targetPeriapsis: number;
  idealMin: number;
  idealMax: number;
  advice: string;
  planetType: 'gas-giant' | 'kerbin' | 'atmospheric' | 'airless';
}

/**
 * Determine optimal periapsis and advice based on planet characteristics
 *
 * Planet types and ideal ranges:
 * - Gas giant: atm height ± 50km, target atm - 20km (aerobrake)
 * - Kerbin: 15-55km, target 35km (land at KSC)
 * - Atmospheric: 50% atm to 250km, target atm - 20km (capture/land)
 * - Airless: 35-250km, target 50km (circularize)
 */
function getSmartPeriapsis(planetInfo: PlanetInfo): SmartPeriapsisResult {
  // Gas giant: aerobrake into atmosphere
  // TODO: Expand to handle hyperbolic/crash trajectories after interplanetary transfer
  if (planetInfo.isGasGiant) {
    const atmH = planetInfo.atmosphereHeight;
    return {
      targetPeriapsis: atmH - 20_000,
      idealMin: atmH - 50_000,
      idealMax: atmH + 50_000,
      advice: `Warp to ${planetInfo.name} for aerobrake`,
      planetType: 'gas-giant',
    };
  }

  // Kerbin: reentry for landing
  if (planetInfo.isKerbin) {
    return {
      targetPeriapsis: 35_000,
      idealMin: 15_000,
      idealMax: 55_000,
      advice: `Use land tool with target 'KSC'`,
      planetType: 'kerbin',
    };
  }

  // Atmospheric planet: capture or land
  if (planetInfo.hasAtmosphere) {
    const atmH = planetInfo.atmosphereHeight;
    return {
      targetPeriapsis: atmH + 20_000,
      idealMin: atmH + 10_000,
      idealMax: atmH + 500_000,
      advice: `Use adjust_orbit for capture burn or land`,
      planetType: 'atmospheric',
    };
  }

  // Airless body: circularize
  return {
    targetPeriapsis: 20_000,
    idealMin: 10_000,
    idealMax: 500_000,
    advice: `Circularize to establish orbit`,
    planetType: 'airless',
  };
}

/**
 * Query current encounter periapsis from trajectory (not from a node)
 */
async function queryCurrentEncounterPeriapsis(conn: KosConnection): Promise<{ hasPeriapsis: boolean; periapsis: number; body: string }> {
  const result = await conn.queue(
    'IF SHIP:ORBIT:HASNEXTPATCH { ' +
    'PRINT "PE|" + SHIP:ORBIT:NEXTPATCH:BODY:NAME + "|" + ROUND(SHIP:ORBIT:NEXTPATCH:PERIAPSIS). ' +
    '} ELSE { PRINT "NOPE". }',
    3000
  );

  if (!result.success || result.output.includes('NOPE')) {
    return { hasPeriapsis: false, periapsis: 0, body: '' };
  }

  const match = result.output.match(/PE\|([^|]+)\|(-?\d+)/);
  if (!match) {
    return { hasPeriapsis: false, periapsis: 0, body: '' };
  }

  return {
    hasPeriapsis: true,
    body: match[1].trim(),
    periapsis: parseInt(match[2]),
  };
}

// ============================================================================

/**
 * Query the periapsis that the current maneuver node would produce at the target.
 * Uses NEXTNODE:ORBIT:NEXTPATCH:PERIAPSIS to get the periapsis in the target's SOI.
 */
async function queryNodePeriapsis(conn: KosConnection): Promise<{ hasEncounter: boolean; periapsis: number }> {
  const result = await conn.queue(
    'IF HASNODE AND NEXTNODE:ORBIT:HASNEXTPATCH { ' +
    'PRINT "ENC|" + ROUND(NEXTNODE:ORBIT:NEXTPATCH:PERIAPSIS). ' +
    '} ELSE IF HASNODE { PRINT "NOENC". } ELSE { PRINT "NONODE". }',
    3000
  );

  if (!result.success || result.output.includes('NONODE') || result.output.includes('NOENC')) {
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
  const result = await conn.queue(
    'IF HASNODE { ' +
    'IF NEXTNODE:ORBIT:HASNEXTPATCH { ' +
    'PRINT "NODE_ENC|" + NEXTNODE:ORBIT:NEXTPATCH:BODY:NAME. ' +
    '} ELSE { PRINT "NODE_NOENC". } ' +
    '} ELSE { PRINT "NONODE". }',
    3000
  );

  if (!result.success || result.output.includes('NONODE')) {
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
    const result = await conn.queue(
      'IF HASTARGET { PRINT "ENC|" + ADDONS:MJ:INFO:TPERI. } ELSE { PRINT "NOTGT". }',
      3000
    );

    if (!result.success || result.output.includes('NOTGT')) {
      return { hasEncounter: false, periapsis: 0 };
    }

    // Parse distance with units (e.g., "214.1 km", "50000 m", "-9 km" for below surface)
    const match = result.output.match(/ENC\|(-?[0-9.]+)\s*(m|km|Mm|Gm)?/i);
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

    // Return if we got a valid number (negative is OK - it means impact trajectory)
    // An impact trajectory is still a valid encounter, just below surface
    if (!Number.isNaN(value)) {
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
  // Split into multiple simpler queries for reliability

  // Check 1: SOI encounter (pure kOS, most reliable)
  const encResult = await conn.queue(
    'IF SHIP:ORBIT:HASNEXTPATCH AND HASTARGET { ' +
    'LOCAL nb IS SHIP:ORBIT:NEXTPATCH:BODY:NAME. ' +
    'IF nb = TARGET:NAME { PRINT "ENC|" + nb. } ELSE { PRINT "INT|" + nb. } ' +
    '} ELSE { PRINT "NOENC". }',
    3000
  );

  let intermediateBody: string | undefined;
  if (encResult.success && encResult.output.includes('ENC|')) {
    // We have a direct encounter - use that
    const encMatch = encResult.output.match(/ENC\|(\w+)/);
    if (encMatch) {
      // Query encounter details
      const detailResult = await conn.queue(
        'PRINT "DET|" + ROUND(SHIP:ORBIT:NEXTPATCHETA) + "|" + TARGET:NAME.',
        3000
      );
      const detMatch = detailResult.success ? detailResult.output.match(/DET\|(\d+)\|(\w+)/) : null;
      if (detMatch) {
        return {
          hasApproach: true,
          distance: 0, // Actual encounter, not just close approach
          time: parseInt(detMatch[1]),
          inCurrentPatch: true,
        };
      }
    }
  } else if (encResult.success && encResult.output.includes('INT|')) {
    const intMatch = encResult.output.match(/INT\|(\w+)/);
    intermediateBody = intMatch?.[1];
  }

  // Check 2: Geometric check - does orbit reach target's orbital plane? (pure kOS)
  const geoResult = await conn.queue(
    'IF HASTARGET AND TARGET:TYPENAME = "Body" { ' +
    'LOCAL tgtSma IS TARGET:ORBIT:SEMIMAJORAXIS. ' +
    'LOCAL shipApo IS APOAPSIS + SHIP:BODY:RADIUS. ' +
    'IF shipApo >= tgtSma * 0.8 { ' +
    'PRINT "GEO|" + ROUND(TARGET:DISTANCE) + "|" + ROUND(ETA:APOAPSIS) + "|" + ROUND(TARGET:SOIRADIUS). ' +
    '} ELSE { PRINT "NOGEO". } ' +
    '} ELSE { PRINT "NOGEO". }',
    3000
  );

  const geoMatch = geoResult.success ? geoResult.output.match(/GEO\|(\d+)\|(\d+)\|(\d+)/) : null;
  if (geoMatch) {
    return {
      hasApproach: true,
      distance: parseInt(geoMatch[1]),
      time: parseInt(geoMatch[2]),
      inCurrentPatch: true,
      intermediateBody,
    };
  }

  // Check 3: Try MechJeb target module (may not always work)
  try {
    const mjResult = await conn.queue(
      'IF HASTARGET { SET MJTGT TO ADDONS:MJ:TARGET. ' +
      'LOCAL d IS MJTGT:CLOSESTAPPROACHDISTANCE. LOCAL t IS MJTGT:CLOSESTAPPROACHTIME. ' +
      'IF d > 0 AND t > 0 { PRINT "MJ|" + ROUND(d) + "|" + ROUND(t). } ELSE { PRINT "NOMJ". } ' +
      '} ELSE { PRINT "NOMJ". }',
      3000
    );

    const mjMatch = mjResult.success ? mjResult.output.match(/MJ\|(\d+)\|(\d+)/) : null;
    if (mjMatch) {
      return {
        hasApproach: true,
        distance: parseInt(mjMatch[1]),
        time: parseInt(mjMatch[2]),
        inCurrentPatch: true,
        intermediateBody,
      };
    }
  } catch {
    // MechJeb access failed - continue without it
  }

  return { hasApproach: false, distance: 0, time: 0, inCurrentPatch: true, intermediateBody };
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

// ============================================================================
// Fine-Tune Function for Course Corrections
// ============================================================================

/**
 * Create a fine tune function for course corrections to body targets.
 * Queries target's atmosphere to determine optimal periapsis range.
 */
async function createCourseCorrectFineTune(
  conn: KosConnection,
  _targetName: string
): Promise<FineTuneFunction | undefined> {
  // Query target body's atmosphere height
  const atmResult = await conn.queue(
    'IF HASTARGET AND TARGET:ISTYPE("Body") { PRINT TARGET:ATM:HEIGHT. } ELSE { PRINT -1. }',
    3000
  );

  if (!atmResult.success) {
    return undefined;
  }

  const atmHeight = parseNumber(atmResult.output.trim()) ?? 0;
  const { acceptableMin: minSafePe, courseCorrectThreshold: maxOptimalPe } = getBodyPeriapsisTargets(atmHeight);

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

/**
 * Query diagnostic info for error messages (TWR, body, gravitational parameter).
 * Returns formatted string to append to error messages.
 */
async function getDiagnostics(conn: KosConnection): Promise<string> {
  try {
    const result = await conn.queue(
      'PRINT ROUND(ADDONS:MJ:INFO:LOCALTWR, 2) + "|" + BODY:NAME + "|" + BODY:MU.',
      3000
    );
    if (!result.success) return '';
    const parts = result.output.split('|');
    if (parts.length >= 3) {
      const twr = parts[0].trim();
      const body = parts[1].trim();
      const mu = parseFloat(parts[2].trim());
      return `\n[Debug: TWR=${twr}, Body=${body}, MU=${mu.toExponential(3)}]`;
    }
  } catch { /* ignore diagnostics errors */ }
  return '';
}

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

  // Check if already orbiting the target body
  // Course correction is for adjusting approach trajectories, not for when you're already at the target
  if (targetInfo.class === 'planet' || targetInfo.class === 'moon') {
    const bodyResult = await conn.queue('PRINT SHIP:BODY:NAME + "|" + SHIP:ORBIT:ECCENTRICITY.', 2000);
    const match = bodyResult.success ? bodyResult.output.match(/([^|]+)\|([\d.]+)/) : null;
    const currentBody = match?.[1]?.trim().toLowerCase() ?? '';
    const eccentricity = match ? parseFloat(match[2]) : 0;

    if (targetInfo.name.toLowerCase() === currentBody) {
      // Moon targets: always block if at moon
      // Planet targets: allow if on eccentric/hyperbolic trajectory (returning from moon)
      // ecc > 0.3 indicates transfer/return trajectory, not a stable parking orbit
      if (targetInfo.class === 'moon' || eccentricity <= 0.3) {
        return {
          success: false,
          error: `Already orbiting ${targetInfo.name}! Course correction adjusts approach trajectories.\n` +
                 `If returning to parent body, use return_from_moon or transfer.`,
          attempts: 0,
          finalPeriapsis: 0,
        };
      }
      // Planet with eccentric trajectory - allow course correction (returning from moon)
      logger?.info(`[CourseCorrect] On eccentric approach to ${targetInfo.name} (e=${eccentricity.toFixed(2)})`);
    }
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
  await conn.raw('IF HASNODE { REMOVE NEXTNODE. }', 2000);
  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:COURSECORRECTION(${targetPeriapsis}).`;
  const result = await conn.queue(cmd, 10_000);

  if (!result.success || !result.output.includes('True')) {
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
    const etaResult = await conn.queue('PRINT NEXTNODE:ETA.', 2000);
    const currentEta = etaResult.success ? parseFloat(etaResult.output.match(/[\d.]+/)?.[0] || '0') : 0;

    if (currentEta < MIN_NODE_ETA) {
      // Get time to apoapsis to ensure we don't schedule past it
      const apoResult = await conn.queue('PRINT ETA:APOAPSIS.', 2000);
      const etaApo = apoResult.success ? parseFloat(apoResult.output.match(/[\d.]+/)?.[0] || '0') : 0;

      // New ETA: 1 hour, or 10 min before apoapsis, whichever is smaller
      const newEta = Math.min(TARGET_NODE_ETA, etaApo > 600 ? etaApo - 600 : etaApo / 2);

      if (newEta > currentEta + 60) {
        // Recreate node at new time by adjusting the node's UT
        const adjustCmd = `SET N TO NEXTNODE. SET NEWUT TO TIME:SECONDS + ${newEta}. SET NEWNODE TO NODE(NEWUT, N:RADIALOUT, N:NORMAL, N:PROGRADE). REMOVE N. ADD NEWNODE.`;
        await conn.raw(adjustCmd, 5000);
        logger?.info(`[CourseCorrect] Moved node from T-${Math.round(currentEta)}s to T-${Math.round(newEta)}s`);

        // Check resulting periapsis after move
        const peAfterMove = await queryNodePeriapsis(conn);
        if (peAfterMove.hasEncounter) {
          logger?.progress(`[CourseCorrect] Node adjusted: in ${formatTime(newEta)}, Pe ${(peAfterMove.periapsis / 1000).toFixed(0)}km`);
        } else {
          logger?.warn(`[CourseCorrect] Node moved but encounter lost - may need different timing`);
        }
      }
    }
  } catch {
    // Non-fatal - proceed with original node timing
  }

  // Check resulting trajectory from node prediction
  const nodeResult = await queryNodePeriapsis(conn);
  const nodeInfo = await queryNodeInfo(conn);

  if (nodeResult.hasEncounter) {
    // Great - we have an SOI encounter
    return {
      success: true,
      deltaV: nodeInfo.deltaV,
      timeToNode: nodeInfo.timeToNode,
      attempts: 1,
      finalPeriapsis: nodeResult.periapsis,
    };
  }

  // No SOI encounter yet, but MechJeb created a node - check if it improves close approach
  // Query the predicted close approach after the node
  try {
    const caResult = await conn.queue(
      'IF HASNODE AND HASTARGET { SET MJTGT TO ADDONS:MJ:TARGET. ' +
      'PRINT "CA|" + ROUND(MJTGT:CLOSESTAPPROACHDISTANCE) + "|" + ROUND(MJTGT:CLOSESTAPPROACHTIME). ' +
      '} ELSE { PRINT "NOCA". }',
      3000
    );
    const caMatch = caResult.success ? caResult.output.match(/CA\|(\d+)\|(\d+)/) : null;
    if (caMatch) {
      const caDist = parseInt(caMatch[1]);
      const caTime = parseInt(caMatch[2]);
      // If we have a close approach, the node is useful even without SOI entry
      if (caDist > 0 && caTime > 0) {
        return {
          success: true,
          deltaV: nodeInfo.deltaV,
          timeToNode: nodeInfo.timeToNode,
          attempts: 1,
          finalPeriapsis: caDist, // Use close approach as "periapsis" estimate
          warning: `Close approach: ${(caDist / 1000).toFixed(0)}km (no SOI entry yet - may need additional correction)`,
        };
      }
    }
  } catch {
    // MechJeb query failed - continue to error
  }

  return {
    success: false,
    error: 'Course correction resulted in no encounter',
    attempts: 1,
    finalPeriapsis: 0,
  };
}

// ============================================================================
// Tool Definition
// ============================================================================

export const courseCorrectTool: ToolDefinition = {
  name: 'course_correct',
  description: 'Fine tune arrival periapsis at target body.',
  inputSchema: {
    target: z.preprocess(parseTarget, z.union([z.string(), z.literal('auto')]))
      .optional()
      .default('auto')
      .describe('Moon, planet, or vessel, or name.'),
    targetDistance: distanceSchema.optional().default(50_000).describe('Final distance from target'),
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

        const bodyResult = await conn.queue('PRINT SHIP:BODY:NAME.', 2000);
        const currentBody = bodyResult.success ? bodyResult.output : '';

        // Body targets: check if we're actually "at" the target vs. on approach
        if ((targetInfo.class === 'planet' || targetInfo.class === 'moon') &&
            currentBody.toLowerCase() === target.toLowerCase()) {

          const orbitInfo = await ctx.getBasicOrbitInfo(conn);
          const isEccentricApproach = orbitInfo && orbitInfo.eccentricity > 0.3;

          // Moon targets: must NOT be in same SOI (you're transferring TO the moon)
          // Planet targets: allow if on eccentric trajectory (returning from moon)
          if (targetInfo.class === 'moon') {
            return ctx.successResponse('course_correct',
              `Already at ${target}! No course correction needed.\n` +
              `Orbit: Pe=${Math.round((orbitInfo?.periapsis ?? 0) / 1000)}km, Ap=${Math.round((orbitInfo?.apoapsis ?? 0) / 1000)}km`);
          }

          // Planet: only block if in stable/circular orbit (ecc <= 0.3)
          if (!isEccentricApproach) {
            return ctx.successResponse('course_correct',
              `Already orbiting ${target}! No course correction needed.\n` +
              `Orbit: Pe=${Math.round((orbitInfo?.periapsis ?? 0) / 1000)}km, Ap=${Math.round((orbitInfo?.apoapsis ?? 0) / 1000)}km`);
          }

          // Eccentric trajectory at planet - allow course correction (returning from moon)
          logger.info(`[CourseCorrect] On eccentric approach to ${target} (e=${orbitInfo?.eccentricity?.toFixed(2)})`);
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
      let smartAdvice: string | undefined;
      let convTargets: BodyPeriapsisTargets | undefined;

      // Smart periapsis selection for planets/moons
      if (target) {
        const planetInfo = await queryPlanetInfo(conn, target);
        if (planetInfo) {
          convTargets = getBodyPeriapsisTargets(planetInfo.atmosphereHeight);
          const smart = getSmartPeriapsis(planetInfo);
          smartAdvice = smart.advice;

          // Check current encounter periapsis
          const currentPe = await queryCurrentEncounterPeriapsis(conn);

          if (currentPe.hasPeriapsis && currentPe.body.toLowerCase() === target.toLowerCase()) {
            const peKm = currentPe.periapsis / 1000;

            // If already in ideal range, don't course correct - just give advice
            if (currentPe.periapsis >= smart.idealMin && currentPe.periapsis <= smart.idealMax) {
              return ctx.successResponse('course_correct',
                `Periapsis ${peKm.toFixed(0)}km is already in ideal range ` +
                `(${(smart.idealMin / 1000).toFixed(0)}-${(smart.idealMax / 1000).toFixed(0)}km).\n` +
                `Next: ${smart.advice}`);
            }

            // Outside ideal range - use smart target if user didn't specify a custom distance
            // (default is 50000, so if it's still 50000 we can override)
            if (targetDistance === 50_000) {
              logger.info(`[CourseCorrect] Current Pe ${peKm.toFixed(0)}km outside ideal range for ${smart.planetType}, ` +
                         `adjusting to ${(smart.targetPeriapsis / 1000).toFixed(0)}km`);
              targetDistance = smart.targetPeriapsis;
            }
          } else if (!currentPe.hasPeriapsis && targetDistance === 50_000) {
            // No encounter yet but we have planet info - use smart default
            logger.info(`[CourseCorrect] Using smart periapsis ${(smart.targetPeriapsis / 1000).toFixed(0)}km for ${smart.planetType} ${planetInfo.name}`);
            targetDistance = smart.targetPeriapsis;
          }
        }
      }

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

      const MAX_BURNS = 3; // Max correction burns

      // History for secant method: [{input, result}, ...]
      const history: Array<{ input: number; result: number }> = [];
      let inputPe = targetDistance; // Current input to MechJeb
      let actualPe = 0;
      let totalBurns = 0;

      // Create fine-tune function for body targets when executing
      let fineTuneFunction: FineTuneFunction | undefined;
      if (shouldExecute) {
        const targetInfo = await getTargetValidationInfo(conn);
        if (targetInfo && (targetInfo.class === 'moon' || targetInfo.class === 'planet')) {
          fineTuneFunction = await createCourseCorrectFineTune(conn, target ?? targetInfo.name);
        }
      }

      for (let burn = 0; burn < MAX_BURNS; burn++) {
        logger?.info(`[CourseCorrect] Burn ${burn + 1}/${MAX_BURNS}: requesting ${(inputPe / 1000).toFixed(1)}km`);

        const result = await orchestrator.courseCorrection(inputPe, {
          target: burn === 0 ? target : undefined, // Only set target on first attempt
          execute: shouldExecute,
          logger,
          callerTool: 'course_correct',
          fineTuneFunction,
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
          const diag = await getDiagnostics(conn);
          return ctx.errorResponse('course_correct', `${result.error ?? 'Failed'}${diag}`);
        }

        // Post-creation validation: reject invalid nodes
        if (result.deltaV != null && result.deltaV < 0.1) {
          // Node is essentially 0 m/s - no correction needed or invalid
          await conn.raw('IF HASNODE { REMOVE NEXTNODE. }', 2000);
          const diag = await getDiagnostics(conn);
          return ctx.errorResponse('course_correct',
            `Course correction node is 0 m/s - no adjustment needed or trajectory already optimal.\n` +
            `Current trajectory may already be at target periapsis.${diag}`);
        }

        // Check if node is in current SOI (before any SOI transition)
        if (result.timeToNode != null) {
          const soiCheck = await conn.queue(
            'IF SHIP:ORBIT:HASNEXTPATCH { PRINT "SOI|" + ROUND(SHIP:ORBIT:NEXTPATCHETA). } ELSE { PRINT "NOSOI". }',
            2000
          );
          const soiMatch = soiCheck.success ? soiCheck.output.match(/SOI\|(\d+)/) : null;
          if (soiMatch) {
            const timeToSOI = parseInt(soiMatch[1]);
            if (result.timeToNode > timeToSOI) {
              // Node is after SOI transition - invalid
              await conn.raw('IF HASNODE { REMOVE NEXTNODE. }', 2000);
              return ctx.errorResponse('course_correct',
                `Course correction node is scheduled after SOI transition (in ${formatTime(result.timeToNode)} vs SOI in ${formatTime(timeToSOI)}).\n` +
                `Execute the transfer first, warp to SOI, then course correct.`);
            }
          }
        }

        if (!shouldExecute) {
          // Not executing - just return node info
          return ctx.successResponse('course_correct',
            `Node: ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, in ${formatTime(result.timeToNode ?? 0)}\nTarget: ${(targetDistance / 1000).toFixed(0)}km`);
        }

        totalBurns++;

        // Check actual post-burn periapsis - try MechJeb first, fall back to kOS native
        let postBurn = await queryActualPeriapsis(conn);
        if (!postBurn.hasEncounter) {
          // Fallback: use kOS native orbit checking
          const nativePe = await queryCurrentEncounterPeriapsis(conn);
          if (nativePe.hasPeriapsis) {
            postBurn = { hasEncounter: true, periapsis: nativePe.periapsis };
          } else {
            const diag = await getDiagnostics(conn);
            return ctx.errorResponse('course_correct', `Lost encounter after burn${diag}`);
          }
        }

        actualPe = postBurn.periapsis;
        const error = Math.abs(actualPe - targetDistance) / targetDistance;
        logger?.info(`[CourseCorrect] Post-burn ${totalBurns}: actual=${(actualPe / 1000).toFixed(1)}km (target: ${(targetDistance / 1000).toFixed(0)}km, error: ${(error * 100).toFixed(1)}%)`);

        // Record for secant method
        history.push({ input: inputPe, result: actualPe });

        // Check if periapsis is in optimal range (or within 25% for non-body targets)
        const converged = convTargets
          ? (actualPe >= convTargets.acceptableMin && actualPe <= convTargets.courseCorrectThreshold)
          : (error <= 0.25);
        if (converged) {
          const encounterInfo = await queryTargetEncounterInfo(conn);
          let text = `Course corrected (${totalBurns} burn${totalBurns !== 1 ? 's' : ''})`;
          text += `\nTarget: ${(targetDistance / 1000).toFixed(0)}km → Achieved: ${(actualPe / 1000).toFixed(0)}km`;
          if (encounterInfo && encounterInfo.targetType === 'body') {
            text += `\nEncounter: ${encounterInfo.targetName} (optimal)`;
            // Use smart advice if available, otherwise default
            const nextStep = smartAdvice ?? 'Warp to SOI, then circularize';
            text += `\nNext: ${nextStep}`;
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
          // First iteration: calculate adjustment needed
          // If actualPe is negative (impact), we need to raise significantly
          if (actualPe <= 0) {
            // Impact trajectory - request higher to compensate
            inputPe = targetDistance * 2;
            logger?.info(`[CourseCorrect] Impact trajectory (${(actualPe / 1000).toFixed(1)}km), requesting ${(inputPe / 1000).toFixed(1)}km`);
          } else {
            const ratio = targetDistance / actualPe;
            inputPe = inputPe * ratio;
            logger?.info(`[CourseCorrect] Ratio: ${ratio.toFixed(3)}, next input=${(inputPe / 1000).toFixed(1)}km`);
          }
        }
      }

      // Max burns reached
      const encounterInfo = await queryTargetEncounterInfo(conn);
      let text = `Partial correction (${totalBurns} burn${totalBurns !== 1 ? 's' : ''})`;
      text += `\nTarget: ${(targetDistance / 1000).toFixed(0)}km → Achieved: ${(actualPe / 1000).toFixed(0)}km`;

      if (encounterInfo && encounterInfo.targetType === 'body') {
        const nextStep = smartAdvice ?? 'Warp to SOI, then circularize';
        const finalConverged = convTargets
          ? (actualPe >= convTargets.acceptableMin && actualPe <= convTargets.courseCorrectThreshold)
          : (Math.abs(actualPe - targetDistance) / targetDistance <= 0.25);
        if (finalConverged) {
          text += `\nEncounter: ${encounterInfo.targetName} (optimal)`;
          text += `\nNext: ${nextStep}`;
        } else if (actualPe >= (convTargets?.acceptableMin ?? 10_000)) {
          text += `\nEncounter: ${encounterInfo.targetName} (acceptable)`;
          text += `\nNext: ${nextStep}`;
        } else {
          text += `\nEncounter: ${encounterInfo.targetName} (needs correction)`;
        }
      }

      return ctx.successResponse('course_correct', text);
    } catch (error) {
      return ctx.errorResponse('course_correct', error instanceof Error ? error.message : String(error));
    }
  },
};
