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
import { ensureConnected } from '../../transport/connection-tools.js';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse a numeric value from kOS output
 */
function parseNumber(output: string): number {
  const match = output.match(/-?[\d.]+(?:E[+-]?\d+)?/i);
  return match ? Number.parseFloat(match[0]) : 0;
}

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

  constructor(
    private conn: KosConnection,
    public readonly id: string,
    public readonly targetAltitude: number
  ) {}

  /**
   * Get current progress of the ascent
   * Optimized: single atomic query instead of 5 sequential commands
   */
  async getProgress(): Promise<AscentProgress> {
    // Single atomic query for all progress values
    const result = await this.conn.execute(
      'PRINT "PROG|" + ALTITUDE + "|" + APOAPSIS + "|" + PERIAPSIS + "|" + ADDONS:MJ:ASCENT:ENABLED + "|" + SHIP:STATUS.',
      3000
    );

    // Parse "PROG|alt|apo|per|enabled|status" format
    const match = result.output.match(/PROG\|([\d.]+)\|([\d.-]+)\|([\d.-]+)\|(True|False)\|(.+?)(?:\s*>|$)/i);

    const altitude = match ? Number.parseFloat(match[1]) : 0;
    const apoapsis = match ? Number.parseFloat(match[2]) : 0;
    const periapsis = match ? Number.parseFloat(match[3]) : 0;
    const enabled = match ? match[4].toLowerCase() === 'true' : false;
    const shipStatus = match ? match[5].toLowerCase().trim() : 'unknown';

    // Determine phase
    let phase: AscentProgress['phase'];
    if (shipStatus.includes('prelaunch') || shipStatus.includes('landed')) {
      phase = 'prelaunch';
    } else if (periapsis > 70_000) {
      phase = 'complete';
    } else if (apoapsis >= this.targetAltitude * 0.95 && altitude > 70_000) {
      phase = 'circularizing';
    } else if (apoapsis >= this.targetAltitude * 0.9) {
      phase = 'coasting';
    } else if (altitude > 1000) {
      phase = 'gravity_turn';
    } else if (altitude > 100) {
      phase = 'launching';
    } else if (!enabled && shipStatus.includes('flying')) {
      phase = 'unknown';
    } else {
      phase = 'prelaunch';
    }

    return {
      phase,
      altitude,
      apoapsis,
      periapsis,
      enabled,
      shipStatus: match ? match[5].trim() : 'Unknown'
    };
  }

  /**
   * Wait for the ascent to complete using TypeScript polling
   * More reliable than blocking kOS UNTIL loop - handles connection recovery
   */
  async waitForCompletion(pollIntervalMs = 5000): Promise<AscentResult> {
    console.log('[Ascent] Waiting for MechJeb to complete ascent...');

    const MAX_WAIT_MS = 900_000; // 15 minutes max
    const startTime = Date.now();
    let lastLogTime = 0;
    let consecutiveEmptyResponses = 0;
    const MAX_EMPTY_RESPONSES = 3;

    // Get atmosphere height for this body using labeled output
    const atmResult = await this.conn.execute('PRINT "ATM:" + ROUND(SHIP:BODY:ATM:HEIGHT).');
    const atmMatch = atmResult.output.match(/ATM:(-?\d+)/);
    if (!atmMatch) {
      throw new Error(`Failed to query atmosphere height. kOS output: ${atmResult.output.slice(0, 100)}`);
    }
    const atmHeight = Number.parseInt(atmMatch[1]);
    console.log(`[Ascent] Target: periapsis >= ${Math.round(atmHeight/1000)}km (atmosphere height)`);

    while (Date.now() - startTime < MAX_WAIT_MS) {
      // Query current status (use SET then PRINT for reliable MechJeb addon output)
      const statusResult = await this.conn.execute(
        'SET _E TO ADDONS:MJ:ASCENT:ENABLED. ' +
        'SET _A TO ROUND(APOAPSIS). ' +
        'SET _P TO ROUND(PERIAPSIS). ' +
        'SET _B TO SHIP:BODY:NAME. ' +
        'PRINT "E:" + _E + " A:" + _A + " P:" + _P + " B:" + _B.'
      );

      // Parse results - "E:True A:100000 P:-500000 B:Kerbin"
      const statusMatch = statusResult.output.match(/E:(True|False)\s*A:(-?\d+)\s*P:(-?\d+)\s*B:(\w+)/i);

      // Detect stale connection (empty/unparseable output)
      if (!statusMatch || statusResult.output.trim() === '') {
        consecutiveEmptyResponses++;
        console.log(`[Ascent] Empty response (${consecutiveEmptyResponses}/${MAX_EMPTY_RESPONSES}), connection may be stale`);

        if (consecutiveEmptyResponses >= MAX_EMPTY_RESPONSES) {
          console.log('[Ascent] Too many empty responses, reconnecting...');
          try {
            // Force reconnect using ensureConnected
            this.conn = await ensureConnected();
            consecutiveEmptyResponses = 0;
            console.log('[Ascent] Reconnected successfully');
          } catch (error) {
            console.log(`[Ascent] Reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        await delay(pollIntervalMs);
        continue;
      }

      // Got valid response, reset counter
      consecutiveEmptyResponses = 0;

      const enabled = statusMatch[1].toLowerCase() === 'true';
      const apoapsis = Number.parseInt(statusMatch[2]);
      const periapsis = Number.parseInt(statusMatch[3]);
      const body = statusMatch[4];

      // Log progress every 10 seconds
      const now = Date.now();
      if (now - lastLogTime >= 10_000) {
        console.log(`APO:${Math.round(apoapsis/1000)}km PER:${Math.round(periapsis/1000)}km`);
        lastLogTime = now;
      }

      // Check completion conditions:
      // 1. Orbit achieved (periapsis above atmosphere)
      // 2. Ascent autopilot disabled (manual abort or MechJeb completed)
      // Use >= and check against atmHeight (not atmHeight+10km) to be more lenient
      const inOrbit = periapsis >= atmHeight;

      if (inOrbit || !enabled) {
        // Disable autopilot if we're in orbit but it's still enabled
        if (inOrbit && enabled) {
          await this.conn.execute('SET ADDONS:MJ:ASCENT:ENABLED TO FALSE.');
        }

        // Success if we achieved orbit (periapsis above atmosphere)
        const success = inOrbit;
        console.log(`[Ascent] Complete at ${body}! ATM: ${Math.round(atmHeight/1000)}km`);
        console.log(`[Ascent] APO: ${Math.round(apoapsis/1000)}km, PER: ${Math.round(periapsis/1000)}km - ${success ? 'ORBIT ACHIEVED' : 'ABORTED'}`);

        return {
          success,
          finalOrbit: { apoapsis, periapsis },
          aborted: !success
        };
      }

      // Wait before next poll
      await delay(pollIntervalMs);
    }

    // Timeout - get final status
    const finalResult = await this.conn.execute('PRINT APOAPSIS. PRINT PERIAPSIS.');
    const apoapsis = parseNumber(finalResult.output.split('\n')[0] || '0');
    const periapsis = parseNumber(finalResult.output.split('\n')[1] || '0');

    console.log(`[Ascent] TIMEOUT after ${MAX_WAIT_MS/1000}s`);
    console.log(`[Ascent] Final: APO: ${Math.round(apoapsis/1000)}km, PER: ${Math.round(periapsis/1000)}km`);

    return {
      success: false,
      finalOrbit: { apoapsis, periapsis },
      aborted: false
    };
  }

  /**
   * Wait for the vessel to leave the launchpad (quick test mode)
   * Returns as soon as altitude > 100m or phase is no longer 'prelaunch'
   */
  async waitForLiftoff(pollIntervalMs = 1000, timeoutMs = 60_000): Promise<AscentResult> {
    console.log('[Ascent] Waiting for liftoff...');
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const progress = await this.getProgress();

      // Ship has lifted off when:
      // - Phase changes from prelaunch, OR
      // - Altitude exceeds 100m
      if (progress.phase !== 'prelaunch' || progress.altitude > 100) {
        console.log(`[Ascent] Liftoff confirmed! ALT: ${Math.round(progress.altitude)}m, Phase: ${progress.phase}`);
        return {
          success: true,
          finalOrbit: { apoapsis: progress.apoapsis, periapsis: progress.periapsis },
          aborted: false
        };
      }

      await delay(pollIntervalMs);
    }

    // Timeout
    console.log('[Ascent] Liftoff timeout - ship did not leave the pad');
    return {
      success: false,
      finalOrbit: { apoapsis: 0, periapsis: 0 },
      aborted: false
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

  constructor(private conn: KosConnection) {}

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
        console.log('[Ascent] MechJeb ready');
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
      circularize = true,
      autoWarp = true
    } = options;

    // Wait for MechJeb to be ready (critical after save reload)
    await this.waitForMechJebReady();

    // Configure ascent
    await this.configure({
      desiredAltitude: altitude,
      desiredInclination: inclination,
      autostage: autoStage,
      skipCircularization: !circularize,
      autowarp: autoWarp
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
          console.log(`[Ascent] Autopilot engaged (attempt ${attempt})`);
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
      console.log(`[Ascent] Autopilot not engaged yet (attempt ${attempt}/10)`);
      await delay(300);
    }

    if (!autopilotEngaged) {
      console.log('[Ascent] Warning: Autopilot may not have engaged after 10 attempts, proceeding anyway');
    }

    // Release controls and stage to begin launch
    await this.conn.execute('UNLOCK THROTTLE.');
    await delay(100);
    await this.conn.execute('SAS OFF.');
    await delay(100);

    // Stage to begin launch - this is the critical moment
    await this.conn.execute('STAGE.');
    await delay(500);  // Let the stage command process
    console.log('[Ascent] LAUNCHED - MechJeb in control');

    // Enable 2x warp after 15 seconds if autoWarp is enabled
    if (autoWarp) {
      setTimeout(async () => {
        try {
          await this.conn.execute('SET WARP TO 1.');
          console.log('[Ascent] Enabled 2x warp');
        } catch {
          // Ignore warp errors - non-critical
        }
      }, 15_000);
    }

    // Create handle for monitoring
    const handleId = `ascent-${++this.handleCounter}-${Date.now()}`;
    return new AscentHandle(this.conn, handleId, altitude);
  }
}
