/**
 * Landing Autopilot - Start, stop, and monitor landing
 */

import { z } from 'zod';
import type { ToolDefinition, McpLogger } from '../../tool-types.js';
import { nullLogger, parseTarget, resolveTargetName } from '../../tool-types.js';
import { setKosOperation, clearKosOperation } from '../../../utils/kos-operation-state.js';
import { clearBroadcastLogger } from '../../../utils/mcp-logger.js';
import { pollWithBlackoutResilience } from '../../../utils/poll-with-resilience.js';
import { warpToRadioContact } from '../../../utils/radio-contact.js';
import type { KosConnection } from '../../../transport/kos-connection.js';
import {
  getLandingStatus,
  setLandingConfig,
  setLandingPositionTarget,
  hasLandingPositionTarget,
  startTargetedLanding,
  startUntargetedLanding,
  type LandingStatus,
  type LandingConfig,
} from './shared.js';
import { findLandingSite } from './find-site.js';
import { getVesselStateInfo } from '../../kos/vessel/validate.js';
import { invalidateStatusCache } from '../telemetry.js';
import { circularize } from '../basic/circularize.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import { fmtVel, fmtDist, formatTime } from '../../utils/format.js';
import { warpForward } from '../../kos/warp.js';
import { forceDisconnect, ensureConnected } from '../../../transport/connection-tools.js';

// ============================================================================
// Target Validation
// ============================================================================

/**
 * Check if current KSP target is valid for landing:
 * - Landed vessel on same body as ship (checked FIRST - explicit user target)
 * - Body target matching current SOI
 * - MechJeb position target (fallback - may be stale from previous attempts)
 * Returns { valid, lat?, lng?, name? } or { valid: false }
 */
let myBody:string;
async function getValidLandingTarget(conn: KosConnection): Promise<{
  valid: boolean;
  latitude?: number;
  longitude?: number;
  name?: string;
}> {
  // Check for landed vessel target FIRST - this is an explicit user target
  const vesselCheck = await conn.queue(
    'IF HASTARGET AND TARGET:ISTYPE("Vessel") { ' +
    '  IF TARGET:STATUS = "LANDED" OR TARGET:STATUS = "SPLASHED" { ' +
    '    IF TARGET:BODY:NAME = SHIP:BODY:NAME { ' +
    '      PRINT "LANDED|" + TARGET:GEOPOSITION:LAT + "|" + TARGET:GEOPOSITION:LNG + "|" + TARGET:NAME. ' +
    '    } ELSE { PRINT "WRONGBODY". } ' +
    '  } ELSE { PRINT "NOTLANDED". } ' +
    '} ELSE { PRINT "NOTARGET". }',
    3000
  );

  const landedMatch = vesselCheck.output.match(/LANDED\|([-\d.]+)\|([-\d.]+)\|(.+)/);
  if (landedMatch) {
    return {
      valid: true,
      latitude: Number.parseFloat(landedMatch[1]),
      longitude: Number.parseFloat(landedMatch[2]),
      name: landedMatch[3].trim(),
    };
  }

  // Check for body target matching current SOI - use default landing location
  const bodyTargetCheck = await conn.queue(
    'IF HASTARGET AND TARGET:ISTYPE("Body") { ' +
    '  IF TARGET:NAME = SHIP:BODY:NAME { PRINT "SAMEBODY|" + TARGET:NAME. } ' +
    '  ELSE { PRINT "OTHERBODY". } ' +
    '} ELSE { PRINT "NOTBODY". }',
    3000
  );

  const sameBodyMatch = bodyTargetCheck.output.match(/SAMEBODY\|(.+)/);
  if (sameBodyMatch) {
    const bodyName = sameBodyMatch[1].trim().toLowerCase();
    // For Kerbin, default to KSC runway
    if (bodyName === 'kerbin') {
      return { valid: true, latitude: -0.0972, longitude: -74.5577, name: 'KSC (default for Kerbin)' };
    }
    // For other bodies, fall through to findLandingSite (returns valid: false)
  }

  // Fall back to MechJeb position target (may be stale from previous landing attempts)
  const mjTarget = await conn.queue(
    'SET TGT TO ADDONS:MJ:TARGET. ' +
    'IF TGT:POSITIONTARGETEXISTS { PRINT "POS|" + TGT:TARGETLATITUDE + "|" + TGT:TARGETLONGITUDE + "|" + TGT:TARGETBODY. } ' +
    'ELSE { PRINT "NOPOS". }',
    3000
  );

  const posMatch = mjTarget.output.match(/POS\|([-\d.]+)\|([-\d.]+)\|(.+)/);
  if (posMatch) {
    const lat = Number.parseFloat(posMatch[1]);
    const lng = Number.parseFloat(posMatch[2]);
    const body = posMatch[3].trim();

    // Verify it's on our current body
    const shipBody = await conn.queue('PRINT SHIP:BODY:NAME.', 2000);
    myBody = shipBody.output;
    if (shipBody.output.includes(body)) {
      return { valid: true, latitude: lat, longitude: lng, name: `Position ${lat.toFixed(2)}°, ${lng.toFixed(2)}°` };
    }
  }

  return { valid: false };
}

// ============================================================================
// Vessel Structure Scanning
// ============================================================================

interface VesselScanResult {
  hasLandingLegs: boolean;
  landingLegStage: number | null;  // Lowest stage with legs
  hasBrakeTag: boolean;            // For airless 3-stage: 'brake' tagged decoupler exists
  hasLanderTag: boolean;           // For airless 3-stage: 'lander' tagged decoupler exists
  hasLander2Tag: boolean;          // For airless 2-stage: 'lander2' tagged decoupler (post-deorbit timing)
  reentryStage: number | null;     // For atmospheric: 'reentry' tagged separation stage
  error?: string;
}

/**
 * Scan vessel structure for landing legs and tagged decouplers.
 *
 * Tag-based separation (requires kOS part tags on decouplers):
 * - 'brake' tag: separates before braking burn (drop transfer stage)
 * - 'lander' tag: separates after braking (drop brake stage before final descent)
 * - 'lander2' tag: separates after deorbit burn (2-stage post-deorbit timing)
 * - 'reentry' tag: separates before atmospheric entry
 *
 * Vessels without tags will not have automatic separation.
 */
async function scanVesselForLanding(
  conn: KosConnection,
  _hasAtmosphere: boolean = false
): Promise<VesselScanResult> {
  // Scan vessel for landing legs and tagged separators (brake, lander, lander2, reentry)
  const script = `
    FUNCTION IS_LANDING_LEG {
      PARAMETER p.
      RETURN p:HASMODULE("ModuleLandingLeg") OR p:HASMODULE("ModuleWheelDeployment") OR p:HASMODULE("ModuleWheelBase").
    }
    FUNCTION IS_SEPARATOR {
      PARAMETER p.
      RETURN p:STAGE >= 0 AND (p:HASMODULE("ModuleDecouple") OR p:HASMODULE("ModuleAnchoredDecoupler")).
    }
    FUNCTION IS_DOCKING_PORT {
      PARAMETER p.
      RETURN p:STAGE >= 0 AND p:HASMODULE("ModuleDockingNode").
    }
    LOCAL hasLegs IS FALSE.
    LOCAL hasBrakeTag IS FALSE.
    LOCAL hasLanderTag IS FALSE.
    LOCAL hasLander2Tag IS FALSE.
    LOCAL taggedReentry IS -1.
    FOR p IN SHIP:PARTS {
      IF IS_LANDING_LEG(p) { SET hasLegs TO TRUE. }
      IF (p:TAG = "brake" OR p:TAG = "break") AND (IS_SEPARATOR(p) OR IS_DOCKING_PORT(p)) {
        SET hasBrakeTag TO TRUE.
      }
      IF p:TAG = "lander" AND (IS_SEPARATOR(p) OR IS_DOCKING_PORT(p)) {
        SET hasLanderTag TO TRUE.
      }
      IF p:TAG = "lander2" AND (IS_SEPARATOR(p) OR IS_DOCKING_PORT(p)) {
        SET hasLander2Tag TO TRUE.
      }
      IF p:TAG = "reentry" AND IS_SEPARATOR(p) {
        IF taggedReentry < 0 { SET taggedReentry TO p:STAGE. }
      }
    }
    IF NOT hasLegs { PRINT "NOLEGS". }
    ELSE {
      PRINT "SCAN|" + hasBrakeTag + "|" + hasLanderTag + "|" + hasLander2Tag + "|" + taggedReentry.
    }
  `.trim().replaceAll('\n', ' ');

  const result = await conn.queue(script, 10_000);
  const rawOutput = result.output.trim();

  // No landing legs
  if (rawOutput.endsWith('NOLEGS')) {
    return { hasLandingLegs: false, landingLegStage: null, hasBrakeTag: false, hasLanderTag: false, hasLander2Tag: false, reentryStage: null };
  }

  // Parse SCAN result: hasBrakeTag|hasLanderTag|hasLander2Tag|taggedReentry
  const scanMatch = rawOutput.match(/SCAN\|(True|False)\|(True|False)\|(True|False)\|([-\d]+)$/i);
  if (scanMatch) {
    const hasBrakeTag = scanMatch[1].toLowerCase() === 'true';
    const hasLanderTag = scanMatch[2].toLowerCase() === 'true';
    const hasLander2Tag = scanMatch[3].toLowerCase() === 'true';
    const taggedReentry = parseInt(scanMatch[4]);

    const reentryStage = taggedReentry >= 0 ? taggedReentry : null;

    return { hasLandingLegs: true, landingLegStage: null, hasBrakeTag, hasLanderTag, hasLander2Tag, reentryStage };
  }

  return {
    hasLandingLegs: false,
    landingLegStage: null,
    hasBrakeTag: false,
    hasLanderTag: false,
    hasLander2Tag: false,
    reentryStage: null,
    error: `Failed to parse vessel scan: ${rawOutput.slice(-50)}`,
  };
}

/**
 * Activate a specific decoupler/separator by its tag name.
 * This activates ONLY the tagged part(s), not the entire stage.
 * Used for 3-stage designs where we need precise control.
 *
 * Supports: stack decouplers, radial decouplers, docking ports, fairings
 *
 * @param thenStage - If true, fire STAGE once after decoupling to activate
 *                    engines/parts in the next stage without firing everything
 */
async function activateDecouplerByTag(
  conn: KosConnection,
  tag: string,
  logger?: McpLogger,
  thenStage: boolean = false
): Promise<{ success: boolean; error?: string }> {
  const log = logger ?? nullLogger;

  // Use PARTSTAGGED for efficient lookup, handle all separator types
  // Check HASEVENT before calling to handle different module states
  const stageLogic = thenStage ? `
    IF firedCount > 0 AND STAGE:NUMBER = startStg {
      STAGE. WAIT 0.5.
    }
  ` : '';
  const script = `
    SET WARP TO 0.
    RCS ON.
    SET startStg TO STAGE:NUMBER.
    SET firedCount TO 0.
    FOR p IN SHIP:PARTSTAGGED("${tag}") {
      IF p:HASMODULE("ModuleDecouple") {
        LOCAL m IS p:GETMODULE("ModuleDecouple").
        IF m:HASEVENT("Decouple") { m:DOEVENT("Decouple"). SET firedCount TO firedCount + 1. }
      }
      ELSE IF p:HASMODULE("ModuleAnchoredDecoupler") {
        LOCAL m IS p:GETMODULE("ModuleAnchoredDecoupler").
        IF m:HASEVENT("Decouple") { m:DOEVENT("Decouple"). SET firedCount TO firedCount + 1. }
      }
      ELSE IF p:HASMODULE("ModuleDockingNode") {
        LOCAL m IS p:GETMODULE("ModuleDockingNode").
        IF m:HASEVENT("Undock") { m:DOEVENT("Undock"). SET firedCount TO firedCount + 1. }
        ELSE IF m:HASEVENT("UndockSameVessel") { m:DOEVENT("UndockSameVessel"). SET firedCount TO firedCount + 1. }
        ELSE IF m:HASEVENT("Decouple") { m:DOEVENT("Decouple"). SET firedCount TO firedCount + 1. }
      }
      ELSE IF p:HASMODULE("ModuleProceduralFairing") {
        LOCAL m IS p:GETMODULE("ModuleProceduralFairing").
        IF m:HASEVENT("Deploy") { m:DOEVENT("Deploy"). SET firedCount TO firedCount + 1. }
      }
      WAIT 0.
    }
    WAIT 0.5.
    ${stageLogic}
    SET finalStg TO STAGE:NUMBER.
    PRINT "SEP|${tag}|" + firedCount + "|" + startStg + "|" + finalStg.
  `.trim().replaceAll('\n', ' ');

  const result = await conn.queue(script, 30_000);
  const output = result.output.trim();

  // Parse: SEP|tagname|firedCount|startStage|finalStage
  const match = output.match(/SEP\|[^|]+\|(\d+)\|(\d+)\|(\d+)/i);
  if (match) {
    const firedCount = parseInt(match[1]);
    const startStage = parseInt(match[2]);
    const finalStage = parseInt(match[3]);

    if (firedCount > 0) {
      const stageInfo = thenStage ? ` (stages: ${startStage}→${finalStage})` : '';
      log.info(`[Jettison] Activated ${firedCount} '${tag}' part(s)${stageInfo}`);
      return { success: true };
    } else {
      log.warn(`[Jettison] No '${tag}' parts found or none had active decouple events`);
      return { success: false, error: `No '${tag}' parts to separate (already decoupled?)` };
    }
  }

  log.warn(`[Jettison] Failed to parse output: ${output.slice(-100)}`);
  return { success: false, error: 'Failed to parse separation result' };
}

/**
 * Fire exactly ONE stage.
 * Does NOT stage down to a target - just fires the current stage once.
 *
 * NOTE: This fires the ENTIRE current stage. For precise control of individual
 * decouplers, use activateDecouplerByTag() instead.
 */
async function jettisonStage(
  conn: KosConnection,
  _targetStage: number,  // Ignored - we just fire current stage once
  logger?: McpLogger
): Promise<{ success: boolean; error?: string }> {
  const log = logger ?? nullLogger;

  const script = `
    SET WARP TO 0.
    RCS ON.
    SET startStage TO STAGE:NUMBER.
    STAGE. WAIT 0.5.
    PRINT "STAGED|" + startStage + "|" + STAGE:NUMBER.
  `.trim().replaceAll('\n', ' ');

  const result = await conn.queue(script, 30_000);
  const output = result.output.trim();

  const match = output.match(/STAGED\|(\d+)\|(\d+)/i);
  if (match) {
    const startStage = parseInt(match[1]);
    const endStage = parseInt(match[2]);
    log.info(`[Jettison] Fired stage (was ${startStage}, now ${endStage})`);
    return { success: true };
  }

  return { success: false, error: 'Failed to parse staging result' };
}

// Configuration
const DEFAULT_POLL_INTERVAL_MS = 2500; // 2.5 seconds
const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 minutes
const TARGET_LANDING_TWR = 15; // Target TWR for landing - limit engines if higher

/**
 * Check TWR and limit engine thrust if too high for landing.
 * Returns true if thrust was limited (needs reset after landing).
 */
async function limitThrustForLanding(
  conn: KosConnection,
  logger?: McpLogger
): Promise<{ limited: boolean; originalTwr?: number; limitedTwr?: number }> {
  const log = logger ?? nullLogger;

  // Calculate TWR at surface gravity (not current altitude) for landing assessment
  const script = `
    LOCAL totalThrust IS 0.
    LOCAL activeEngines IS 0.
    FOR eng IN SHIP:ENGINES {
      IF eng:IGNITION AND eng:AVAILABLETHRUST > 0 {
        SET totalThrust TO totalThrust + eng:AVAILABLETHRUST.
        SET activeEngines TO activeEngines + 1.
      }
    }
    LOCAL surfaceG IS SHIP:BODY:MU / SHIP:BODY:RADIUS^2.
    LOCAL weight IS SHIP:MASS * surfaceG.
    LOCAL twr IS CHOOSE 0 IF weight = 0 ELSE totalThrust / weight.
    PRINT "TWR|" + ROUND(twr, 2) + "|" + ROUND(totalThrust) + "|" + ROUND(weight) + "|" + activeEngines.
  `.trim().replaceAll('\n', ' ');

  const result = await conn.queue(script, 5000);
  const match = result.output.match(/TWR\|([\d.]+)\|(\d+)\|(\d+)\|(\d+)/);

  if (!match) {
    log.warn('[Landing] Could not calculate TWR');
    return { limited: false };
  }

  const twr = Number.parseFloat(match[1]);
  const activeEngines = Number.parseInt(match[4]);

  if (activeEngines === 0) {
    log.warn('[Landing] No active engines found');
    return { limited: false };
  }

  if (twr <= TARGET_LANDING_TWR) {
    log.progress(`[Landing] TWR ${twr.toFixed(1)} acceptable (limit is ${TARGET_LANDING_TWR})`);
    return { limited: false };
  }

  // TWR too high - calculate thrust limit percentage
  const limitPercent = (TARGET_LANDING_TWR / twr) * 100;
  log.progress(`[Landing] TWR ${twr.toFixed(1)} too high, limiting thrust to ${limitPercent.toFixed(0)}%`);

  // Apply thrust limit to all engines
  const limitScript = `
    FOR eng IN SHIP:ENGINES {
      IF eng:IGNITION {
        SET eng:THRUSTLIMIT TO ${limitPercent.toFixed(1)}.
      }
    }
    PRINT "LIMITED".
  `.trim().replaceAll('\n', ' ');

  await conn.raw(limitScript, 5000);

  return { limited: true, originalTwr: twr, limitedTwr: TARGET_LANDING_TWR };
}

/**
 * Reset engine thrust limits to 100% after landing.
 */
async function resetThrustLimits(conn: KosConnection, logger?: McpLogger): Promise<void> {
  const log = logger ?? nullLogger;
  log.info('[Landing] Resetting engine thrust limits to 100%');

  const script = `
    FOR eng IN SHIP:ENGINES {
      SET eng:THRUSTLIMIT TO 100.
    }
    PRINT "RESET".
  `.trim().replaceAll('\n', ' ');

  await conn.raw(script, 5000);
}

interface LandingPollState {
  status: LandingStatus;
  isLanded: boolean;
  wasAborted: boolean;
}

// Require multiple consecutive "disabled" readings before declaring abort
// This handles momentary glitches during blackout recovery or warp transitions
const ABORT_CONFIRMATION_COUNT = 3;

/**
 * Monitor landing progress until completion or timeout.
 */
async function monitorLanding(
  conn: KosConnection,
  options: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    logger?: McpLogger;
    deferredSeparation?: {
      // Tag-based separation (for 3-stage airless designs with 'brake' and 'lander' tags)
      // When set, activates specific decouplers by tag name instead of staging
      primaryTag?: string;      // First separation tag (e.g., 'brake') - fires at braking burn
      primaryThenStage?: boolean; // Fire STAGE after primary tag decouple (activate engines)
      secondaryTag?: string;    // Second separation tag (e.g., 'lander') - fires at final descent
      secondaryThenStage?: boolean; // Fire STAGE after secondary tag decouple (activate engines)
      // Stage-based separation (fallback for non-tagged designs)
      stage?: number;           // Primary stage number (fires entire stage)
      fallbackAltitude: number; // Altitude fallback if no status-based trigger
      hasAtmosphere?: boolean;  // Body type for separation trigger selection
    };
  } = {}
): Promise<{ success: boolean; finalStatus: LandingStatus; error?: string; hadBlackout?: boolean }> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    logger,
    deferredSeparation,
  } = options;

  const log = logger ?? nullLogger;
  let lastStatusText = '';
  let lastLoggedSpeed = 0;
  let lastLoggedAlt = 0;
  let descentLogCount = 0;
  let consecutiveDisabledCount = 0;
  let lastThresholdLogTime = Date.now();  // For threshold matches: every 10s
  let lastNonThresholdLogTime = Date.now();  // For status changes: state change OR 15s
  let consecutiveSameStatusCount = 0;  // Track repeated status for warp nudging

  // Track deferred separation state (brake separation only - lander handled by WHEN trigger)
  let separationFired = false;

  // Check atmosphere once at start - physics warp only on vacuum bodies
  // Use passed value if available, otherwise query
  let hasAtmosphere = deferredSeparation?.hasAtmosphere ?? false;
  if (deferredSeparation?.hasAtmosphere === undefined) {
    try {
      const atmCheck = await conn.queue('PRINT SHIP:BODY:ATM:EXISTS.', 2000);
      hasAtmosphere = atmCheck.output.includes('True');
    } catch { /* assume no atmosphere */ }
  }

  // Track braking progress for progressive warp
  let initialBrakingSpeed = 0;
  let currentWarpLevel = 0;

  const result = await pollWithBlackoutResilience<LandingPollState>({
    poll: async () => {
      // Always check SHIP:STATUS first - this is the ground truth for landing detection
      // getLandingStatus can fail after landing when MechJeb returns unexpected values
      const groundCheck = await conn.queue('PRINT SHIP:STATUS.', 3000);
      const isLanded = groundCheck.output.includes('LANDED') || groundCheck.output.includes('SPLASHED');

      // If landed, return immediately - no need for MechJeb status
      if (isLanded) {
        return {
          status: {
            enabled: false,
            status: 'Landed',
            landingAtTarget: false,
            predictionReady: false,
            formatted: 'Landed',
          },
          isLanded: true,
          wasAborted: false,
        };
      }

      // Not landed - get full MechJeb status for progress tracking
      const status = await getLandingStatus(conn);

      // Check if landing completed (autopilot disabled itself)
      let wasAborted = false;

      if (!status.enabled) {
        // Track consecutive disabled readings to avoid false positives
        // during blackout recovery or warp transitions
        consecutiveDisabledCount++;

        // Only declare abort after multiple consecutive disabled readings
        wasAborted = consecutiveDisabledCount >= ABORT_CONFIRMATION_COUNT;

        if (consecutiveDisabledCount < ABORT_CONFIRMATION_COUNT) {
          log.progress(`[Landing] Autopilot disabled - confirming (${consecutiveDisabledCount}/${ABORT_CONFIRMATION_COUNT})...`);
        }
      } else {
        // Reset counter when autopilot is enabled
        consecutiveDisabledCount = 0;
      }

      return { status, isLanded: false, wasAborted };
    },

    isDone: (state) => state.isLanded || state.wasAborted,
    isSuccess: (state) => state.isLanded,

    timeoutMs,
    pollIntervalMs,
    logger,
    context: 'Landing',
    connection: conn,

    onPoll: async (state) => {
      const rawStatus = state.status.status;

      // Handle deferred separation - fires based on MechJeb status or altitude fallback
      // Triggers:
      //   Atmospheric: "Coasting toward deceleration burn" (after deorbit, before atmosphere)
      //   Airless: "Warping to start of braking burn" (after course correction, before braking)
      //   Fallback: altitude threshold for either body type
      if (!separationFired && deferredSeparation) {
        const isCoasting = /Coasting toward deceleration burn/i.test(rawStatus);
        const isWarpingToBrake = /Warping to start of braking burn/i.test(rawStatus);
        const isCourseCorrection = /course correction/i.test(rawStatus);

        // Determine if we should fire separation
        // For atmospheric: fire when coasting (after deorbit burn)
        // For airless: fire when warping to braking burn (after any course corrections)
        // Never fire during course correction - that's exactly what we're trying to avoid
        const shouldSeparate = !isCourseCorrection && (
          (hasAtmosphere && isCoasting) ||
          (!hasAtmosphere && isWarpingToBrake)
        );

        if (shouldSeparate) {
          const separationType = hasAtmosphere ? 'reentry' : (deferredSeparation.primaryTag ?? 'lander');
          log.progress(`[Landing] Preparing for ${separationType} separation...`);

          // Step 0: Stop any active warp first - MechJeb won't respond while warping
          try {
            await conn.raw('SET WARP TO 0. WAIT 1.', 5000);
          } catch { /* ignore */ }

          // Step 1: Disable MechJeb landing autopilot
          try {
            const disableResult = await conn.queue(
              'SET LAND TO ADDONS:MJ:LANDING. SET LAND:ENABLED TO FALSE. WAIT 0.5. PRINT "DISABLED|" + LAND:ENABLED.',
              5000
            );
            if (disableResult.output.includes('DISABLED|False')) {
              log.progress(`[Landing] Autopilot paused`);
            } else {
              log.warn(`[Landing] Failed to pause autopilot: ${disableResult.output}`);
            }
          } catch (e) {
            log.warn(`[Landing] Error pausing autopilot: ${e}`);
          }

          // Step 2: For atmospheric bodies, warp closer to periapsis if needed
          // For airless bodies, we're already at the right time (triggered by "Warping to braking burn")
          if (hasAtmosphere) {
            try {
              const etaCheck = await conn.queue('PRINT "ETA|" + ROUND(ETA:PERIAPSIS).', 3000);
              const etaMatch = etaCheck.output.match(/ETA\|(\d+)/);
              const currentEta = etaMatch ? parseInt(etaMatch[1]) : 0;

              if (currentEta > 660) {
                log.progress(`[Landing] Warping from ${Math.round(currentEta / 60)} min to 10 min before periapsis...`);
                const warpTarget = currentEta - 600;
                await conn.raw(`WARPTO(TIME:SECONDS + ${warpTarget}).`, 5000);

                // Wait for warp to complete
                const warpWaitResult = await conn.queue(
                  'WAIT UNTIL ETA:PERIAPSIS < 620. SET WARP TO 0. PRINT "ARRIVED|" + ROUND(ETA:PERIAPSIS).',
                  300_000
                );
                const arrivedMatch = warpWaitResult.output.match(/ARRIVED\|(\d+)/);
                if (arrivedMatch) {
                  log.progress(`[Landing] At ${Math.round(parseInt(arrivedMatch[1]) / 60)} min before periapsis`);
                }
              } else {
                log.progress(`[Landing] Already at ${Math.round(currentEta / 60)} min before periapsis`);
              }
            } catch (e) {
              log.warn(`[Landing] Warp failed: ${e}`);
            }
          }

          // Step 3: Fire separation
          // Use tag-based activation if primaryTag is set, otherwise use stage-based
          log.progress(`[Landing] Firing ${separationType} separation...`);
          let result: { success: boolean; error?: string };
          if (deferredSeparation.primaryTag) {
            result = await activateDecouplerByTag(conn, deferredSeparation.primaryTag, log, deferredSeparation.primaryThenStage);
          } else if (deferredSeparation.stage != null) {
            result = await jettisonStage(conn, deferredSeparation.stage, log);
          } else {
            result = { success: false, error: 'No separation tag or stage configured' };
          }
          if (result.success) {
            log.progress('[Landing] Separated');
          } else {
            log.warn(`[Landing] Separation failed: ${result.error}`);
          }
          separationFired = true;

          // Step 4: Unlock controls, enable RCS, limit thrust (atmospheric only), and re-enable MechJeb
          // Include stabilization delay for kOS to recognize new vessel configuration
          try {
            await conn.raw('UNLOCK STEERING. UNLOCK THROTTLE. SAS OFF. RCS ON. WAIT 1.', 5000);

            // For atmospheric reentry capsules, limit thrust to 30% for precision adjustments
            // Full thrust causes capsule to flip during MechJeb's corrections
            // For airless landers, let the pre-landing TWR limiter handle it (runs later)
            if (hasAtmosphere) {
              log.progress(`[Landing] Limiting thrust to 30% for precision landing`);
              await conn.raw(`
                FOR eng IN SHIP:ENGINES {
                  IF eng:IGNITION { SET eng:THRUSTLIMIT TO 30. }
                }
              `.trim().replaceAll('\n', ' '), 5000);
            }

            const enableResult = await conn.queue(
              'SET LAND TO ADDONS:MJ:LANDING. SET LAND:ENABLED TO TRUE. WAIT 2. PRINT "ENABLED|" + LAND:ENABLED.',
              10_000
            );
            if (enableResult.output.includes('ENABLED|True')) {
              log.progress(`[Landing] Autopilot resumed`);
            } else {
              log.warn(`[Landing] Failed to resume autopilot: ${enableResult.output}`);
            }
          } catch (e) {
            log.warn(`[Landing] Error resuming autopilot: ${e}`);
          }
        }

      // NOTE: Lander separation (secondaryTag) for 3-stage airless designs is now handled
      // by a kOS WHEN trigger set up before monitoring starts. The trigger fires automatically
      // when the status transitions from "deorbit burn" to something else (before braking burn).

        // Fallback: if we're below fallback altitude and haven't separated, do it now
        const altitude = state.status.altitude;
        if (!separationFired && altitude !== undefined && altitude <= deferredSeparation.fallbackAltitude) {
          try {
            await conn.raw('SET WARP TO 0.', 3000);
          } catch { /* ignore */ }

          const fallbackReason = hasAtmosphere ? 'Approaching atmosphere' : 'Approaching surface';
          log.progress(`[Landing] ${fallbackReason} - firing deferred separation...`);
          // Use tag-based or stage-based separation depending on configuration
          let result: { success: boolean; error?: string };
          if (deferredSeparation.primaryTag) {
            result = await activateDecouplerByTag(conn, deferredSeparation.primaryTag, log, deferredSeparation.primaryThenStage);
          } else if (deferredSeparation.stage != null) {
            result = await jettisonStage(conn, deferredSeparation.stage, log);
          } else {
            result = { success: false, error: 'No separation tag or stage configured' };
          }
          if (result.success) {
            log.progress('[Landing] Separated');
          } else {
            log.warn(`[Landing] Separation failed: ${result.error}`);
          }
          separationFired = true;

          // Unlock controls and enable RCS after separation so MechJeb can take over
          // Include stabilization delay for kOS to recognize new vessel configuration
          try {
            await conn.raw('UNLOCK STEERING. UNLOCK THROTTLE. SAS OFF. RCS ON. WAIT 2.', 5000);
          } catch { /* ignore */ }
        }
      }

      // Parse braking speed from status like "Braking: target speed = 155 m/s"
      const brakingMatch = rawStatus.match(/Braking.*?(\d+)/);
      if (brakingMatch) {
        const speed = parseInt(brakingMatch[1]);

        // Track initial braking speed for progress calculation
        if (initialBrakingSpeed === 0 && speed > 0) {
          initialBrakingSpeed = speed;
        }

        // Log if threshold met (30 m/s change) AND 10s has passed
        const now = Date.now();
        const thresholdMet = lastLoggedSpeed === 0 || lastLoggedSpeed - speed >= 30;
        const timeElapsed = now - lastThresholdLogTime >= 10_000;
        if (thresholdMet && timeElapsed) {
          log.progress(`[Landing] Braking: ${speed}_m/sec`);
          lastLoggedSpeed = speed;
          lastThresholdLogTime = now;
        }
      }

      // Parse final descent altitude from status like "Final descent: 200m above terrain"
      const descentMatch = rawStatus.match(/Final descent.*?(\d+)/);
      if (descentMatch) {
        const alt = parseInt(descentMatch[1]);
        // Reduce warp when getting close, only log at key altitudes
        if (alt < 100 && currentWarpLevel > 0) {
          try {
            await conn.raw('SET WARP TO 0.');
            currentWarpLevel = 0;
          } catch { /* ignore */ }
        }
        // Log if threshold met (50m change or key altitude) AND 10s has passed
        const now = Date.now();
        const thresholdMet = lastLoggedAlt === 0 || lastLoggedAlt - alt >= 50 || alt <= 20;
        const timeElapsed = now - lastThresholdLogTime >= 10_000;
        if (thresholdMet && timeElapsed) {
          descentLogCount++;
          // Every other log, include descent rate
          if (descentLogCount % 2 === 0) {
            try {
              const vsResult = await conn.queue('PRINT ROUND(-SHIP:VERTICALSPEED, 1).', 2000);
              const vs = parseFloat(vsResult.output.match(/([\d.]+)/)?.[1] ?? '0');
              log.progress(`[Landing] Final descent: ${alt}m, down at ${Math.round(vs)}_m/sec`);
            } catch {
              log.progress(`[Landing] Final descent: ${alt}m`);
            }
          } else {
            log.progress(`[Landing] Final descent: ${alt}m`);
          }
          lastLoggedAlt = alt;
          lastThresholdLogTime = now;
        }
        return;
      }

      // Stop warp when status changes to something other than braking/descent
      if (lastLoggedSpeed > 0 || lastLoggedAlt > 0) {
        // Ensure warp is fully stopped before switching back to RAILS
        try {
          await conn.raw('SET WARP TO 0.');
          await conn.raw('SET WARPMODE TO "RAILS".');
          currentWarpLevel = 0;
        } catch { /* ignore */ }
        lastLoggedSpeed = 0;
        lastLoggedAlt = 0;
        initialBrakingSpeed = 0; // Reset for next braking phase
      }

      // Log status changes or every 15 seconds (matches ascent/execute-node pattern)
      const now = Date.now();
      const stateChanged = rawStatus !== lastStatusText;
      const timeElapsed = now - lastNonThresholdLogTime >= 15_000;

      // Track consecutive same status for warp nudging
      // When MechJeb is waiting (e.g., "Executing low orbit plane change"), nudge warp forward
      if (stateChanged) {
        consecutiveSameStatusCount = 0;
      } else {
        consecutiveSameStatusCount++;
        // After seeing same status twice, nudge warp by 1 (max 4x)
        if (consecutiveSameStatusCount >= 2) {
          try {
            // Check if thrusting or in atmosphere to choose warp mode
            // PHYSICS warp required when throttle active or in atmosphere
            // RAILS warp can be used in vacuum with no thrust
            const warpStateCheck = await conn.queue(
              'PRINT "WS|" + WARP + "|" + (THROTTLE > 0) + "|" + ' +
              '(SHIP:BODY:ATM:EXISTS AND ALTITUDE < SHIP:BODY:ATM:HEIGHT).',
              2000
            );
            const wsMatch = warpStateCheck.output.match(/WS\|(\d+)\|(True|False)\|(True|False)/i);
            if (wsMatch) {
              const currentWarp = parseInt(wsMatch[1]);
              const isThrusting = wsMatch[2].toLowerCase() === 'true';
              const inAtmosphere = wsMatch[3].toLowerCase() === 'true';

              if (currentWarp < 4) {
                // Set appropriate warp mode before increasing
                const warpMode = (isThrusting || inAtmosphere) ? 'PHYSICS' : 'RAILS';
                await conn.raw(`SET WARPMODE TO "${warpMode}". SET WARP TO ${currentWarp + 1}.`, 2000);
                log.info(`[Landing] Nudging warp to ${currentWarp + 1}x ${warpMode} (waiting for MechJeb)`);
              }
            }
          } catch { /* ignore warp errors */ }
          consecutiveSameStatusCount = 0; // Reset after nudge
        }
      }

      if (stateChanged || timeElapsed) {
        lastStatusText = rawStatus;

        // Map raw status to cleaner messages
        let statusText: string;
        if (/Coasting toward deceleration/.test(rawStatus)) {
          statusText = 'Coasting toward deceleration burn';
        } else if (rawStatus === 'Off') {
          // Only show touchdown message if actually landed, otherwise MechJeb is just starting up
          statusText = state.isLanded
            ? 'Contact light, [[pbas 35]]Engine Shutdown, [[pbas 55]]Descent engine command override off.'
            : 'Initializing autopilot';
        } else if (/course correction/i.test(rawStatus)) {
          // Filter out "0 m/s" corrections
          const dvMatch = rawStatus.match(/(\d+)/);
          statusText = (dvMatch && parseInt(dvMatch[1]) > 0) ? rawStatus : 'Course correction complete';
        } else {
          statusText = rawStatus;
        }

        log.progress(`[Landing] ${statusText}`);
        lastNonThresholdLogTime = now;
      }

      // Log touchdown
      if (state.isLanded) {
        log.progress('[Landing] Touchdown! Landing complete.');
      }
    },
  });

  // Always reset warp to RAILS mode when poll loop exits
  try {
    await conn.raw('SET WARP TO 0. SET WARPMODE TO "RAILS".', 2000);
  } catch { /* ignore cleanup errors */ }

  if (result.timedOut && !result.result?.isLanded) {
    return {
      success: false,
      finalStatus: result.result?.status ?? { enabled: false, status: 'Unknown', landingAtTarget: false, predictionReady: false, formatted: '' },
      error: `Landing timeout after ${Math.round(timeoutMs / 60_000)} minutes`,
      hadBlackout: result.hadBlackout,
    };
  }

  if (result.result?.wasAborted) {
    return {
      success: false,
      finalStatus: result.result.status,
      error: 'Landing autopilot stopped before touchdown',
      hadBlackout: result.hadBlackout,
    };
  }

  return {
    success: result.success,
    finalStatus: result.result?.status ?? { enabled: false, status: 'Complete', landingAtTarget: false, predictionReady: false, formatted: '' },
    hadBlackout: result.hadBlackout,
  };
}

// ============================================================================
// Tool Definition
// ============================================================================

export const landTool: ToolDefinition = {
  name: 'land',
  description: 'Land on surface from orbit.',
  inputSchema: {
    // Target
    target: z.preprocess(parseTarget, z.union([z.string(), z.literal('auto')]))
      .optional()
      .default('auto')
      .describe('Landed vessel name to land near. If omitted, uses existing target (if valid surface/vessel) or auto-finds site.'),

    // Position override (only if target not specified)
    latitude: z.number()
      .min(-90)
      .max(90)
      .optional()
      .describe('Override: target latitude (-90 to 90). Ignored if target specified.'),
    longitude: z.number()
      .min(-180)
      .max(180)
      .optional()
      .describe('Override: target longitude (-180 to 180). Ignored if target specified.'),

    // Config (optional - applied before start)
    touchdownSpeed: z.number()
      .min(0)
      .max(10)
      .optional()
      .default(2)
      .describe('Target touchdown velocity in m/s (default ~2)'),
    deployGears: z.boolean()
      .optional()
      .default(true)
      .describe('Auto-deploy landing gear'),
    deployChutes: z.boolean()
      .optional()
      .default(true)
      .describe('Auto-deploy parachutes'),
    useRCS: z.boolean()
      .optional()
      .default(false)
      .describe('Use RCS for fine position adjustments'),

    // Monitoring
    wait: z.union([z.boolean(), z.literal('auto')])
      .optional()
      .default('auto')
      .describe('If true, wait for touchdown and stream progress. If false, return immediately.'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 1,
  handler: async (args, ctx, extra) => {
    let conn = await ctx.ensureConnected();
    // Resolve 'auto' to client-appropriate default
    const waitArg = args.wait as boolean | 'auto';
    const wait = waitArg === 'auto' ? ctx.supportsNotifications(extra) : waitArg;

    const logger = ctx.createLogger(extra);

    // Validate vessel state BEFORE setting operation state
    // Step 0: Validate vessel state - must be in orbit or flying
    const statusCheck = await conn.queue('PRINT SHIP:STATUS.', 2000);
    const vesselStatus = statusCheck.output.trim().split('\n').pop()?.trim().toUpperCase() ?? '';

    const validStatuses = ['FLYING', 'ORBITING', 'ESCAPING', 'SUB_ORBITAL'];
    if (!validStatuses.some(s => vesselStatus.includes(s))) {
      // Provide detailed error based on status
      let errorDetail = '';
      if (vesselStatus.includes('LANDED') || vesselStatus.includes('SPLASHED')) {
        errorDetail = `Vessel is already ${vesselStatus.toLowerCase()} on ${myBody}`;
      } else if (vesselStatus.includes('PRELAUNCH')) {
        errorDetail = 'Vessel is on a ${myBody} launchpad.';
      } else if (vesselStatus.includes('DOCKED')) {
        errorDetail = 'Vessel is docked. Undock first, then use land tool.';
      } else {
        errorDetail = `Current status: ${vesselStatus}. Must be in orbit or flying to land.`;
      }

      return ctx.errorResponse('land', `Cannot start landing: ${errorDetail}`);
    }

    try {

      // Step 0.5: Check orbital safety - handle hyperbolic/unstable approaches
      // Force fresh telemetry — stale cache can have old eccentricity from pre-circularization
      invalidateStatusCache();
      const stateInfo = await getVesselStateInfo(conn);
      const { eccentricity, periapsis } = stateInfo;

      // Determine orbit type
      const isHyperbolic = eccentricity >= 1;
      const isImpactTrajectory = periapsis < 0;
      const SAFE_PERIAPSIS_M = 15_000; // 15km minimum for safe circularization

      // Track deferred separation for high-altitude atmospheric reentry
      let deferSeparation = false;
      let highAltAtmHeight = 0; // Atmosphere height for deferred separation fallback
      let overrideTarget: string | undefined; // Override target after high-altitude reentry sequence

      // Step 0.6: Check for high-altitude atmospheric reentry FIRST
      // This applies when periapsis is below atmosphere (even if positive) and we're very far away
      {
        const reentryInfo = await conn.queue(
          'LOCAL atm IS (CHOOSE SHIP:BODY:ATM:HEIGHT IF SHIP:BODY:ATM:EXISTS ELSE 0). ' +
          'LOCAL rot IS SHIP:BODY:ROTATIONPERIOD. ' +
          'PRINT "REENTRY|" + atm + "|" + ALTITUDE + "|" + ETA:PERIAPSIS + "|" + PERIAPSIS + "|" + rot.',
          3000
        );
        const reentryMatch = reentryInfo.output.match(/REENTRY\|(\d+)\|(\d+(?:\.\d+)?)\|(\d+(?:\.\d+)?)\|([-\d.]+)\|(\d+(?:\.\d+)?)/);

        if (reentryMatch) {
          const atmHeight = parseInt(reentryMatch[1]);
          const altitude = parseFloat(reentryMatch[2]);
          const etaPeriapsis = parseFloat(reentryMatch[3]);
          const pe = parseFloat(reentryMatch[4]);
          const rotationPeriod = parseFloat(reentryMatch[5]);

          // Atmospheric reentry: atmosphere exists + periapsis below atmosphere
          const isAtmosphericReentry = atmHeight > 0 && pe < atmHeight;

          // Warp to whichever is sooner: (Pe - rotation period) OR (Pe / 2)
          const MIN_BUFFER = 600; // 10 minutes minimum
          const optionA = etaPeriapsis - rotationPeriod; // Stop 1 rotation before Pe
          const optionB = etaPeriapsis / 2;              // Stop halfway to Pe
          const warpTime = Math.floor(Math.min(optionA, optionB));

          if (isAtmosphericReentry && warpTime > MIN_BUFFER) {
            logger.progress(`[Landing] High-altitude atmospheric reentry detected`);
            logger.progress(`[Landing]   Altitude: ${fmtDist(altitude)}, Pe: ${fmtDist(pe)}, Atm: ${fmtDist(atmHeight)}`);
            logger.progress(`[Landing]   ETA to periapsis: ${formatTime(etaPeriapsis)}, body rotation: ${formatTime(rotationPeriod)}`);

            logger.progress(`[Landing] Warping ${formatTime(warpTime)} (stopping ${formatTime(etaPeriapsis - warpTime)} before Pe)...`);

            const warpResult = await warpForward(conn, warpTime, 300_000, logger);
            if (!warpResult.success) {
              logger.warn(`[Landing] Warp failed: ${warpResult.error}, continuing`);
            }

            // Deorbit burn: point retrograde and lower periapsis to between -1km and -50km
            const TARGET_PE_MIN = -50_000; // -50km lower bound
            const TARGET_PE_MAX = -1000;  // -1km upper bound
            const TARGET_PE = -5000;      // -5km target

            // Check if Pe is already in acceptable range
            const peCheckResult = await conn.queue('PRINT "PE|" + ROUND(PERIAPSIS).', 3000);
            const peCheckMatch = peCheckResult.output.match(/PE\|([-\d]+)/);
            const currentPe = peCheckMatch ? parseInt(peCheckMatch[1]) : 0;

            if (currentPe <= TARGET_PE_MAX && currentPe >= TARGET_PE_MIN) {
              logger.progress(`[Landing] Periapsis already at ${fmtDist(currentPe)}, skipping deorbit burn`);
            } else {
              logger.progress(`[Landing] Executing deorbit burn (current Pe: ${fmtDist(currentPe)}, target: ${fmtDist(TARGET_PE)})...`);

              const deorbitScript = `
                SAS OFF.
                LOCK STEERING TO RETROGRADE.
                LOCAL t0 IS TIME:SECONDS.
                WAIT UNTIL VANG(SHIP:FACING:VECTOR, -SHIP:VELOCITY:ORBIT) < 10 OR (TIME:SECONDS - t0) > 30.
                LOCK THROTTLE TO 1.
                LOCAL burnStart IS TIME:SECONDS.
                WAIT UNTIL PERIAPSIS < ${TARGET_PE} OR PERIAPSIS < ${TARGET_PE_MIN} OR (TIME:SECONDS - burnStart) > 120.
                LOCK THROTTLE TO 0.
                UNLOCK STEERING.
                UNLOCK THROTTLE.
                PRINT "DEORBIT|" + ROUND(PERIAPSIS).
              `.trim().replaceAll('\n', ' ');

              const deorbitResult = await conn.queue(deorbitScript, 180_000);
              const deorbitMatch = deorbitResult.output.match(/DEORBIT\|([-\d]+)/);
              if (deorbitMatch) {
                const newPe = parseInt(deorbitMatch[1]);
                logger.progress(`[Landing] Deorbit complete (Pe: ${fmtDist(newPe)})`);
              } else {
                logger.warn('[Landing] Deorbit burn may not have completed correctly');
              }
            }

            // Ensure controls are fully unlocked before MechJeb takes over
            await conn.raw('UNLOCK STEERING. UNLOCK THROTTLE. SAS OFF. WAIT 0.5.', 5000);

            // Mark that we've handled the high-altitude reentry sequence
            // Separation deferred to onPoll - fires when MechJeb status shows "Coasting toward deceleration burn"
            deferSeparation = true;
            highAltAtmHeight = atmHeight;

            // Check if this is Kerbin - if so, target KSC
            const bodyCheck = await conn.queue('PRINT SHIP:BODY:NAME.', 2000);
            const currentBody = bodyCheck.output.trim().split('\n').pop()?.trim().toLowerCase() ?? '';
            if (currentBody === 'kerbin') {
              overrideTarget = 'KSC';
            }
            // For other atmospheric bodies, let the normal target resolution handle it
          }
        }
      }

      if (isHyperbolic) {
        if (periapsis >= SAFE_PERIAPSIS_M) {
          // Hyperbolic with safe periapsis - circularize first
          logger.progress(`[Landing] Hyperbolic approach detected (ecc=${eccentricity.toFixed(2)}, Pe=${fmtDist(periapsis)})`);
          logger.progress(`[Landing] Planning circularization at periapsis...`);

          const circResult = await circularize(conn, 'PERIAPSIS');
          if (!circResult.success) {
            return ctx.errorResponse('land',
              `Cannot circularize before landing: ${circResult.error}\n` +
              `Manual intervention required - use crash_avoidance if periapsis is unsafe.`);
          }

          // Execute the circularization node
          logger.progress(`[Landing] Executing circularization burn: (${circResult.deltaV != null ? fmtVel(circResult.deltaV) : '?'})...`);
          const { executeNode } = await import('../execute-node.js');
          const execResult = await executeNode(conn, { timeoutMs: 300_000, logger, callerTool: 'land' });
          if (!execResult.success) {
            return ctx.errorResponse('land',
              `Circularization burn failed: ${execResult.error}\n` +
              `Orbit may be unstable - check status before retrying.`);
          }

          logger.progress(`[Landing] Orbit circularized. Proceeding with landing...`);
        } else {
          // Hyperbolic with low periapsis - dangerous impact approach
          logger.progress(`[Landing] ⚠️ DANGEROUS: Hyperbolic impact trajectory!`);
          logger.progress(`[Landing] Periapsis ${fmtDist(periapsis)} is too low to circularize safely.`);
          logger.progress(`[Landing] Proceeding with direct landing (high risk)...`);
          // Continue with landing - MechJeb will handle the descent
        }
      } else if (isImpactTrajectory) {
        // Suborbital/impact trajectory (periapsis below surface)
        // High-altitude reentry detection already handled in Step 0.6 above
        if (!deferSeparation) {
          logger.progress(`[Landing] Impact trajectory detected (Pe=${fmtDist(periapsis)})`);
        }
        // Continue with landing
      } else {
        // Stable orbit - normal landing (message deferred until after orbit adjustments)
      }

      // Step 0.7: Lower orbit if too high for efficient landing
      // Ideal landing orbit: 50km for vacuum bodies, 50km above atmosphere for atmospheric bodies
      // Skip if we already have a reentry trajectory (deferSeparation set in Step 0.6)
      if (!isHyperbolic && !isImpactTrajectory && !deferSeparation) {
        const bodyInfo = await conn.queue(
          'IF SHIP:BODY:ATM:EXISTS { PRINT SHIP:BODY:ATM:HEIGHT + "|" + SHIP:BODY:NAME. } ELSE { PRINT "0|" + SHIP:BODY:NAME. }',
          3000
        );
        const bodyMatch = bodyInfo.output.match(/(\d+)\|/);
        const atmHeight = bodyMatch ? Number.parseInt(bodyMatch[1]) : 0;

        // Calculate ideal landing orbit altitude
        const IDEAL_LANDING_ALT = 50_000; // 50km base
        const idealOrbitAlt = atmHeight > 0 ? atmHeight + IDEAL_LANDING_ALT : IDEAL_LANDING_ALT;

        // Get current orbit
        const orbitInfo = await ctx.getBasicOrbitInfo(conn);
        const currentPe = orbitInfo?.periapsis ?? 0;

        // Consider orbit "too high" if periapsis is more than 500km above ideal
        const TOO_HIGH_MARGIN = 500_000; // 500km margin
        const isTooHigh = currentPe > idealOrbitAlt + TOO_HIGH_MARGIN;

        if (isTooHigh) {
          logger.progress(`[Landing] Orbit too high for efficient landing. Lowering from (${fmtDist(currentPe)}) to ${fmtDist(idealOrbitAlt)} `);

          const orchestrator = new ManeuverOrchestrator(conn);

          // Lower periapsis first (burn at apoapsis)
          const peResult = await orchestrator.adjustPeriapsis(idealOrbitAlt, 'APOAPSIS', {
            execute: true, logger, callerTool: 'land',
          });
          if (!peResult.success) {
            return ctx.errorResponse('land', `Failed to lower orbit: ${peResult.error}`);
          }

          // Lower apoapsis (burn at periapsis) for more circular orbit
          const apResult = await orchestrator.adjustApoapsis(idealOrbitAlt, 'PERIAPSIS', {
            execute: true, logger, callerTool: 'land',
          });
          if (!apResult.success) {
            // Non-fatal - we can land from elliptical orbit
            logger.info(`[Landing] Could not circularize, proceeding with elliptical orbit`);
          }

          // Cleanup after orbit lowering: stop warp and unlock controls
          // MechJeb node executor may have left warp or steering engaged
          // Wrapped in try/catch to prevent stalls if connection died during warp
          try {
            await conn.raw('SET WARP TO 0. UNLOCK STEERING. UNLOCK THROTTLE. WAIT 0.5.', 5000);
          } catch {
            logger.warn('[Landing] Cleanup command failed, continuing...');
          }
        }

        // Now in stable landing orbit
        logger.progress('[Landing] Stable orbit confirmed');
      }

      // Step 0.8: Ensure radio contact before jettison and TWR calibration
      // These operations require radio - warp to contact if in blackout
      const preJettisonRadio = await warpToRadioContact(conn, { logger, context: 'Pre-jettison' });
      if (!preJettisonRadio.success && preJettisonRadio.error?.includes('Permanent')) {
        return ctx.errorResponse('land', `Cannot land: ${preJettisonRadio.error}`);
      }

      // Check if body has atmosphere - affects separation logic
      let hasAtmosphere = false;
      try {
        const atmCheck = await conn.queue('PRINT SHIP:BODY:ATM:EXISTS.', 2000);
        hasAtmosphere = atmCheck.output.includes('True');
      } catch { /* assume no atmosphere */ }

      // Check for tidally locked body — landing may result in permanent radio blackout
      try {
        const tidalCheck = await conn.queue(
          'SET _sb TO SHIP:BODY. ' +
          'PRINT ABS(_sb:ROTATIONPERIOD - _sb:ORBIT:PERIOD) / _sb:ORBIT:PERIOD.',
          3000
        );
        const tidalRatio = parseFloat(tidalCheck.output.match(/[\d.eE+-]+/)?.[0] || '1');
        if (tidalRatio < 0.001) {
          logger.progress('[Landing] WARNING: Landing on a tidally locked moon — if you land on the far side, you will have PERMANENT radio blackout!');
        }
      } catch { /* non-fatal */ }

      // Step 0.8b: Scan vessel structure for landing legs and separation stages
      const vesselScan = await scanVesselForLanding(conn, hasAtmosphere);

      if (vesselScan.error) {
        return ctx.errorResponse('land', `Vessel scan failed: ${vesselScan.error}`);
      }

      if (!vesselScan.hasLandingLegs) {
        return ctx.errorResponse('land',
          'No landing legs detected! Cannot land safely without landing legs.\n' +
          'Vessel must have parts with ModuleLandingLeg, ModuleWheelDeployment, or ModuleWheelBase.');
      }

      // Choose separation method based on vessel tags:
      // - 'reentry' tag (atmospheric): stage-based separation before reentry
      // - 'brake' + 'lander' tags (airless 3-stage): tag-based two-stage separation
      //   1. 'brake' decoupler activates before braking burn (drop transfer stage)
      //   2. 'lander' decoupler activates at final descent (drop brake stage)
      // - 'lander2' tag (airless 2-stage): tag-based separation after deorbit burn
      // - No tags: no separation (single-stage lander)
      //
      // Tag-based activation fires ONLY the specific decoupler, not the entire stage.
      // ALL separation is deferred to onPoll - ensures MechJeb course correction completes first.
      let separationStage: number | null = null;
      let primaryTag: string | undefined;
      let secondaryTag: string | undefined;

      if (hasAtmosphere && vesselScan.reentryStage !== null) {
        // Atmospheric with 'reentry' tagged decoupler: stage-based separation
        separationStage = vesselScan.reentryStage;
        logger.progress(`[Landing] Separation deferred to descent phase (stage ${separationStage})`);
      } else if (vesselScan.hasBrakeTag && vesselScan.hasLanderTag) {
        // Airless 3-stage: tag-based two-stage separation
        primaryTag = 'brake';
        secondaryTag = 'lander';
        logger.progress(`[Landing] 3-stage design detected: brake→lander separation (tag-based)`);
      } else if (vesselScan.hasLander2Tag) {
        // Airless 2-stage with post-deorbit timing: no brake, just lander2 after deorbit burn
        secondaryTag = 'lander2';
        logger.progress(`[Landing] 2-stage design detected: lander2 separation after deorbit burn`);
      }
      // Note: No immediate separation - all separation handled in monitorLanding onPoll

      // Step 0.9: Check TWR and limit thrust if too high for landing
      // This prevents the "floating up" problem on low-gravity bodies with overpowered engines
      const thrustLimit = await limitThrustForLanding(conn, logger);

      // Step 1: Resolve landing target
      const rawTargetArg = args.target as string | 'auto';
      const targetArg = rawTargetArg === 'auto' ? 'auto' : await resolveTargetName(conn, rawTargetArg);
      const latitude = args.latitude as number | undefined;
      const longitude = args.longitude as number | undefined;

      // Named presets that can be used as target values
      const PRESETS: Record<string, { lat: number; lng: number }> = {
        'KSC': { lat: -0.0972, lng: -74.5577 },
      };

      // Track resolved coordinates for deorbit burn logic
      let targetLat: number | undefined;
      let targetLng: number | undefined;

      // Check if target is 'auto' or the current SOI body - if so, use auto-land
      // overrideTarget takes precedence (set by high-altitude reentry sequence)
      let effectiveTarget: string | undefined = overrideTarget ?? (targetArg === 'auto' ? undefined : targetArg);
      if (effectiveTarget) {
        const bodyCheck = await conn.queue('PRINT SHIP:BODY:NAME.', 2000);
        const currentBody = bodyCheck.output.trim().split('\n').pop()?.trim() ?? '';
        if (effectiveTarget.toLowerCase() === currentBody.toLowerCase()) {
          logger.info(`[Landing] Target "${effectiveTarget}" is current SOI body, using auto-land`);
          effectiveTarget = undefined;
        }
      }

      // Check if effectiveTarget is a preset (like KSC) before trying vessel lookup
      if (effectiveTarget && PRESETS[effectiveTarget.toUpperCase()]) {
        const preset = PRESETS[effectiveTarget.toUpperCase()];
        targetLat = preset.lat;
        targetLng = preset.lng;
        logger.progress(`[Landing] Using preset "${effectiveTarget}" at ${targetLat.toFixed(2)}°, ${targetLng.toFixed(2)}°`);
        const targetResult = await setLandingPositionTarget(conn, targetLat, targetLng);
        if (!targetResult.success) {
          return ctx.errorResponse('land', targetResult.error ?? 'Failed to set position target');
        }
        effectiveTarget = undefined; // Clear so we don't try vessel lookup
      }

      if (effectiveTarget) {
        // Check if target matches a preset name first
        const presetKey = Object.keys(PRESETS).find(k => k.toLowerCase() === effectiveTarget.toLowerCase());
        if (presetKey) {
          const preset = PRESETS[presetKey];
          logger.progress(`[Landing] Setting target: ${presetKey}`);
          const targetResult = await setLandingPositionTarget(conn, preset.lat, preset.lng);
          if (!targetResult.success) {
            return ctx.errorResponse('land', targetResult.error ?? `Failed to set ${presetKey} target`);
          }
          targetLat = preset.lat;
          targetLng = preset.lng;
        } else {
          // Target is a vessel name - find in target list, set KSP target, validate
          // Note: EXISTS(VESSEL("name")) doesn't work in kOS — use LIST TARGETS instead
          const vesselResult = await conn.queue(
            `SET FOUND TO FALSE. ` +
            `LIST TARGETS IN TL. FOR TG IN TL { ` +
            `  IF TG:NAME = "${effectiveTarget}" AND TG:ISTYPE("Vessel") { ` +
            `    IF TG:STATUS = "LANDED" OR TG:STATUS = "SPLASHED" { ` +
            `      IF TG:BODY:NAME = SHIP:BODY:NAME { ` +
            `        SET TARGET TO TG. SET FOUND TO TRUE. PRINT "OK". ` +
            `      } ELSE { PRINT "WRONGBODY|" + TG:BODY:NAME. } ` +
            `    } ELSE { PRINT "NOTLANDED|" + TG:STATUS. } ` +
            `  } ` +
            `} IF NOT FOUND AND NOT HASTARGET { PRINT "NOTFOUND". }`,
            8000
          );

          if (vesselResult.output.includes('OK')) {
            logger.progress(`[Landing] Target set to vessel "${effectiveTarget}"`);
            // Fall through — getValidLandingTarget will pick up the landed vessel target
            const existingTarget = await getValidLandingTarget(conn);
            if (existingTarget.valid) {
              targetLat = existingTarget.latitude;
              targetLng = existingTarget.longitude;
              const targetResult = await setLandingPositionTarget(conn, targetLat!, targetLng!);
              if (!targetResult.success) {
                return ctx.errorResponse('land', targetResult.error ?? 'Failed to set position target');
              }
              logger.progress(`[Landing] Target vessel at ${targetLat!.toFixed(2)}°, ${targetLng!.toFixed(2)}°`);
            } else {
              return ctx.errorResponse('land', `Vessel "${effectiveTarget}" targeted but could not read coordinates`);
            }
          } else if (vesselResult.output.includes('WRONGBODY')) {
            const bodyMatch = vesselResult.output.match(/WRONGBODY\|(\w+)/);
            return ctx.errorResponse('land', `Vessel "${effectiveTarget}" is on ${bodyMatch?.[1] ?? 'different body'}, not current SOI`);
          } else if (vesselResult.output.includes('NOTLANDED')) {
            const statusMatch = vesselResult.output.match(/NOTLANDED\|(\w+)/);
            return ctx.errorResponse('land', `Vessel "${effectiveTarget}" is not landed (status: ${statusMatch?.[1] ?? 'unknown'})`);
          } else {
            return ctx.errorResponse('land', `Vessel "${effectiveTarget}" not found`);
          }
        }
      } else if (latitude !== undefined && longitude !== undefined) {
        logger.progress(`[Landing] Setting target: ${latitude.toFixed(2)}°, ${longitude.toFixed(2)}°`);
        const targetResult = await setLandingPositionTarget(conn, latitude, longitude);
        if (!targetResult.success) {
          return ctx.errorResponse('land', targetResult.error ?? 'Failed to set position target');
        }
        targetLat = latitude;
        targetLng = longitude;
      } else {
        // No explicit target - check existing target first, then auto-find
        const existingTarget = await getValidLandingTarget(conn);
        if (existingTarget.valid) {
          logger.progress(`[Landing] Using existing target: ${existingTarget.name}`);
          const targetResult = await setLandingPositionTarget(conn, existingTarget.latitude!, existingTarget.longitude!);
          if (targetResult.success) {
            targetLat = existingTarget.latitude;
            targetLng = existingTarget.longitude;
          } else {
            logger.info('[Landing] Failed to set existing target, falling back to auto-find');
          }
        }

        // Fall back to auto-find if no existing target or it failed
        if (targetLat === undefined) {
          logger.progress('[Landing] Finding optimal landing site...');
          const siteResult = await findLandingSite(conn);
          if (siteResult.found && siteResult.latitude !== undefined && siteResult.longitude !== undefined) {
            targetLat = siteResult.latitude;
            targetLng = siteResult.longitude;
            const targetResult = await setLandingPositionTarget(conn, targetLat, targetLng);
            if (targetResult.success) {
              const elevStr = siteResult.altitude !== undefined ? fmtDist(siteResult.altitude) : '?';
              logger.progress(`[Landing] Site selected: ${elevStr} elevation at ${targetLat.toFixed(2)}° by ${targetLng.toFixed(2)}°`);
              if (siteResult.relaxedRequirements) {
                logger.info(`[Landing] Note: ${siteResult.relaxedRequirements}`);
              }
            } else {
              logger.info('[Landing] Found site but failed to set target, will land at current trajectory');
            }
          } else {
            logger.info('[Landing] No optimal site found, will land at current trajectory');
          }
        }
      }

      // Step 2: Apply configuration if provided (optional)
      const config: Partial<LandingConfig> = {};
      if (args.touchdownSpeed !== undefined) config.touchdownSpeed = args.touchdownSpeed as number;
      if (args.deployGears !== undefined) config.deployGears = args.deployGears as boolean;
      if (args.deployChutes !== undefined) config.deployChutes = args.deployChutes as boolean;
      if (args.useRCS !== undefined) config.useRCS = args.useRCS as boolean;

      if (Object.keys(config).length > 0) {
        logger.info('[Landing] Applying configuration...');
        await setLandingConfig(conn, config);
      }

      // Step 4: Start landing
      // Check if we have a position target (either just set or previously set)
      const hasTarget = await hasLandingPositionTarget(conn);

      // Set operation state in kOS RIGHT BEFORE starting (persists across restarts, auto-cleared by safety monitor)
      const targetStr = targetLat !== undefined && targetLng !== undefined
        ? `${targetLat.toFixed(2)},${targetLng.toFixed(2)}`
        : '';
      await setKosOperation(conn, 'landing', 'land', targetStr);

      let landResult: { success: boolean; error?: string };
      if (hasTarget) {
        logger.progress('[Landing] Starting targeted landing...');
        landResult = await startTargetedLanding(conn);
      } else {
        logger.progress('[Landing] Starting untargeted landing...');
        landResult = await startUntargetedLanding(conn);
      }

      if (!landResult.success) {
        await clearKosOperation(conn);
        return ctx.errorResponse('land', landResult.error ?? 'Failed to start landing');
      }

      // Get status after starting
      const status = await getLandingStatus(conn);
      logger.progress(`[Landing] ${status.status}`);

      // Set up staging trigger for multi-stage landing
      await conn.queue(
        'WHEN STAGE:DELTAV:CURRENT < 1 THEN { STAGE. PRINT "Auto-staged during landing". }',
        3000
      );

      // Set up WHEN trigger for lander separation (3-stage airless designs only)
      // This fires automatically when deorbit burn ends, before braking burn starts
      if (secondaryTag && !hasAtmosphere) {
        logger.progress(`[Landing] Setting up lander separation trigger...`);
        const triggerScript = `
          SET _wasDeorbit TO FALSE.
          WHEN TRUE THEN {
            LOCAL stat IS ADDONS:MJ:LANDING:STATUS.
            IF (stat:CONTAINS("Doing") OR stat:CONTAINS("Executing")) AND stat:CONTAINS("deorbit") {
              SET _wasDeorbit TO TRUE.
            } ELSE IF _wasDeorbit {
              SET WARP TO 0. WAIT 0.5.
              RCS ON.
              SET SHIP:CONTROL:FORE TO 1.
              SET _firedLander TO 0.
              FOR p IN SHIP:PARTSTAGGED("${secondaryTag}") {
                IF p:HASMODULE("ModuleDecouple") {
                  LOCAL m IS p:GETMODULE("ModuleDecouple").
                  IF m:HASEVENT("Decouple") { m:DOEVENT("Decouple"). SET _firedLander TO _firedLander + 1. }
                } ELSE IF p:HASMODULE("ModuleAnchoredDecoupler") {
                  LOCAL m IS p:GETMODULE("ModuleAnchoredDecoupler").
                  IF m:HASEVENT("Decouple") { m:DOEVENT("Decouple"). SET _firedLander TO _firedLander + 1. }
                } ELSE IF p:HASMODULE("ModuleDockingNode") {
                  LOCAL m IS p:GETMODULE("ModuleDockingNode").
                  IF m:HASEVENT("Undock") { m:DOEVENT("Undock"). SET _firedLander TO _firedLander + 1. }
                  ELSE IF m:HASEVENT("UndockSameVessel") { m:DOEVENT("UndockSameVessel"). SET _firedLander TO _firedLander + 1. }
                  ELSE IF m:HASEVENT("Decouple") { m:DOEVENT("Decouple"). SET _firedLander TO _firedLander + 1. }
                }
                WAIT 0.
              }
              IF _firedLander > 0 { WAIT 0.5. STAGE. }
              WAIT 5.
              SET SHIP:CONTROL:FORE TO 0.
              RCS OFF.
              WAIT 3.
              SET WARP TO 1.
              RETURN FALSE.
            }
            PRESERVE.
          }
        `.trim().replaceAll('\n', ' ');
        try {
          await conn.queue(triggerScript, 5000);
          logger.progress(`[Landing] Lander separation trigger armed`);
        } catch (e) {
          logger.warn(`[Landing] Failed to set up lander trigger: ${e}`);
        }
      }

      // Set up WHEN trigger for post-landing stabilization
      // This fires when SHIP:STATUS becomes "LANDED" and enables SAS radial-out + RCS
      // to prevent the lander from tipping over after touchdown
      {
        const stabilizeTrigger = `
          WHEN SHIP:STATUS = "LANDED" OR SHIP:STATUS = "SPLASHED" THEN {
            SAS ON.
            RCS ON.
            SET SASMODE TO "RADIALOUT".
            WAIT 10.
            SET SASMODE TO "STABILITYASSIST".
            RCS OFF.
            IF NOT HOMECONNECTION:ISCONNECTED {
              PRINT "Landed in blackout - warping to radio contact".
              SET _MCP_LAND_WARP TO 0.
              SET _MCP_WARP_DT TO SHIP:BODY:ROTATIONPERIOD / 4.
              UNTIL HOMECONNECTION:ISCONNECTED OR _MCP_LAND_WARP > 20 {
                SET _MCP_LAND_WARP TO _MCP_LAND_WARP + 1.
                PRINT "Warp " + _MCP_LAND_WARP + " - no radio (" + ROUND(_MCP_WARP_DT) + "s jump)".
                KUNIVERSE:TIMEWARP:WARPTO(TIME:SECONDS + _MCP_WARP_DT).
                WAIT UNTIL KUNIVERSE:TIMEWARP:WARP = 0.
                WAIT 15.
              }
              IF HOMECONNECTION:ISCONNECTED { PRINT "Radio contact restored!". }
            }
            RETURN FALSE.
          }
        `.trim().replaceAll('\n', ' ');
        try {
          await conn.queue(stabilizeTrigger, 5000);
          logger.progress(`[Landing] SAS out of detent`);
        } catch (e) {
          logger.warn(`[Landing] Failed to arm attitude hold: ${e}`);
        }
      }

      // If wait=true, monitor until completion
      if (wait) {
        // Always pass separation config if we have a stage or tag - separation is deferred to onPoll
        // for ALL landings now (ensures course correction happens before separation)
        const hasSeparation = separationStage !== null || primaryTag !== undefined;
        const deferredSepConfig = hasSeparation ? {
          // Tag-based separation for 3-stage designs
          primaryTag,
          primaryThenStage: true,  // Stage once after decouple to activate engines
          secondaryTag,
          secondaryThenStage: true,  // Stage once after decouple to activate engines
          // Stage-based separation for 2-stage and atmospheric designs
          stage: separationStage ?? undefined,
          // Fallback altitude: atmosphere height + 20km for atmospheric bodies,
          // or 50km for airless bodies (well before braking burn)
          fallbackAltitude: hasAtmosphere ? (highAltAtmHeight || 70_000) + 20_000 : 50_000,
          hasAtmosphere,
        } : undefined;

        const monitorResult = await monitorLanding(conn, {
          logger,
          deferredSeparation: deferredSepConfig,
        });

        // If blackout occurred during monitoring, reconnect and check vessel state
        // The kOS WHEN trigger handles warp-to-radio autonomously after landing
        if (monitorResult.hadBlackout) {
          logger.progress('[Landing] Reconnecting after blackout...');
          try {
            await forceDisconnect();
            conn = await ensureConnected();
            logger.progress('[Landing] Reconnected after blackout');

            const statusCheck = await conn.queue('PRINT SHIP:STATUS.', 3000);
            const isLanded = statusCheck.output.includes('LANDED') || statusCheck.output.includes('SPLASHED');
            if (isLanded) {
              monitorResult.success = true;
            }
          } catch (err) {
            logger.warn(`[Landing] Reconnect failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        // Warp to radio contact if we landed in blackout
        // (e.g., on far side of a moon — kOS trigger may not have fired yet)
        if (!monitorResult.hadBlackout) {
          const radioResult = await warpToRadioContact(conn, { logger, context: 'Landing' });
          if (!radioResult.success && radioResult.error) {
            logger.warn(`[Landing] ${radioResult.error}`);
          }
        }

        if (monitorResult.success) {
          // Note: Post-landing stabilization (SAS radial-out, RCS, 10s hold) is
          // handled by mcp_landing.ks which runs locally and survives blackout.
          // By the time monitorResult.success is true, stabilization is complete.

          // Reset thrust limits if we modified them
          if (thrustLimit.limited) {
            await resetThrustLimits(conn, logger);
          }

          // Query landing site details for informative response
          let landingDetails = '';
          try {
            const siteInfo = await conn.queue(
              'PRINT SHIP:BODY:NAME + "|" + SHIP:GEOPOSITION:TERRAINHEIGHT.',
              3000
            );
            const siteMatch = siteInfo.output.match(/([^|]+)\|([-\d.]+)/);
            if (siteMatch) {
              const bodyName = siteMatch[1].trim();
              const altitude = Number.parseFloat(siteMatch[2]);
              landingDetails = `\nLocation: ${bodyName} at ${fmtDist(altitude)} elevation`;
            }
          } catch {
            // Ignore errors querying site details
          }

          // Safety monitor should have already cleared _MCP_OP on landing
          return ctx.successResponse('land',
            `Landing complete!${landingDetails}\nVessel safely on surface.`);
        } else {
          // Reset thrust limits if we modified them
          if (thrustLimit.limited) {
            await resetThrustLimits(conn, logger);
          }
          // Clear operation on failure (safety monitor only clears on success)
          await clearKosOperation(conn);
          return ctx.errorResponse('land',
            monitorResult.error ?? `Landing failed: ${monitorResult.finalStatus.status}`);
        }
      }

      // Not waiting - just return initial status
      let message = `Landing started (${hasTarget ? 'targeted' : 'untargeted'})\n`;
      message += status.formatted;

      return ctx.successResponse('land', message);
    } catch (error) {
      // Reset thrust limits and clear operation state on error
      try {
        await resetThrustLimits(conn);
        await clearKosOperation(conn);
      } catch { /* ignore cleanup errors */ }
      clearBroadcastLogger();
      return ctx.errorResponse(
        'land',
        error instanceof Error ? error.message : String(error)
      );
    }
  },
};

// Re-export for library use


export {getLandingStatus, startTargetedLanding, startUntargetedLanding, type LandingStatus} from './shared.js';