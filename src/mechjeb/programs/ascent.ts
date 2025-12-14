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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse a numeric value from kOS output
 */
function parseNumber(output: string): number {
  const match = output.match(/-?[\d.]+(?:E[+-]?\d+)?/i);
  return match ? parseFloat(match[0]) : 0;
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

    const altitude = match ? parseFloat(match[1]) : 0;
    const apoapsis = match ? parseFloat(match[2]) : 0;
    const periapsis = match ? parseFloat(match[3]) : 0;
    const enabled = match ? match[4].toLowerCase() === 'true' : false;
    const shipStatus = match ? match[5].toLowerCase().trim() : 'unknown';

    // Determine phase
    let phase: AscentProgress['phase'];
    if (shipStatus.includes('prelaunch') || shipStatus.includes('landed')) {
      phase = 'prelaunch';
    } else if (periapsis > 70000) {
      phase = 'complete';
    } else if (apoapsis >= this.targetAltitude * 0.95 && altitude > 70000) {
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
   * More reliable than blocking kOS UNTIL loop - handles daemon reconnection
   */
  async waitForCompletion(pollIntervalMs = 5000): Promise<AscentResult> {
    console.log('[Ascent] Waiting for MechJeb to complete ascent...');

    const MAX_WAIT_MS = 900000; // 15 minutes max
    const startTime = Date.now();
    let lastLogTime = 0;

    // Get atmosphere height for this body using labeled output
    const atmResult = await this.conn.execute('PRINT "ATM:" + ROUND(SHIP:BODY:ATM:HEIGHT).');
    const atmMatch = atmResult.output.match(/ATM:(-?\d+)/);
    const atmHeight = atmMatch ? parseInt(atmMatch[1]) : 70000; // Default to Kerbin
    const minOrbit = atmHeight > 0 ? atmHeight + 10000 : 10000;
    console.log(`[Ascent] Target: periapsis > ${Math.round(minOrbit/1000)}km (atmosphere ${Math.round(atmHeight/1000)}km + 10km)`);

    while (Date.now() - startTime < MAX_WAIT_MS) {
      // Query current status
      const statusResult = await this.conn.execute(
        'PRINT "ENABLED:" + ADDONS:MJ:ASCENT:ENABLED. ' +
        'PRINT "APO:" + ROUND(APOAPSIS). ' +
        'PRINT "PER:" + ROUND(PERIAPSIS). ' +
        'PRINT "BODY:" + SHIP:BODY:NAME.'
      );

      // Parse results - simple regex, just look for the labels anywhere
      const enabledMatch = statusResult.output.match(/ENABLED:(True|False)/i);
      const apoMatch = statusResult.output.match(/APO:(-?\d+)/);
      const perMatch = statusResult.output.match(/PER:(-?\d+)/);
      const bodyMatch = statusResult.output.match(/BODY:([A-Z][a-z]\w*)/);

      const enabled = enabledMatch ? enabledMatch[1].toLowerCase() === 'true' : true;
      const apoapsis = apoMatch ? parseInt(apoMatch[1]) : 0;
      const periapsis = perMatch ? parseInt(perMatch[1]) : 0;
      const body = bodyMatch ? bodyMatch[1] : 'Unknown';

      // Log progress every 10 seconds
      const now = Date.now();
      if (now - lastLogTime >= 10000) {
        console.log(`APO:${Math.round(apoapsis/1000)}km PER:${Math.round(periapsis/1000)}km`);
        lastLogTime = now;
      }

      // Check completion conditions:
      // 1. Ascent autopilot disabled (manual abort or completed)
      // 2. Orbit achieved (periapsis above atmosphere + 10km)
      const inOrbit = periapsis > minOrbit;

      if (!enabled || inOrbit) {
        // Disable autopilot if we're in orbit but it's still enabled
        if (inOrbit && enabled) {
          await this.conn.execute('SET ADDONS:MJ:ASCENT:ENABLED TO FALSE.');
        }

        const success = inOrbit;
        console.log(`[Ascent] Complete at ${body}! ATM: ${Math.round(atmHeight/1000)}km, Min orbit: ${Math.round(minOrbit/1000)}km`);
        console.log(`[Ascent] APO: ${Math.round(apoapsis/1000)}km, PER: ${Math.round(periapsis/1000)}km - ${success ? 'ORBIT ACHIEVED' : 'ABORTED'}`);

        return {
          success,
          finalOrbit: { apoapsis, periapsis },
          aborted: !enabled && !inOrbit
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
      const result = await this.conn.execute('PRINT ADDONS:MJ:ASCENT:ENABLED.');
      if (!hasKosError(result.output)) {
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

    // Execute all commands in a single batch
    if (commands.length > 0) {
      await this.conn.execute(commands.join(' '));
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
        desiredAltitude: match ? parseFloat(match[2]) : 0,
        desiredInclination: match ? parseFloat(match[3]) : 0
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
      skipCircularization = false,
      autoWarp = true
    } = options;

    // Wait for MechJeb to be ready (critical after save reload)
    await this.waitForMechJebReady();

    // Configure ascent
    await this.configure({
      desiredAltitude: altitude,
      desiredInclination: inclination,
      autostage: autoStage,
      skipCircularization,
      autowarp: autoWarp
    });

    // Enable autopilot, hand control to MechJeb, and launch in one batch
    await this.conn.execute(
      'SET ADDONS:MJ:ASCENT:ENABLED TO TRUE. ' +
      'UNLOCK THROTTLE. SAS OFF. STAGE.'
    );

    // Verify autopilot engaged (separate query for reliable output)
    await delay(200);  // Brief delay for MechJeb state to update
    const verifyResult = await this.conn.execute('PRINT ADDONS:MJ:ASCENT:ENABLED.');
    const engaged = verifyResult.output.toLowerCase().includes('true');
    if (!engaged) {
      console.log('[Ascent] Warning: Autopilot may not have engaged, but continuing...');
    }
    console.log('[Ascent] LAUNCHED - MechJeb in control');

    // Create handle for monitoring
    const handleId = `ascent-${++this.handleCounter}-${Date.now()}`;
    return new AscentHandle(this.conn, handleId, altitude);
  }
}
