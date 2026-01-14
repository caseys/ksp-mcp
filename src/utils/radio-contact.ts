/**
 * Radio Contact Prediction and Warp-to-Signal Utilities
 *
 * Provides functions to:
 * - Check if vessel is in radio blackout
 * - Predict when radio contact will be available
 * - Warp to next radio contact window
 *
 * Used for pre-operation checks in tools like adjust_orbit.
 */

import type { KosConnection } from '../transport/kos-connection.js';
import type { McpLogger } from '../lib/tool-types.js';
import { formatTime } from '../lib/utils/format.js';

export interface RadioContactPrediction {
  hasContactNow: boolean;
  /** Seconds until contact, or -1 if not found, or -2 if permanent blackout */
  secondsUntilContact: number;
  /** Reason for -2 result */
  permanentBlackoutReason?: string;
}

export interface WarpToRadioResult {
  success: boolean;
  warpedSeconds?: number;
  error?: string;
}

/**
 * Check if currently in radio blackout.
 */
export async function isInRadioBlackout(conn: KosConnection): Promise<boolean> {
  const result = await conn.execute('PRINT HOMECONNECTION:ISCONNECTED.', 3000);
  return !result.output.includes('True');
}

/**
 * Predict when radio contact will be available.
 *
 * Uses the same algorithm as the safety monitor's KSP_MCP_FIND_RADIO function:
 * - For orbiting vessels: searches vessel orbital positions
 * - For landed vessels: searches based on body rotation
 * - For landed on tidally locked dark side: returns -2 (permanent blackout)
 *
 * @returns Prediction with secondsUntilContact (>0 = found, -1 = not found, -2 = permanent)
 */
export async function predictRadioContact(
  conn: KosConnection
): Promise<RadioContactPrediction> {
  // Check current status first
  const currentResult = await conn.execute('PRINT HOMECONNECTION:ISCONNECTED.', 3000);
  if (currentResult.output.includes('True')) {
    return { hasContactNow: true, secondsUntilContact: 0 };
  }

  // Run the same prediction algorithm as the safety monitor
  // This is the kOS script embedded in the safety monitor, but we run it explicitly here
  const script = `
LOCAL sb IS SHIP:BODY.
LOCAL is_tidal IS ABS(sb:ROTATIONPERIOD - sb:ORBIT:PERIOD) / sb:ORBIT:PERIOD < 1e-5.
IF is_tidal AND (SHIP:STATUS = "LANDED" OR SHIP:STATUS = "SPLASHED") {
  LOCAL uv IS (SHIP:POSITION - sb:POSITION):NORMALIZED.
  LOCAL ka IS VANG(uv, BODY("Kerbin"):POSITION - SHIP:POSITION).
  IF ka > 90 { PRINT "RADIO|-2|TIDAL_DARK". }
  ELSE { PRINT "RADIO|0|TIDAL_LIGHT". }
} ELSE {
  LOCAL max_dt IS CHOOSE SHIP:ORBIT:PERIOD IF SHIP:STATUS = "ORBITING" ELSE sb:ROTATIONPERIOD.
  LOCAL step IS MAX(30, max_dt / 60).
  LOCAL dt IS step.
  LOCAL found IS FALSE.
  LOCAL result_dt IS -1.
  UNTIL dt > max_dt OR found {
    LOCAL ut IS TIME:SECONDS + dt.
    LOCAL fp IS POSITIONAT(SHIP, ut).
    LOCAL uv IS (fp - sb:POSITION):NORMALIZED.
    LOCAL kp IS POSITIONAT(BODY("Kerbin"), ut).
    LOCAL ka IS VANG(uv, kp - fp).
    IF ka < 72 { SET found TO TRUE. SET result_dt TO dt. }
    SET dt TO dt + step.
  }
  IF found { PRINT "RADIO|" + ROUND(result_dt) + "|FOUND". }
  ELSE { PRINT "RADIO|-1|NOTFOUND". }
}
`.trim().replaceAll('\n', ' ');

  const result = await conn.execute(script, 30_000);

  // Parse result: RADIO|seconds|reason
  const match = result.output.match(/RADIO\|(-?\d+)\|(\w+)/);
  if (!match) {
    // Failed to parse - assume we're connected (conservative)
    return { hasContactNow: false, secondsUntilContact: -1 };
  }

  const seconds = parseInt(match[1], 10);
  const reason = match[2];

  if (seconds === -2) {
    return {
      hasContactNow: false,
      secondsUntilContact: -2,
      permanentBlackoutReason: 'Landed on dark side of tidally locked body',
    };
  }

  if (seconds === 0 && reason === 'TIDAL_LIGHT') {
    // On light side of tidally locked body - should have contact
    return { hasContactNow: true, secondsUntilContact: 0 };
  }

  return {
    hasContactNow: false,
    secondsUntilContact: seconds,
  };
}

/**
 * Warp to next radio contact window.
 *
 * @param conn kOS connection
 * @param options Optional logger and context
 * @returns Result with success status and warp duration
 */
export async function warpToRadioContact(
  conn: KosConnection,
  options?: { logger?: McpLogger; context?: string }
): Promise<WarpToRadioResult> {
  const logger = options?.logger;
  const context = options?.context ?? 'RadioWarp';

  // Check if already connected
  const isBlackout = await isInRadioBlackout(conn);
  if (!isBlackout) {
    return { success: true, warpedSeconds: 0 };
  }

  // Predict when contact will be available
  const prediction = await predictRadioContact(conn);

  if (prediction.secondsUntilContact === -2) {
    return {
      success: false,
      error: `Permanent blackout: ${prediction.permanentBlackoutReason}`,
    };
  }

  if (prediction.secondsUntilContact === -1) {
    return {
      success: false,
      error: 'No radio contact window found within search range',
    };
  }

  if (prediction.secondsUntilContact <= 0) {
    // Should already have contact
    return { success: true, warpedSeconds: 0 };
  }

  // Warp to contact
  const warpSeconds = prediction.secondsUntilContact;
  logger?.progress(`[${context}] No radio - warping ${formatTime(warpSeconds)} to contact...`);

  await conn.execute(`KUNIVERSE:TIMEWARP:WARPTO(TIME:SECONDS + ${warpSeconds}).`, 5000);

  // Wait for warp to complete
  let waitCount = 0;
  const maxWait = 600; // 10 minutes max
  while (waitCount < maxWait) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    waitCount++;

    const warpCheck = await conn.execute('PRINT KUNIVERSE:TIMEWARP:RATE.', 2000);
    const rate = parseFloat(warpCheck.output.match(/[\d.]+/)?.[0] || '1');
    if (rate <= 1) break;
  }

  // Verify we have contact now
  const finalCheck = await isInRadioBlackout(conn);
  if (finalCheck) {
    logger?.warn?.(`[${context}] Warp complete but still no signal`);
    return {
      success: false,
      warpedSeconds: warpSeconds,
      error: 'Warp complete but still no radio contact',
    };
  }

  logger?.progress(`[${context}] Signal restored after ${formatTime(warpSeconds)} warp`);
  return { success: true, warpedSeconds: warpSeconds };
}

/**
 * Check if vessel will be in radio blackout at a specific future time.
 *
 * Uses Kerbin visibility angle calculation at the future vessel position.
 * Angle < 72° means Kerbin is visible (has radio contact).
 *
 * @param conn kOS connection
 * @param secondsFromNow Seconds in the future to check
 * @returns true if vessel will be in blackout at that time
 */
export async function willBeInBlackoutAt(
  conn: KosConnection,
  secondsFromNow: number
): Promise<boolean> {
  // If checking current time, use direct check
  if (secondsFromNow <= 0) {
    return isInRadioBlackout(conn);
  }

  const script = `
LOCAL ut IS TIME:SECONDS + ${secondsFromNow}.
LOCAL sb IS SHIP:BODY.
LOCAL fp IS POSITIONAT(SHIP, ut).
LOCAL uv IS (fp - sb:POSITION):NORMALIZED.
LOCAL kp IS POSITIONAT(BODY("Kerbin"), ut).
LOCAL ka IS VANG(uv, kp - fp).
PRINT "RADIOCHECK|" + ROUND(ka) + "|" + (CHOOSE "BLACKOUT" IF ka >= 72 ELSE "HASRADIO").
`.trim().replaceAll('\n', ' ');

  const result = await conn.execute(script, 10_000);
  // Parse "RADIOCHECK|angle|status" format
  const match = result.output.match(/RADIOCHECK\|(\d+)\|(\w+)/);
  if (match) {
    const angle = parseInt(match[1]);
    const status = match[2];
    console.error(`[willBeInBlackoutAt] T+${secondsFromNow.toFixed(0)}s: angle=${angle}°, status=${status}`);
    return status === 'BLACKOUT';
  }
  // Fallback to old parsing
  return result.output.includes('BLACKOUT');
}

/**
 * Ensure radio contact before proceeding.
 *
 * If in blackout, warps to contact. Returns error if contact cannot be established.
 *
 * @param conn kOS connection
 * @param options Optional logger and context
 */
export async function ensureRadioContact(
  conn: KosConnection,
  options?: { logger?: McpLogger; context?: string }
): Promise<WarpToRadioResult> {
  const isBlackout = await isInRadioBlackout(conn);
  if (!isBlackout) {
    return { success: true, warpedSeconds: 0 };
  }

  return warpToRadioContact(conn, options);
}
