/**
 * Landing Autopilot - Start, stop, and monitor landing
 */

import { z } from 'zod';
import type { ToolDefinition, McpLogger } from '../../tool-types.js';
import { nullLogger, parseTarget } from '../../tool-types.js';
import { setActiveOperation, clearActiveOperation } from '../../../utils/operation-state.js';
import { pollWithBlackoutResilience } from '../../../utils/poll-with-resilience.js';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { formatTime } from '../../utils/format.js';
import {
  getLandingStatus,
  setLandingConfig,
  setLandingPositionTarget,
  setLandingPositionTargetKSC,
  hasLandingPositionTarget,
  startTargetedLanding,
  startUntargetedLanding,
  stopLanding,
  type LandingStatus,
  type LandingConfig,
} from './shared.js';
import { findLandingSite } from './find-site.js';

// ============================================================================
// Target Validation
// ============================================================================

/**
 * Check if current KSP target is valid for landing:
 * - Position target (surface coordinates), OR
 * - Landed vessel on same body as ship
 * Returns { valid, lat?, lng?, name? } or { valid: false }
 */
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

// Configuration
const DEFAULT_POLL_INTERVAL_MS = 5000; // 5 seconds
const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 minutes

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
  let lastAltitudeLog = 0;
  let consecutiveDisabledCount = 0;

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

    onPoll: (state) => {
      // Log progress if status changed
      if (state.status.status !== lastStatusText) {
        log.progress(`[Landing] ${state.status.status}`);
        lastStatusText = state.status.status;
      }

      // Log altitude and velocity periodically (every 10 seconds)
      const now = Date.now();
      if (now - lastAltitudeLog >= 10_000 && state.status.enabled) {
        lastAltitudeLog = now;
        logAltitude(conn, state.status, log);
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

async function logAltitude(conn: KosConnection, status: LandingStatus, log: McpLogger): Promise<void> {
  try {
    const telemetry = await conn.execute(
      'PRINT "TEL|" + ROUND(ALTITUDE) + "|" + ROUND(SHIP:VERTICALSPEED).',
      3000
    );
    const match = telemetry.output.match(/TEL\|([-\d]+)\|([-\d]+)/);
    if (match) {
      const altitude = Number.parseInt(match[1]);
      const vSpeed = Number.parseInt(match[2]);
      const altStr = altitude > 1000 ? `${(altitude / 1000).toFixed(1)}km` : `${altitude}m`;
      const eta = status.timeToLanding !== undefined ? ` | E-T-A: ${formatTime(status.timeToLanding)}` : '';
      log.progress(`[Landing] Altitude: ${altStr} | Speed: ${vSpeed} m/sec${eta}`);
    }
  } catch {
    // Ignore errors during altitude logging
  }
}


// ============================================================================
// Tool Definition
// ============================================================================

export const landTool: ToolDefinition = {
  name: 'land',
  description:
    'Land on surface from orbit.',
  inputSchema: {
    action: z.enum(['start', 'abort', 'status'])
      .optional()
      .default('start')
      .describe('start=begin landing (default), abort=cancel, status=check progress'),

    // Target (NEW - first optional param for targeting)
    target: z.preprocess(parseTarget, z.string())
      .optional()
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
    named_preset: z.enum(['KSC'])
      .optional()
      .describe('ADVANCED: Built-in waypoint. Ignored if target specified.'),

    // Config (optional - applied before start)
    touchdownSpeed: z.number()
      .min(0)
      .max(10)
      .optional()
      .describe('Target touchdown velocity in m/s (default ~2)'),
    deployGears: z.boolean()
      .optional()
      .describe('Auto-deploy landing gear'),
    deployChutes: z.boolean()
      .optional()
      .describe('Auto-deploy parachutes'),
    useRCS: z.boolean()
      .optional()
      .describe('Use RCS for fine position adjustments'),

    // Monitoring
    wait: z.boolean()
      .optional()
      .default(true)
      .describe('Wait for landing to complete (default: true).'),
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
    const action = args.action as 'start' | 'abort' | 'status';
    const wait = args.wait as boolean | undefined ?? true;

    // Handle status action first (simplest case) - no operation guard needed
    if (action === 'status') {
      const status = await getLandingStatus(conn);
      return ctx.successResponse('land', status.formatted);
    }

    // Handle abort action - clears active operation
    if (action === 'abort') {
      clearActiveOperation();
      const result = await stopLanding(conn);
      if (result.success) {
        return ctx.successResponse('land', 'Landing aborted. Vessel control returned to manual.');
      } else {
        return ctx.errorResponse('land', result.error ?? 'Failed to abort landing');
      }
    }

    // Handle start action
    setActiveOperation('land', 'Landing in progress');
    const logger = ctx.createLogger(extra);

    try {
      // Step 0: Validate vessel state - must be in orbit or flying
      const statusCheck = await conn.execute('PRINT SHIP:STATUS.', 2000);
      const vesselStatus = statusCheck.output.trim().split('\n').pop()?.trim().toUpperCase() ?? '';

      const validStatuses = ['FLYING', 'ORBITING', 'ESCAPING', 'SUB_ORBITAL'];
      if (!validStatuses.some(s => vesselStatus.includes(s))) {
        clearActiveOperation();

        // Provide detailed error based on status
        let errorDetail = '';
        if (vesselStatus.includes('LANDED') || vesselStatus.includes('SPLASHED')) {
          errorDetail = `Vessel is already ${vesselStatus.toLowerCase()}. Use launch tool to take off first.`;
        } else if (vesselStatus.includes('PRELAUNCH')) {
          errorDetail = 'Vessel is on the launchpad. Use launch tool to reach orbit first.';
        } else if (vesselStatus.includes('DOCKED')) {
          errorDetail = 'Vessel is docked. Undock first, then use land tool.';
        } else {
          errorDetail = `Current status: ${vesselStatus}. Must be in orbit or flying to land.`;
        }

        return ctx.errorResponse('land', `Cannot start landing: ${errorDetail}`);
      }

      // Step 1: Resolve landing target
      const target = args.target as string | undefined;
      const latitude = args.latitude as number | undefined;
      const longitude = args.longitude as number | undefined;
      const namedPreset = args.named_preset as 'KSC' | undefined;

      // Track resolved coordinates for deorbit burn logic
      let targetLat: number | undefined;
      let targetLng: number | undefined;

      // Check if target is the current SOI body - if so, ignore it (use auto-land)
      let effectiveTarget = target;
      if (target) {
        const bodyCheck = await conn.execute('PRINT SHIP:BODY:NAME.', 2000);
        const currentBody = bodyCheck.output.trim().split('\n').pop()?.trim() ?? '';
        if (target.toLowerCase() === currentBody.toLowerCase()) {
          logger.info(`[Landing] Target "${target}" is current SOI body, using auto-land`);
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
          return ctx.errorResponse('land', `Vessel "${effectiveTarget}" not found`);
        }
      } else if (namedPreset === 'KSC') {
        logger.progress('[Landing] Setting target: KSC');
        const targetResult = await setLandingPositionTargetKSC(conn);
        if (!targetResult.success) {
          return ctx.errorResponse('land', targetResult.error ?? 'Failed to set KSC target');
        }
        targetLat = -0.0972;
        targetLng = -74.5577;
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
              logger.progress(`[Landing] Auto-selected: ${targetLat.toFixed(2)}°, ${targetLng.toFixed(2)}°`);
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

      // Step 2: Deorbit burn (only if target is within 1/4 orbit)
      // If target is farther, let MechJeb handle timing

      let skipDeorbitBurn = targetLat === undefined || targetLng === undefined;

      if (!skipDeorbitBurn) {
        // Find when we pass over target, calculate if within 1/4 orbit
        const findBurnTimeScript = `
          SET tgt_lng TO ${targetLng}.
          SET period TO SHIP:ORBIT:PERIOD.
          SET lead_time TO period / 16.
          SET t TO 0.
          SET found_t TO period.
          UNTIL t > period {
            SET pos TO POSITIONAT(SHIP, TIME:SECONDS + t).
            SET geo TO SHIP:BODY:GEOPOSITIONOF(pos).
            SET lng_diff TO ABS(geo:LNG - tgt_lng).
            IF lng_diff > 180 { SET lng_diff TO 360 - lng_diff. }
            IF lng_diff < 5 {
              SET found_t TO t.
              BREAK.
            }
            SET t TO t + 10.
          }
          SET quarter_orbit TO period / 4.
          SET burn_t TO MAX(30, found_t - lead_time).
          PRINT "BURN_T:" + ROUND(burn_t) + "|OVERFLY_T:" + ROUND(found_t) + "|QUARTER:" + ROUND(quarter_orbit).
        `.trim().replaceAll('\n', ' ');

        const burnTimeResult = await conn.execute(findBurnTimeScript, 15_000);
        const burnMatch = burnTimeResult.output.match(/BURN_T:(\d+)\|OVERFLY_T:(\d+)\|QUARTER:(\d+)/);
        const burnT = burnMatch ? parseInt(burnMatch[1]) : 60;
        const overflyT = burnMatch ? parseInt(burnMatch[2]) : 120;
        const quarterOrbit = burnMatch ? parseInt(burnMatch[3]) : 600;

        if (overflyT > quarterOrbit) {
          // Target is more than 1/4 orbit away - let MechJeb handle it
          logger.progress(`[Landing] Target ${Math.round(overflyT / 60)}m away (>${Math.round(quarterOrbit / 60)}m), MechJeb will plan approach`);
          skipDeorbitBurn = true;
        } else {
          logger.progress(`[Landing] Target overfly in ${Math.round(overflyT / 60)}m, burn in ${Math.round(burnT / 60)}m`);
        }

        if (!skipDeorbitBurn) {
          logger.progress('[Landing] Deorbit burn - pointing retrograde...');
          await conn.execute('LOCK STEERING TO RETROGRADE. WAIT 0.1.', 5000);

          // Wait for alignment (within 15 degrees of retrograde - rough is fine for deorbit)
          const alignScript = `
            SET aligned TO FALSE.
            SET timeout TO TIME:SECONDS + 20.
            UNTIL aligned OR TIME:SECONDS > timeout {
              SET ang TO VANG(SHIP:FACING:FOREVECTOR, -SHIP:VELOCITY:ORBIT:NORMALIZED).
              IF ang < 15 { SET aligned TO TRUE. }
              WAIT 0.5.
            }
            PRINT aligned.
          `.trim().replaceAll('\n', ' ');
          await conn.execute(alignScript, 25_000);

          logger.progress('[Landing] Burning to deorbit...');
          // Burn retrograde until periapsis is negative
          const burnScript = `
            LOCK STEERING TO RETROGRADE.
            LOCK THROTTLE TO 1.
            WAIT UNTIL PERIAPSIS < 0.
            LOCK THROTTLE TO 0.
            WAIT 0.1.
            LOCK THROTTLE TO 0.
            WAIT 0.1.
            UNLOCK THROTTLE.
            UNLOCK STEERING.
            PRINT "Deorbit complete. PE=" + ROUND(PERIAPSIS).
          `.trim().replaceAll('\n', ' ');
          const burnResult = await conn.execute(burnScript, 60_000);
          logger.progress(`[Landing] ${burnResult.output.trim()}`);
        }
      }

      // Step 3: Apply configuration if provided (optional)
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

      let landResult: { success: boolean; error?: string };
      if (hasTarget) {
        logger.progress('[Landing] Starting targeted landing...');
        landResult = await startTargetedLanding(conn);
      } else {
        logger.progress('[Landing] Starting untargeted landing...');
        landResult = await startUntargetedLanding(conn);
      }

      if (!landResult.success) {
        return ctx.errorResponse('land', landResult.error ?? 'Failed to start landing');
      }

      // Get status after starting
      const status = await getLandingStatus(conn);
      logger.progress(`[Landing] ${status.status}`);

      // If wait=true, monitor until completion
      if (wait) {
        const monitorResult = await monitorLanding(conn, { logger });

        if (monitorResult.success) {
          // Query landing site details for informative response
          let landingDetails = '';
          try {
            const siteInfo = await conn.execute(
              'PRINT SHIP:BODY:NAME + "|" + SHIP:GEOPOSITION:TERRAINHEIGHT + "|" + SHIP:BIOME.',
              3000
            );
            const siteMatch = siteInfo.output.match(/([^|]+)\|([-\d.]+)\|(.+)/);
            if (siteMatch) {
              const bodyName = siteMatch[1].trim();
              const altitude = Number.parseFloat(siteMatch[2]);
              const biome = siteMatch[3].trim();
              const altStr = Math.abs(altitude) > 1000
                ? `${(altitude / 1000).toFixed(1)}km`
                : `${Math.round(altitude)}m`;
              landingDetails = `\nLocation: ${bodyName}, ${biome} at ${altStr} elevation`;
            }
          } catch {
            // Ignore errors querying site details
          }

          return ctx.successResponse('land',
            `Landing complete!${landingDetails}\nVessel safely on surface.`);
        } else {
          return ctx.errorResponse('land',
            monitorResult.error ?? `Landing failed: ${monitorResult.finalStatus.status}`);
        }
      }

      // Not waiting - just return initial status
      let message = `Landing started (${hasTarget ? 'targeted' : 'untargeted'})\n`;
      message += status.formatted;

      return ctx.successResponse('land', message);
    } catch (error) {
      return ctx.errorResponse(
        'land',
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      clearActiveOperation();
    }
  },
};

// Re-export for library use


export {getLandingStatus, startTargetedLanding, startUntargetedLanding, stopLanding, type LandingStatus} from './shared.js';