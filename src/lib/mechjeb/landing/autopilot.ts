/**
 * Landing Autopilot - Start, stop, and monitor landing
 */

import { z } from 'zod';
import type { ToolDefinition, McpLogger } from '../../tool-types.js';
import { nullLogger, parseTarget } from '../../tool-types.js';
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
import { circularize } from '../basic/circularize.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import { fmtVel, fmtDist } from '../../utils/format.js';

// ============================================================================
// Target Validation
// ============================================================================

/**
 * Check if current KSP target is valid for landing:
 * - Position target (surface coordinates), OR
 * - Landed vessel on same body as ship
 * Returns { valid, lat?, lng?, name? } or { valid: false }
 */
let myBody:string;
async function getValidLandingTarget(conn: KosConnection): Promise<{
  valid: boolean;
  latitude?: number;
  longitude?: number;
  name?: string;
}> {
  // Check for MechJeb position target first
  const mjTarget = await conn.execute(
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
    const shipBody = await conn.execute('PRINT SHIP:BODY:NAME.', 2000);
    myBody = shipBody.output;
    if (shipBody.output.includes(body)) {
      return { valid: true, latitude: lat, longitude: lng, name: `Position ${lat.toFixed(2)}°, ${lng.toFixed(2)}°` };
    }
  }

  // Check for landed vessel target on same body
  const vesselCheck = await conn.execute(
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

  return { valid: false };
}

// ============================================================================
// Vessel Structure Scanning
// ============================================================================

interface VesselScanResult {
  hasLandingLegs: boolean;
  landingLegStage: number | null;  // Lowest stage with legs
  jettisonStage: number | null;    // Decoupler stage to fire (null = none found)
  error?: string;
}

/**
 * Scan vessel structure for landing legs and decouplers.
 * First looks for a part tagged 'lander' (decoupler/separator/docking port),
 * then falls back to finding the highest-staged decoupler.
 */
async function scanVesselForLanding(conn: KosConnection): Promise<VesselScanResult> {
  // Note: p:MODULES returns a list of module NAME STRINGS, not module objects
  // So we compare m directly (e.g., m = "ModuleWheelDeployment"), not m:NAME
  //
  // Landing legs may be at stage -1 (removed from staging) - that's fine, we just
  // need to confirm they exist. Decouplers must be in staging sequence (stage >= 0).
  //
  // Priority for jettison:
  // 1. Part with kOS tag "lander" that can separate (decoupler/separator/docking port)
  // 2. Fallback: highest-staged decoupler
  // kOS script to scan vessel - no // comments allowed (flattened to single line)
  const script = `
    LOCAL hasLegs IS FALSE.
    LOCAL taggedStage IS -1.
    LOCAL decStages IS LIST().
    FOR p IN SHIP:PARTS {
      FOR m IN p:MODULES {
        IF m = "ModuleLandingLeg" OR m = "ModuleWheelDeployment" OR m = "ModuleWheelBase" { SET hasLegs TO TRUE. }
      }
    }
    IF NOT hasLegs { PRINT "NOLEGS". }
    ELSE {
      FOR p IN SHIP:PARTS {
        IF p:TAG = "lander" {
          IF p:HASMODULE("ModuleDecouple") OR p:HASMODULE("ModuleAnchoredDecoupler") OR p:HASMODULE("ModuleDockingNode") {
            IF p:STAGE >= 0 { SET taggedStage TO p:STAGE. }
          }
        }
      }
      IF taggedStage >= 0 { PRINT "LEGS|TAG|" + taggedStage. }
      ELSE {
        FOR p IN SHIP:PARTS {
          IF p:HASMODULE("ModuleDecouple") OR p:HASMODULE("ModuleAnchoredDecoupler") {
            IF p:STAGE >= 0 { IF NOT decStages:CONTAINS(p:STAGE) { decStages:ADD(p:STAGE). } }
          }
        }
        IF decStages:LENGTH = 0 { PRINT "LEGS|NODEC". }
        ELSE {
          LOCAL maxDecStage IS decStages[0].
          FOR s IN decStages { IF s > maxDecStage { SET maxDecStage TO s. } }
          PRINT "LEGS|DEC|" + maxDecStage.
        }
      }
    }
  `.trim().replaceAll('\n', ' ');

  const result = await conn.execute(script, 10_000);
  // kOS output may be all on one line - look for our markers at the END
  const rawOutput = result.output.trim();

  // Parse result - check patterns at END of output string
  if (rawOutput.endsWith('NOLEGS')) {
    return { hasLandingLegs: false, landingLegStage: null, jettisonStage: null };
  }

  if (rawOutput.endsWith('LEGS|NODEC')) {
    return { hasLandingLegs: true, landingLegStage: null, jettisonStage: null };
  }

  // LEGS|TAG|<stage> - tagged "lander" part found
  const tagMatch = rawOutput.match(/LEGS\|TAG\|(\d+)$/);
  if (tagMatch) {
    return { hasLandingLegs: true, landingLegStage: null, jettisonStage: parseInt(tagMatch[1]) };
  }

  // LEGS|DEC|<decStage> - fallback to highest staged decoupler
  const decMatch = rawOutput.match(/LEGS\|DEC\|(\d+)$/);
  if (decMatch) {
    return { hasLandingLegs: true, landingLegStage: null, jettisonStage: parseInt(decMatch[1]) };
  }

  return { hasLandingLegs: false, landingLegStage: null, jettisonStage: null, error: `Failed to parse vessel scan: ${rawOutput.slice(-50)}` };
}

/**
 * Jettison exactly the target decoupler stage.
 * Stages down to reach the target stage if needed, then fires it once.
 * Will not fire past the target stage (prevents dropping multiple stages).
 */
async function jettisonStage(
  conn: KosConnection,
  targetStage: number,
  logger?: McpLogger
): Promise<{ success: boolean; error?: string }> {
  const log = logger ?? nullLogger;

  // Stage down to reach the target decoupler, then fire it exactly once
  // If current stage > target: stage down to reach it, then fire
  // If current stage = target: fire it
  // If current stage < target: already past it, do nothing
  const script = `
    SET startStage TO STAGE:NUMBER.
    SET fired TO FALSE.
    IF STAGE:NUMBER > ${targetStage} {
      UNTIL STAGE:NUMBER <= ${targetStage} {
        STAGE. WAIT 0.5.
      }
    }
    IF STAGE:NUMBER = ${targetStage} {
      STAGE. WAIT 0.5.
      SET fired TO TRUE.
    }
    PRINT "STAGED|" + startStage + "|" + STAGE:NUMBER + "|" + fired.
  `.trim().replaceAll('\n', ' ');

  const result = await conn.execute(script, 30_000);
  const output = result.output.trim();

  const match = output.match(/STAGED\|(\d+)\|(\d+)\|(True|False)/i);
  if (match) {
    const startStage = parseInt(match[1]);
    const endStage = parseInt(match[2]);
    const fired = match[3].toLowerCase() === 'true';
    if (fired) {
      log.info(`[Jettison] Fired stage ${targetStage} (was at ${startStage}, now at ${endStage})`);
    } else {
      log.info(`[Jettison] Already past stage ${targetStage} (current: ${endStage})`);
    }
    return { success: true };
  }

  return { success: false, error: 'Failed to parse staging result' };
}

// Configuration
const DEFAULT_POLL_INTERVAL_MS = 5000; // 5 seconds
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

  // Calculate current TWR and limit if needed
  const script = `
    LOCAL totalThrust IS 0.
    LOCAL activeEngines IS 0.
    FOR eng IN SHIP:ENGINES {
      IF eng:IGNITION AND eng:AVAILABLETHRUST > 0 {
        SET totalThrust TO totalThrust + eng:AVAILABLETHRUST.
        SET activeEngines TO activeEngines + 1.
      }
    }
    LOCAL g IS SHIP:BODY:MU / (SHIP:BODY:RADIUS + SHIP:ALTITUDE)^2.
    LOCAL weight IS SHIP:MASS * g.
    LOCAL twr IS CHOOSE 0 IF weight = 0 ELSE totalThrust / weight.
    PRINT "TWR|" + ROUND(twr, 2) + "|" + ROUND(totalThrust) + "|" + ROUND(weight) + "|" + activeEngines.
  `.trim().replaceAll('\n', ' ');

  const result = await conn.execute(script, 5000);
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
    log.info(`[Landing] TWR ${twr.toFixed(1)} is acceptable for landing`);
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

  await conn.execute(limitScript, 5000);

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

  await conn.execute(script, 5000);
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
  } = {}
): Promise<{ success: boolean; finalStatus: LandingStatus; error?: string }> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    logger,
  } = options;

  const log = logger ?? nullLogger;
  let lastStatusText = '';
  let lastLoggedSpeed = 0;
  let lastLoggedAlt = 0;
  let descentLogCount = 0;
  let consecutiveDisabledCount = 0;

  // Check atmosphere once at start - physics warp only on vacuum bodies
  let hasAtmosphere = false;
  try {
    const atmCheck = await conn.execute('PRINT SHIP:BODY:ATM:EXISTS.', 2000);
    hasAtmosphere = atmCheck.output.includes('True');
  } catch { /* assume no atmosphere */ }

  // Track braking progress for progressive warp
  let initialBrakingSpeed = 0;
  let currentWarpLevel = 0;

  const result = await pollWithBlackoutResilience<LandingPollState>({
    poll: async () => {
      const status = await getLandingStatus(conn);

      // Check if landing completed (autopilot disabled itself)
      let isLanded = false;
      let wasAborted = false;

      if (!status.enabled) {
        // Track consecutive disabled readings to avoid false positives
        // during blackout recovery or warp transitions
        consecutiveDisabledCount++;

        const groundCheck = await conn.execute('PRINT SHIP:STATUS.', 3000);
        isLanded = groundCheck.output.includes('LANDED') || groundCheck.output.includes('SPLASHED');

        // Only declare abort after multiple consecutive disabled readings
        // Landing detection is immediate (no need to wait)
        wasAborted = !isLanded && consecutiveDisabledCount >= ABORT_CONFIRMATION_COUNT;

        if (!isLanded && consecutiveDisabledCount < ABORT_CONFIRMATION_COUNT) {
          log.progress(`[Landing] Autopilot disabled - confirming (${consecutiveDisabledCount}/${ABORT_CONFIRMATION_COUNT})...`);
        }
      } else {
        // Reset counter when autopilot is enabled
        consecutiveDisabledCount = 0;
      }

      return { status, isLanded, wasAborted };
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

      // Parse braking speed from status like "Braking: target speed = 155 m/s"
      const brakingMatch = rawStatus.match(/Braking.*?(\d+)/);
      if (brakingMatch) {
        const speed = parseInt(brakingMatch[1]);

        // Track initial braking speed for progress calculation
        if (initialBrakingSpeed === 0 && speed > 0) {
          initialBrakingSpeed = speed;
        }

        // Only log every 30 m/s change to reduce verbosity
        if (lastLoggedSpeed === 0 || lastLoggedSpeed - speed >= 30) {
          log.progress(`[Landing] Braking: ${speed}_m/sec`);
          lastLoggedSpeed = speed;
        }

        // Progressive physics warp - only on bodies WITHOUT atmosphere
        if (!hasAtmosphere && initialBrakingSpeed > 0) {
          // Calculate progress: 0 = just started, 1 = done
          const progress = 1 - (speed / initialBrakingSpeed);
          let targetWarp: number;
          if (progress < 0.5) {
            // First half: ramp up (0->0.5 maps to warp 0->3)
            targetWarp = Math.min(3, Math.floor(progress * 6));
          } else {
            // Second half: ramp down (0.5->1.0 maps to warp 3->0)
            targetWarp = Math.max(0, Math.floor((1 - progress) * 6));
          }
          if (targetWarp !== currentWarpLevel) {
            try {
              await conn.execute(`SET WARPMODE TO "PHYSICS". SET WARP TO ${targetWarp}.`);
              currentWarpLevel = targetWarp;
            } catch { /* ignore */ }
          }
        }
        return;
      }

      // Parse final descent altitude from status like "Final descent: 200m above terrain"
      const descentMatch = rawStatus.match(/Final descent.*?(\d+)/);
      if (descentMatch) {
        const alt = parseInt(descentMatch[1]);
        // Reduce warp when getting close, only log at key altitudes
        if (alt < 100 && currentWarpLevel > 0) {
          try {
            await conn.execute('SET WARP TO 0.');
            currentWarpLevel = 0;
          } catch { /* ignore */ }
        }
        // Only log every 50m change or at key altitudes
        if (lastLoggedAlt === 0 || lastLoggedAlt - alt >= 50 || alt <= 20) {
          descentLogCount++;
          // Every other log, include descent rate
          if (descentLogCount % 2 === 0) {
            try {
              const vsResult = await conn.execute('PRINT ROUND(-SHIP:VERTICALSPEED, 1).', 2000);
              const vs = parseFloat(vsResult.output.match(/([\d.]+)/)?.[1] ?? '0');
              log.progress(`[Landing] Final descent: ${alt}m, down at ${Math.round(vs)}_m/sec`);
            } catch {
              log.progress(`[Landing] Final descent: ${alt}m`);
            }
          } else {
            log.progress(`[Landing] Final descent: ${alt}m`);
          }
          lastLoggedAlt = alt;
        }
        return;
      }

      // Stop warp when status changes to something other than braking/descent
      if (lastLoggedSpeed > 0 || lastLoggedAlt > 0) {
        // Ensure warp is fully stopped before switching back to RAILS
        try {
          await conn.execute('SET WARP TO 0.');
          await conn.execute('SET WARPMODE TO "RAILS".');
          currentWarpLevel = 0;
        } catch { /* ignore */ }
        lastLoggedSpeed = 0;
        lastLoggedAlt = 0;
        initialBrakingSpeed = 0; // Reset for next braking phase
      }

      // Log other status changes (not braking/descent)
      if (rawStatus !== lastStatusText) {
        lastStatusText = rawStatus;

        // Map raw status to cleaner messages
        let statusText: string | undefined;
        if (/Coasting toward deceleration/.test(rawStatus)) {
          statusText = 'Coasting toward deceleration burn';
        } else if (/Warping to start of braking burn/.test(rawStatus)) {
          // Silent - warp in progress
        } else if (rawStatus === 'Off') {
          statusText = 'Contact light, [[pbas 35]]Engine Shutdown, [[pbas 55]]Descent engine command override off.';
        } else if (/course correction/i.test(rawStatus)) {
          // Filter out "0 m/s" corrections
          const dvMatch = rawStatus.match(/(\d+)/);
          if (dvMatch && parseInt(dvMatch[1]) > 0) {
            statusText = rawStatus;
          }
        } else {
          statusText = rawStatus;
        }

        if (statusText) {
          log.progress(`[Landing] ${statusText}`);
        }
      }

      // Log touchdown
      if (state.isLanded) {
        log.progress('[Landing] Touchdown! Landing complete.');
      }
    },
  });

  if (result.timedOut && !result.result?.isLanded) {
    return {
      success: false,
      finalStatus: result.result?.status ?? { enabled: false, status: 'Unknown', landingAtTarget: false, predictionReady: false, formatted: '' },
      error: `Landing timeout after ${Math.round(timeoutMs / 60_000)} minutes`,
    };
  }

  if (result.result?.wasAborted) {
    return {
      success: false,
      finalStatus: result.result.status,
      error: 'Landing autopilot stopped before touchdown',
    };
  }

  return {
    success: result.success,
    finalStatus: result.result?.status ?? { enabled: false, status: 'Complete', landingAtTarget: false, predictionReady: false, formatted: '' },
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
    const conn = await ctx.ensureConnected();
    // Resolve 'auto' to client-appropriate default
    const waitArg = args.wait as boolean | 'auto';
    const wait = waitArg === 'auto' ? ctx.supportsNotifications(extra) : waitArg;

    const logger = ctx.createLogger(extra);

    // Validate vessel state BEFORE setting operation state
    // Step 0: Validate vessel state - must be in orbit or flying
    const statusCheck = await conn.execute('PRINT SHIP:STATUS.', 2000);
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
      const stateInfo = await getVesselStateInfo(conn);
      const { eccentricity, periapsis } = stateInfo;

      // Determine orbit type
      const isHyperbolic = eccentricity >= 1;
      const isImpactTrajectory = periapsis < 0;
      const SAFE_PERIAPSIS_M = 15_000; // 15km minimum for safe circularization

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
          const execResult = await executeNode(conn, { timeoutMs: 300_000 });
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
        // Suborbital/impact - warn but proceed
        logger.progress(`[Landing] ⚠️ WARNING: Impact trajectory detected (Pe=${fmtDist(periapsis)})`);
        logger.progress(`[Landing] Landing without circularization - this is risky!`);
        // Continue with landing
      } else {
        // Stable orbit - normal landing (message deferred until after orbit adjustments)
      }

      // Step 0.7: Lower orbit if too high for efficient landing
      // Ideal landing orbit: 50km for vacuum bodies, 50km above atmosphere for atmospheric bodies
      if (!isHyperbolic && !isImpactTrajectory) {
        const bodyInfo = await conn.execute(
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

        // Consider orbit "too high" if periapsis is more than 20km above ideal
        const TOO_HIGH_MARGIN = 20_000; // 20km margin
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
            await conn.execute('SET WARP TO 0. UNLOCK STEERING. UNLOCK THROTTLE. WAIT 0.5.', 5000);
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

      // Step 0.8b: Scan vessel structure for landing legs and jettison transfer stage
      const vesselScan = await scanVesselForLanding(conn);

      if (vesselScan.error) {
        return ctx.errorResponse('land', `Vessel scan failed: ${vesselScan.error}`);
      }

      if (!vesselScan.hasLandingLegs) {
        return ctx.errorResponse('land',
          'No landing legs detected! Cannot land safely without landing legs.\n' +
          'Vessel must have parts with ModuleLandingLeg, ModuleWheelDeployment, or ModuleWheelBase.');
      }

      // Jettison transfer stage below landing legs if decoupler found
      if (vesselScan.jettisonStage !== null) {
        logger.progress('[Landing] Separating lander from transfer stage...');
        const jettisonResult = await jettisonStage(conn, vesselScan.jettisonStage, logger);
        if (!jettisonResult.success) {
          logger.warn(`[Landing] Separation failed: ${jettisonResult.error}, continuing anyway`);
        } else {
          logger.progress('[Landing] Lander separated');
        }
      }

      // Step 0.9: Check TWR and limit thrust if too high for landing
      // This prevents the "floating up" problem on low-gravity bodies with overpowered engines
      const thrustLimit = await limitThrustForLanding(conn, logger);

      // Step 1: Resolve landing target
      const targetArg = args.target as string | 'auto';
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
      let effectiveTarget: string | undefined = targetArg === 'auto' ? undefined : targetArg;
      if (effectiveTarget) {
        const bodyCheck = await conn.execute('PRINT SHIP:BODY:NAME.', 2000);
        const currentBody = bodyCheck.output.trim().split('\n').pop()?.trim() ?? '';
        if (effectiveTarget.toLowerCase() === currentBody.toLowerCase()) {
          logger.info(`[Landing] Target "${effectiveTarget}" is current SOI body, using auto-land`);
          effectiveTarget = undefined;
        }
      }

      if (effectiveTarget) {
        // Target is a vessel name - try to find it and get its position
        const vesselResult = await conn.execute(
          `IF EXISTS(VESSEL("${effectiveTarget}")) { ` +
          `  SET V TO VESSEL("${effectiveTarget}"). ` +
          `  IF V:STATUS = "LANDED" OR V:STATUS = "SPLASHED" { ` +
          `    IF V:BODY:NAME = SHIP:BODY:NAME { ` +
          `      PRINT "OK|" + V:GEOPOSITION:LAT + "|" + V:GEOPOSITION:LNG. ` +
          `    } ELSE { PRINT "WRONGBODY|" + V:BODY:NAME. } ` +
          `  } ELSE { PRINT "NOTLANDED|" + V:STATUS. } ` +
          `} ELSE { PRINT "NOTFOUND". }`,
          5000
        );

        const okMatch = vesselResult.output.match(/OK\|([-\d.]+)\|([-\d.]+)/);
        if (okMatch) {
          targetLat = Number.parseFloat(okMatch[1]);
          targetLng = Number.parseFloat(okMatch[2]);
          logger.progress(`[Landing] Target vessel "${effectiveTarget}" at ${targetLat.toFixed(2)}°, ${targetLng.toFixed(2)}°`);
          const targetResult = await setLandingPositionTarget(conn, targetLat, targetLng);
          if (!targetResult.success) {
            return ctx.errorResponse('land', targetResult.error ?? 'Failed to set position target');
          }
        } else if (vesselResult.output.includes('WRONGBODY')) {
          const bodyMatch = vesselResult.output.match(/WRONGBODY\|(\w+)/);
          return ctx.errorResponse('land', `Vessel "${effectiveTarget}" is on ${bodyMatch?.[1] ?? 'different body'}, not current SOI`);
        } else if (vesselResult.output.includes('NOTLANDED')) {
          const statusMatch = vesselResult.output.match(/NOTLANDED\|(\w+)/);
          return ctx.errorResponse('land', `Vessel "${effectiveTarget}" is not landed (status: ${statusMatch?.[1] ?? 'unknown'})`);
        } else {
          // Vessel not found - check if target matches a preset name
          const presetKey = Object.keys(PRESETS).find(k => k.toLowerCase() === effectiveTarget!.toLowerCase());
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

      // If wait=true, monitor until completion
      if (wait) {
        const monitorResult = await monitorLanding(conn, { logger });

        // Warp to radio contact if we landed in blackout
        // (e.g., on far side of a moon)
        const radioResult = await warpToRadioContact(conn, { logger, context: 'Landing' });
        if (!radioResult.success && radioResult.error) {
          logger.warn(`[Landing] ${radioResult.error}`);
        }

        if (monitorResult.success) {
          // Post-landing stabilization - enable SAS radial-out and RCS
          try {
            logger.progress('[Landing] Stabilizing...');
            await conn.execute('SAS ON. WAIT 0.1. SET SASMODE TO "RADIALOUT". RCS ON.', 5000);
            // Wait 10 seconds then disable RCS and switch SAS to stability assist
            await conn.execute('WAIT 10. RCS OFF. SET SASMODE TO "STABILITYASSIST".', 15_000);
            logger.progress('[Landing] Stabilized');
          } catch {
            logger.warn('[Landing] Stabilization commands failed');
          }

          // Reset thrust limits if we modified them
          if (thrustLimit.limited) {
            await resetThrustLimits(conn, logger);
          }

          // Query landing site details for informative response
          let landingDetails = '';
          try {
            const siteInfo = await conn.execute(
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