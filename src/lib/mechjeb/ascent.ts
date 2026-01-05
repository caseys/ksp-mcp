/**
 * MechJeb Ascent Program
 *
 * Task-oriented interface for launching to orbit
 */

import type { KosConnection } from '../../transport/kos-connection.js';
import type {
  LaunchOptions,
  AscentSettings,
  AscentStatus,
  AscentProgress,
  AscentResult
} from '../types.js';
import { delay } from '../utils/progress.js';
import { formatOrbit, fmtDist } from '../utils/format.js';
import { clearNodes } from '../kos/nodes.js';
import { type McpLogger, nullLogger } from '../tool-types.js';
import { clearBroadcastLogger } from '../../utils/broadcast-logger.js';
import { ManeuverOrchestrator } from './orchestrator.js';
import { config } from '../../config/index.js';
import { pollWithBlackoutResilience } from '../../utils/poll-with-resilience.js';

/**
 * Detect kOS errors in output
 * Checks for common error patterns like "not found", "GET Suffix", exceptions, etc.
 */
function hasKosError(output: string): boolean {
  const lc = output.toLowerCase();
  return lc.includes('not found') || lc.includes('get suffix') ||
         lc.includes('at interpreter') || lc.includes('error') ||
         lc.includes('object reference') || lc.includes('null reference') ||
         lc.includes('value cannot be null');
}

/**
 * Handle for monitoring an in-progress ascent
 */
export class AscentHandle {
  private aborted = false;
  private logger: McpLogger;

  constructor(
    private conn: KosConnection,
    public readonly id: string,
    public readonly targetAltitude: number,
    logger?: McpLogger
  ) {
    this.logger = logger ?? nullLogger;
  }

  /**
   * Get current progress of the ascent
   * Optimized: single atomic query instead of 5 sequential commands
   * Uses MechJeb STATUS for accurate phase detection and dynamic atmosphere height
   */
  async getProgress(): Promise<AscentProgress> {
    // Single atomic query for all progress values including MechJeb status and atmosphere height
    const result = await this.conn.execute(
      'PRINT "PROG|" + ALTITUDE + "|" + APOAPSIS + "|" + PERIAPSIS + "|" + ' +
      'ADDONS:MJ:ASCENT:ENABLED + "|" + ADDONS:MJ:ASCENT:STATUS + "|" + ' +
      'ROUND(SHIP:BODY:ATM:HEIGHT).',
      3000
    );

    // Parse "PROG|alt|apo|per|enabled|mjStatus|atmHeight" format
    const match = result.output.match(/PROG\|([\d.]+)\|([\d.-]+)\|([\d.-]+)\|(True|False)\|([^|]*)\|(\d+)/i);

    const altitude = match ? Number.parseFloat(match[1]) : 0;
    const apoapsis = match ? Number.parseFloat(match[2]) : 0;
    const periapsis = match ? Number.parseFloat(match[3]) : 0;
    const enabled = match ? match[4].toLowerCase() === 'true' : false;
    const mjStatus = match ? match[5].trim() : '';
    const atmHeight = match ? Number.parseInt(match[6]) : 70_000;

    // Determine phase using MechJeb status strings
    let phase: AscentProgress['phase'];
    const statusLower = mjStatus.toLowerCase();

    if (statusLower.includes('prelaunch') || statusLower.includes('landed') || (!enabled && mjStatus === '')) {
      phase = 'prelaunch';
    } else if (periapsis >= atmHeight) {
      phase = 'complete';
    } else if (statusLower.includes('circulariz')) {
      phase = 'circularizing';
    } else if (statusLower.includes('coasting')) {
      phase = 'coasting';
    } else if (statusLower.includes('gravity turn') || statusLower.includes('turn')) {
      phase = 'gravity_turn';
    } else if (altitude > 100) {
      phase = 'launching';
    } else {
      phase = 'prelaunch';
    }

    return {
      phase,
      altitude,
      apoapsis,
      periapsis,
      enabled,
      shipStatus: mjStatus || 'Unknown'
    };
  }

  /**
   * Wait for the ascent to complete using TypeScript polling
   * More reliable than blocking kOS UNTIL loop - handles connection recovery
   */
  async waitForCompletion(pollIntervalMs = 5000): Promise<AscentResult> {
    this.logger.progress('[Ascent] Waiting to complete...');

    const MAX_WAIT_MS = 900_000; // 15 minutes max

    // Get atmosphere height for this body using labeled output
    const atmResult = await this.conn.execute('PRINT "ATM:" + ROUND(SHIP:BODY:ATM:HEIGHT).');
    const atmMatch = atmResult.output.match(/ATM:(-?\d+)/);
    if (!atmMatch) {
      throw new Error(`Failed to query atmosphere height. kOS output: ${atmResult.output.slice(0, 100)}`);
    }
    const atmHeight = Number.parseInt(atmMatch[1]);
    this.logger.info(`[Ascent] Target: periapsis >= ${Math.round(atmHeight/1000)}km (atmosphere height)`);

    let lastLogTime = 0;
    let _prevDeltaV: number | null = null;
    let lastStatus = '';
    let circularizationStarted = false;  // Track if we've started circularization

    interface AscentPollState {
      enabled: boolean;
      status: string;
      apoapsis: number;
      periapsis: number;
      body: string;
      inOrbit: boolean;
      deltaV: number;
      throttle: number;
      angularVel: number;
    }

    const result = await pollWithBlackoutResilience<AscentPollState>({
      poll: async () => {
        // Use pipe delimiters for robust parsing (status may contain spaces/colons)
        const statusResult = await this.conn.execute(
          'SET _ASC TO ADDONS:MJ:ASCENT. ' +
          'SET _E TO _ASC:ENABLED. ' +
          'SET _S TO _ASC:STATUS. ' +
          'SET _A TO ROUND(APOAPSIS). ' +
          'SET _P TO ROUND(PERIAPSIS). ' +
          'SET _B TO SHIP:BODY:NAME. ' +
          'SET _DV TO ROUND(SHIP:DELTAV:CURRENT, 1). ' +
          'SET _THR TO ROUND(THROTTLE, 2). ' +
          'SET _AV TO ROUND(SHIP:ANGULARVEL:MAG, 3). ' +
          'PRINT _E + "|" + _S + "|" + _A + "|" + _P + "|" + _B + "|" + _DV + "|" + _THR + "|" + _AV.'
        );

        const statusMatch = statusResult.output.match(/(True|False)\|([^|]*)\|(-?\d+)\|(-?\d+)\|(\w+)\|([\d.]+)\|([\d.]+)\|([\d.]+)/i);
        if (!statusMatch) {
          throw new Error('Failed to parse ascent status');
        }

        const enabled = statusMatch[1].toLowerCase() === 'true';
        const status = statusMatch[2].trim();
        const apoapsis = Number.parseInt(statusMatch[3]);
        const periapsis = Number.parseInt(statusMatch[4]);
        const body = statusMatch[5];
        const deltaV = Number.parseFloat(statusMatch[6]);
        const throttle = Number.parseFloat(statusMatch[7]);
        const angularVel = Number.parseFloat(statusMatch[8]);
        const inOrbit = periapsis >= atmHeight;

        return { enabled, status, apoapsis, periapsis, body, inOrbit, deltaV, throttle, angularVel };
      },

      isDone: (state) => state.inOrbit,  // Only done when actually in orbit
      isSuccess: (state) => state.inOrbit,

      timeoutMs: MAX_WAIT_MS,
      pollIntervalMs,
      logger: this.logger,
      context: 'Ascent',
      connection: this.conn,

      onPoll: async (state) => {
        // Log status changes
        const now = Date.now();
        if (state.status && state.status !== lastStatus) {
          this.logger.progress(`[Ascent] ${state.status} at ${formatOrbit(state.apoapsis, state.periapsis)}`);
          lastStatus = state.status;
          lastLogTime = now;
        }

        // Log progress every 20 seconds at least
        if (now - lastLogTime >= 20_000) {
          this.logger.progress(`[Ascent] at ${formatOrbit(state.apoapsis, state.periapsis)}`);
          lastLogTime = now;
        }

        // Detect when MechJeb ascent is disabled but we're suborbital (ready for circularization)
        // This happens because we set skipCircularization=true
        const isSuborbital = state.apoapsis > atmHeight && state.periapsis < atmHeight;
        if (!circularizationStarted && !state.enabled && isSuborbital) {
          circularizationStarted = true;
          this.logger.info(`[Ascent] MechJeb ascent complete, starting circularization...`);

          // Use the ManeuverOrchestrator for reliable circularization (handles warp + execution)
          const orchestrator = new ManeuverOrchestrator(this.conn);
          const circResult = await orchestrator.circularize('APOAPSIS', {
            execute: true,
            logger: this.logger,
            callerTool: 'circularize_after_launch',
          });

          if (circResult.success) {
            this.logger.info(`[Ascent] Circularization complete!`);
          } else {
            this.logger.warn(`[Ascent] Circularization issue: ${circResult.error ?? 'unknown'}`);
          }
        }

        // Disabled: using env var control instead of kickstart pulses
        // Kickstart warp when coasting (not burning) and not yet in orbit
        // const isCoasting = state.throttle === 0;
        // const dvStable = prevDeltaV !== null && Math.abs(state.deltaV - prevDeltaV) < 1;
        // const notYetInOrbit = state.periapsis < this.targetAltitude*0.85;
        // if (notYetInOrbit && isCoasting && dvStable) {
        //   await kickstartWarp(this.conn, this.logger, state);
        // }

        // Update previous delta-v for next poll
        _prevDeltaV = state.deltaV;
      },
    });

    // Handle completion
    if (result.result) {
      const { enabled, apoapsis, periapsis, body, inOrbit } = result.result;

      // Disable autopilot if we're in orbit but it's still enabled
      if (inOrbit && enabled) {
        try {
          await this.conn.execute('SET ADDONS:MJ:ASCENT:ENABLED TO FALSE.');
        } catch {
          // Ignore - may still be in blackout
        }
      }

      if (!result.timedOut) {
        this.logger.progress(`[Ascent] Complete at ${body}! ATM: ${Math.round(atmHeight/1000)}km`);
        this.logger.progress(`[Ascent] ${formatOrbit(apoapsis, periapsis)} - ${inOrbit ? 'ORBIT ACHIEVED' : 'ABORTED'}`);

        // Clear any leftover maneuver nodes
        try {
          await clearNodes(this.conn);
        } catch {
          // Ignore
        }

        return {
          success: inOrbit,
          finalOrbit: { apoapsis, periapsis },
          aborted: !inOrbit,
        };
      }
    }

    // Timeout
    this.logger.error(`[Ascent] TIMEOUT after ${MAX_WAIT_MS/1000}s`);
    const finalApoapsis = result.result?.apoapsis ?? 0;
    const finalPeriapsis = result.result?.periapsis ?? 0;
    this.logger.progress(`[Ascent] Final: ${formatOrbit(finalApoapsis, finalPeriapsis)}`);

    return {
      success: false,
      finalOrbit: { apoapsis: finalApoapsis, periapsis: finalPeriapsis },
      aborted: false,
    };
  }

  /**
   * Wait for the vessel to leave the launchpad (quick test mode)
   * Returns as soon as altitude > 100m or phase is no longer 'prelaunch'
   */
  async waitForLiftoff(pollIntervalMs = 1000, timeoutMs = 60_000): Promise<AscentResult> {
    this.logger.progress('[Ascent] Waiting for liftoff...');

    const result = await pollWithBlackoutResilience<AscentProgress>({
      poll: () => this.getProgress(),

      isDone: (progress) => progress.phase !== 'prelaunch' || progress.altitude > 100,
      isSuccess: (progress) => progress.phase !== 'prelaunch' || progress.altitude > 100,

      timeoutMs,
      pollIntervalMs,
      logger: this.logger,
      context: 'Liftoff',
      connection: this.conn,

      onPoll: (progress) => {
        if (progress.phase !== 'prelaunch' || progress.altitude > 100) {
          this.logger.progress(`[Ascent] Liftoff confirmed! Altitude: ${fmtDist(progress.altitude)}, Phase: ${progress.phase}`);
        }
      },
    });

    if (result.success && result.result) {
      return {
        success: true,
        finalOrbit: { apoapsis: result.result.apoapsis, periapsis: result.result.periapsis },
        aborted: false,
      };
    }

    // Timeout
    this.logger.error('[Ascent] Liftoff timeout - ship did not leave the pad');
    return {
      success: false,
      finalOrbit: { apoapsis: 0, periapsis: 0 },
      aborted: false,
    };
  }

  /**
   * Abort the ascent
   */
  async abort(): Promise<void> {
    this.aborted = true;
    await this.conn.execute('SET ADDONS:MJ:ASCENT:ENABLED TO FALSE.');
  }
}

/**
 * Ascent Program - controls MechJeb ascent autopilot
 */
export class AscentProgram {
  private handleCounter = 0;
  private logger: McpLogger;

  constructor(private conn: KosConnection, logger?: McpLogger) {
    this.logger = logger ?? nullLogger;
  }

  /**
   * Wait for MechJeb to be fully initialized and ready.
   * Just retry until MechJeb queries work - no arbitrary delays.
   */
  async waitForMechJebReady(): Promise<void> {
    const MAX_ATTEMPTS = 30;  // ~15 seconds max

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      // Use SET then PRINT for reliable output (inline MechJeb addon access can be lost)
      const result = await this.conn.execute('SET _E TO ADDONS:MJ:ASCENT:ENABLED. PRINT _E.');
      if (!hasKosError(result.output) && result.output.trim() !== '') {
        this.logger.info('[Ascent] MechJeb ready');
        return;
      }
      await delay(500);  // Short retry delay
    }

    throw new Error('[Ascent] MechJeb not ready after 15 seconds');
  }

  /**
   * Configure ascent settings
   */
  async configure(settings: Partial<AscentSettings>): Promise<void> {
    const commands: string[] = [];
    const AG = 'ADDONS:MJ:ASCENT';

    if (settings.desiredAltitude !== undefined) {
      commands.push(`SET ${AG}:DESIREDALTITUDE TO ${settings.desiredAltitude}.`);
    }
    if (settings.desiredInclination !== undefined) {
      commands.push(`SET ${AG}:DESIREDINCLINATION TO ${settings.desiredInclination}.`);
    }
    if (settings.autostage !== undefined) {
      commands.push(`SET ${AG}:AUTOSTAGE TO ${settings.autostage ? 'TRUE' : 'FALSE'}.`);
    }
    if (settings.skipCircularization !== undefined) {
      commands.push(`SET ${AG}:SKIPCIRCULARIZATION TO ${settings.skipCircularization ? 'TRUE' : 'FALSE'}.`);
    }
    if (settings.autowarp !== undefined) {
      commands.push(`SET ${AG}:AUTOWARP TO ${settings.autowarp ? 'TRUE' : 'FALSE'}.`);
    }

    // Gravity turn profile
    if (settings.turnStartAltitude !== undefined) {
      commands.push(`SET ${AG}:TURNSTARTALTITUDE TO ${settings.turnStartAltitude}.`);
    }
    if (settings.turnStartVelocity !== undefined) {
      commands.push(`SET ${AG}:TURNSTARTVELOCITY TO ${settings.turnStartVelocity}.`);
    }
    if (settings.turnEndAltitude !== undefined) {
      commands.push(`SET ${AG}:TURNENDALTITUDE TO ${settings.turnEndAltitude}.`);
    }
    if (settings.turnEndAngle !== undefined) {
      commands.push(`SET ${AG}:TURNENDANGLE TO ${settings.turnEndAngle}.`);
    }
    if (settings.turnShapeExponent !== undefined) {
      commands.push(`SET ${AG}:TURNSHAPEEXPONENT TO ${settings.turnShapeExponent}.`);
    }
    if (settings.autoPath !== undefined) {
      commands.push(`SET ${AG}:AUTOPATH TO ${settings.autoPath ? 'TRUE' : 'FALSE'}.`);
    }

    // Limits
    if (settings.limitAoA !== undefined) {
      commands.push(`SET ${AG}:LIMITAOA TO ${settings.limitAoA ? 'TRUE' : 'FALSE'}.`);
    }
    if (settings.maxAoA !== undefined) {
      commands.push(`SET ${AG}:MAXAOA TO ${settings.maxAoA}.`);
    }
    if (settings.limitQEnabled !== undefined) {
      commands.push(`SET ${AG}:LIMITQAENABLED TO ${settings.limitQEnabled ? 'TRUE' : 'FALSE'}.`);
    }
    if (settings.limitQ !== undefined) {
      commands.push(`SET ${AG}:LIMITQA TO ${settings.limitQ}.`);
    }

    // Roll control
    if (settings.forceRoll !== undefined) {
      commands.push(`SET ${AG}:FORCEROLL TO ${settings.forceRoll ? 'TRUE' : 'FALSE'}.`);
    }
    if (settings.verticalRoll !== undefined) {
      commands.push(`SET ${AG}:VERTICALROLL TO ${settings.verticalRoll}.`);
    }
    if (settings.turnRoll !== undefined) {
      commands.push(`SET ${AG}:TURNROLL TO ${settings.turnRoll}.`);
    }

    // Execute commands one at a time for reliability
    // Batch commands can overwhelm the kOS telnet connection
    for (const cmd of commands) {
      await this.conn.execute(cmd);
      await delay(50);  // Small delay between commands
    }
  }

  /**
   * Get current ascent status
   * Optimized: single atomic query instead of 3 sequential commands
   */
  async getStatus(): Promise<AscentStatus> {
    // Single atomic query for all ascent status values
    const result = await this.conn.execute(
      'PRINT "ASC|" + ADDONS:MJ:ASCENT:ENABLED + "|" + ADDONS:MJ:ASCENT:DESIREDALTITUDE + "|" + ADDONS:MJ:ASCENT:DESIREDINCLINATION.',
      3000
    );

    // Parse "ASC|enabled|altitude|inclination" format
    const match = result.output.match(/ASC\|(True|False)\|([\d.]+)\|([\d.-]+)/i);

    return {
      enabled: match ? match[1].toLowerCase() === 'true' : false,
      ascentType: 'GT',  // Gravity Turn is the default
      settings: {
        desiredAltitude: match ? Number.parseFloat(match[2]) : 0,
        desiredInclination: match ? Number.parseFloat(match[3]) : 0
      }
    };
  }

  /**
   * Enable or disable ascent autopilot
   */
  async setEnabled(enabled: boolean): Promise<void> {
    await this.conn.execute(`SET ADDONS:MJ:ASCENT:ENABLED TO ${enabled ? 'TRUE' : 'FALSE'}.`);
  }

  /**
   * Launch to orbit - high-level task method
   *
   * Configures MechJeb ascent guidance and initiates launch.
   * MechJeb handles throttle, staging, and attitude automatically.
   * Returns a handle for monitoring progress.
   */
  async launchToOrbit(options: LaunchOptions): Promise<AscentHandle> {
    const {
      altitude,
      inclination = 0,
      autoStage = true,
      // circularize option is ignored - we always handle circularization ourselves
      // autoWarp is now controlled by AUTOWARP_PHYSICS_MAX env var
    } = options;

    // Wait for MechJeb to be ready (critical after save reload)
    await this.waitForMechJebReady();

    // Configure ascent - always enable MechJeb autowarp capability
    // Actual physics warp level is controlled by AUTOWARP_PHYSICS_MAX env var
    await this.configure({
      desiredAltitude: altitude,
      desiredInclination: inclination,
      autostage: autoStage,
      skipCircularization: true,  // We handle circularization ourselves for reliability
      autowarp: config.warp.physicsMax > 0  // Enable MechJeb autowarp if physics warp is enabled
    });

    // Let MechJeb process the configuration
    await delay(500);

    // Enable autopilot with retry loop (critical step - must succeed)
    let autopilotEngaged = false;
    for (let attempt = 1; attempt <= 10; attempt++) {
      // Enable the autopilot
      await this.conn.execute('SET ADDONS:MJ:ASCENT:ENABLED TO TRUE.');
      await delay(500);  // Let MechJeb state update

      // Verify it's enabled - try multiple times in case of empty response
      for (let verifyAttempt = 1; verifyAttempt <= 3; verifyAttempt++) {
        const verifyResult = await this.conn.execute('SET _E TO ADDONS:MJ:ASCENT:ENABLED. PRINT _E.');
        if (verifyResult.output.toLowerCase().includes('true')) {
          autopilotEngaged = true;
          this.logger.progress(`[Ascent] Autopilot engaged (attempt ${attempt})`);
          break;
        }
        if (verifyResult.output.toLowerCase().includes('false')) {
          // Got valid response but not enabled - continue outer loop to retry enable
          break;
        }
        // Empty response - small delay and retry verify
        await delay(200);
      }

      if (autopilotEngaged) break;
      this.logger.progress(`[Ascent] Autopilot not engaged yet (attempt ${attempt}/10)`);
      await delay(300);
    }

    if (!autopilotEngaged) {
      this.logger.warn('[Ascent] Autopilot may not have engaged after 10 attempts, proceeding anyway');
    }

    // Release controls
    await this.conn.execute('UNLOCK THROTTLE.');
    await delay(100);
    await this.conn.execute('SAS OFF.');
    await delay(100);

    // Check if we need to stage (stationary on pad vs already moving)
    // On Kerbin: need to stage to ignite engines and release clamps
    // On other bodies: may already be ready to fly without staging
    const alt1Result = await this.conn.execute('PRINT ROUND(ALTITUDE, 1).');
    const alt1 = Number.parseFloat(alt1Result.output.match(/-?[\d.]+/)?.[0] ?? '0');
    await delay(500);
    const alt2Result = await this.conn.execute('PRINT ROUND(ALTITUDE, 1).');
    const alt2 = Number.parseFloat(alt2Result.output.match(/-?[\d.]+/)?.[0] ?? '0');

    if (Math.abs(alt2 - alt1) < 1) {
      // Not moving - need to stage to start
      await this.conn.execute('STAGE.');
      await delay(500);
      this.logger.progress('[Ascent] STAGED');
    } else {
      this.logger.progress('[Ascent] LAUNCHED');
    }

    // Enable physics warp after 20 seconds if configured via env var
    // This replaces the old autoWarp parameter with global env var control
    if (config.warp.physicsMax > 0) {
      setTimeout(async () => {
        try {
          // Set physics warp mode and enable
          await this.conn.execute(`SET WARPMODE TO "PHYSICS". SET WARP TO 0. WAIT 0.3. SET WARP TO ${config.warp.physicsMax}.`);
          this.logger.info(`[Ascent] Enabled ${config.warp.physicsMax + 1}x physics warp`);
        } catch {
          // Ignore warp errors - non-critical
        }
      }, 20_000);
    }

    // Create handle for monitoring (pass logger for waitForCompletion)
    const handleId = `ascent-${++this.handleCounter}-${Date.now()}`;
    return new AscentHandle(this.conn, handleId, altitude, this.logger);
  }
}

// ============================================================================
// Tool Definition
// ============================================================================

import { z } from 'zod';
import type { ToolDefinition } from '../tool-types.js';
import { distanceSchema } from '../tool-types.js';
import { validateVesselState, LAUNCH_REQUIREMENTS } from '../kos/vessel/validate.js';
import { setActiveOperation, clearActiveOperation } from '../../utils/operation-state.js';

/**
 * Get default launch altitude based on current body:
 * - With atmosphere: atmHeight * 1.5 (safe margin above atmosphere)
 * - Without atmosphere: 50km
 */
async function getDefaultLaunchAltitude(conn: KosConnection): Promise<number> {
  const NO_ATM_DEFAULT = 50_000; // 50km for bodies without atmosphere
  try {
    const result = await conn.execute(
      'IF SHIP:BODY:ATM:EXISTS { PRINT SHIP:BODY:ATM:HEIGHT. } ELSE { PRINT 0. }',
      3000
    );
    const match = result.output.match(/([\d.]+)/);
    if (match) {
      const atmHeight = parseFloat(match[1]);
      return atmHeight > 0 ? Math.round(atmHeight * 1.5) : NO_ATM_DEFAULT;
    }
  } catch {
    // Ignore errors
  }
  return NO_ATM_DEFAULT;
}

/**
 * Launch ascent tool definition
 */
export const launchAscentTool: ToolDefinition = {
  name: 'launch_and_circularize',
  description: 'Launch from pad or ground to orbit. Automatically circularizes after ascent.',
  inputSchema: {
    altitude: distanceSchema.optional().describe('Optional target orbit altitude in meters, default above atmosphere.'),
    inclination: z.number().optional().default(0).describe('Optional target inclination in degrees, equatorial=0'),
    // Note: Circularization is always enabled to make things simpler for LLMs
    // circularize: z.boolean().optional().default(true).describe('Circularize orbit after ascent (default: true)'),
    // Note: wait is hidden from MCP to simplify LLM usage - always waits for orbit
    // Library code can still pass wait=false via args for testing
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 1,
  handler: async (args, ctx, extra) => {
    setActiveOperation('launch_and_circularize', 'Launching to orbit');
    try {
      const conn = await ctx.ensureConnected();
      const logger = ctx.createBroadcastableLogger(extra);

      // Validate vessel state: must be landed or prelaunch
      const validation = await validateVesselState(conn, LAUNCH_REQUIREMENTS, 'launch_and_circularize');
      if (!validation.valid) {
        return ctx.errorResponse('launch', validation.error ?? 'Invalid vessel state');
      }

      // Get default altitude based on body's atmosphere
      let altitude = args.altitude as number | undefined;
      if (altitude === undefined) {
        altitude = await getDefaultLaunchAltitude(conn);
      }

      // Create ascent program and launch
      // Note: autoWarp is now controlled by AUTOWARP_PHYSICS_MAX env var
      const program = new AscentProgram(conn, logger);
      const handle = await program.launchToOrbit({
        altitude,
        inclination: args.inclination as number,
        autoStage: true,
        // Note: Circularization is always enabled - disabling causes MechJeb issues
        circularize: true,
      });

      const wait = args.wait as boolean | undefined ?? true;

      if (wait) {
        // Wait for completion (blocking call that monitors ascent)
        const result = await handle.waitForCompletion();

        if (result.success) {
          const orbit = result.finalOrbit;
          // Check eccentricity to tell LLM orbit is stable
          const eccResult = await conn.execute('PRINT ROUND(ORBIT:ECCENTRICITY, 4).');
          const ecc = Number.parseFloat(eccResult.output.match(/[\d.]+/)?.[0] ?? '0');
          const orbitStatus = ecc < 0.05
            ? 'Orbit is circular and stable.'
            : `Orbit is stable (ecc=${ecc.toFixed(3)}).`;
          return ctx.successResponse('launch',
            `Orbit achieved! ${formatOrbit(orbit.apoapsis, orbit.periapsis)}\n${orbitStatus}\nNext: set target for transfer`);
        } else {
          return ctx.errorResponse('launch', result.aborted ? 'Ascent aborted' : 'Ascent failed');
        }
      } else {
        // Return immediately after launch
        return ctx.successResponse('launch',
          `Launch started! Target: ${(altitude / 1000).toFixed(0)} km orbit.`);
      }
    } catch (error) {
      return ctx.errorResponse('launch', error instanceof Error ? error.message : String(error));
    } finally {
      clearActiveOperation();
      clearBroadcastLogger();
    }
  },
};
