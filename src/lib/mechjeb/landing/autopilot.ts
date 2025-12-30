/**
 * Landing Autopilot - Start, stop, and monitor landing
 */

import { z } from 'zod';
import type { ToolDefinition, McpLogger } from '../../tool-types.js';
import { nullLogger } from '../../tool-types.js';
import { setActiveOperation, clearActiveOperation } from '../../../utils/operation-state.js';
import { pollWithBlackoutResilience } from '../../../utils/poll-with-resilience.js';
import type { KosConnection } from '../../../transport/kos-connection.js';
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
      const eta = status.timeToLanding !== undefined ? ` | ETA: ${formatTime(status.timeToLanding)}` : '';
      log.progress(`[Landing] ALT: ${altStr} | VEL: ${vSpeed} m/s${eta}`);
    }
  } catch {
    // Ignore errors during altitude logging
  }
}

function formatTime(seconds: number | undefined): string {
  if (seconds === undefined) return 'unknown';
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// ============================================================================
// Tool Definition
// ============================================================================

export const landTool: ToolDefinition = {
  name: 'land',
  description:
    'Start, stop, or check landing autopilot. ' +
    'action="start" begins landing (at position target if set, or anywhere). ' +
    'action="abort" stops landing. action="status" checks progress. ' +
    'Optional: specify lat/lng or preset to set landing target. ' +
    'Optional: include config params (touchdownSpeed, deployGears, etc.) to configure before starting.',
  inputSchema: {
    action: z.enum(['start', 'abort', 'status'])
      .optional()
      .default('start')
      .describe('start=begin landing (default), abort=cancel, status=check progress'),

    // Position target (optional)
    latitude: z.number()
      .min(-90)
      .max(90)
      .optional()
      .describe('Target latitude for precision landing (-90 to 90)'),
    longitude: z.number()
      .min(-180)
      .max(180)
      .optional()
      .describe('Target longitude for precision landing (-180 to 180)'),
    preset: z.enum(['KSC'])
      .optional()
      .describe('Use preset location. "KSC" = Kerbin Space Center runway'),

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
      .describe('Wait for landing to complete (default: true). Set false to return immediately after starting.'),
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

    // Track auto-found site coordinates for deorbit burn logic
    let autoFoundLat: number | undefined;
    let autoFoundLng: number | undefined;

    try {
      // Step 1: Set position target if provided
      const latitude = args.latitude as number | undefined;
      const longitude = args.longitude as number | undefined;
      const preset = args.preset as 'KSC' | undefined;

      if (preset === 'KSC') {
        logger.progress('[Landing] Setting target: KSC');
        const targetResult = await setLandingPositionTargetKSC(conn);
        if (!targetResult.success) {
          return ctx.errorResponse('land', targetResult.error ?? 'Failed to set KSC target');
        }
      } else if (latitude !== undefined && longitude !== undefined) {
        logger.progress(`[Landing] Setting target: ${latitude.toFixed(2)}°, ${longitude.toFixed(2)}°`);
        const targetResult = await setLandingPositionTarget(conn, latitude, longitude);
        if (!targetResult.success) {
          return ctx.errorResponse('land', targetResult.error ?? 'Failed to set position target');
        }
      } else {
        // No explicit target - auto-find optimal landing site
        logger.progress('[Landing] Finding optimal landing site...');
        const siteResult = await findLandingSite(conn);
        if (siteResult.found && siteResult.latitude !== undefined && siteResult.longitude !== undefined) {
          // Store for deorbit burn logic
          autoFoundLat = siteResult.latitude;
          autoFoundLng = siteResult.longitude;
          // Set the found site as position target
          const targetResult = await setLandingPositionTarget(conn, siteResult.latitude, siteResult.longitude);
          if (targetResult.success) {
            logger.progress(`[Landing] Auto-selected: ${siteResult.latitude.toFixed(2)}°, ${siteResult.longitude.toFixed(2)}°`);
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

      // Step 2: Deorbit burn (only if target is within 1/4 orbit)
      // If target is farther, let MechJeb handle timing
      const targetLat = latitude ?? autoFoundLat;
      const targetLng = longitude ?? autoFoundLng;

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
          return ctx.successResponse('land',
            `Landing complete! ${monitorResult.finalStatus.status}\nMission complete - vessel safely on surface`);
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