/**
 * Blackout-Resilient Polling Utility
 *
 * Handles radio blackouts gracefully during long-running operations.
 * When connection is lost, continues waiting instead of failing.
 * MechJeb/kOS autopilots continue running on the vessel during blackout.
 *
 * Distinguishes between:
 * - Radio blackout (signal lost) - vessel fine, just out of range
 * - Power loss - vessel exists but CPU unresponsive (batteries dead)
 * - Vessel crash - vessel destroyed, connection stuck
 */

import type { KosConnection } from '../transport/kos-connection.js';

/** Simple logger interface for progress and debug messages */
interface ProgressLogger {
  progress: (message: string) => void;
  debug: (message: string) => void;
}

const nullLogger: ProgressLogger = { progress: () => {}, debug: () => {} };

/** Reason for connection failure */
export type DisconnectReason = 'signal_lost' | 'power_loss' | 'crashed' | 'unknown';

export interface PollOptions<T> {
  /** Function that polls for status. Throws on connection error. */
  poll: () => Promise<T>;

  /** Returns true when operation is complete (success or failure) */
  isDone: (result: T) => boolean;

  /** Optional: Returns true if result indicates success (for return value) */
  isSuccess?: (result: T) => boolean;

  /** Maximum time to wait in milliseconds */
  timeoutMs: number;

  /** Time between polls in milliseconds */
  pollIntervalMs: number;

  /** Logger for progress messages */
  logger?: ProgressLogger;

  /** Context string for log messages (e.g., "Landing", "Ascent") */
  context?: string;

  /** Optional: Called on each successful poll (for custom logging) */
  onPoll?: (result: T) => void;

  /** Optional: kOS connection for detailed failure classification */
  connection?: KosConnection;

  /** Optional: AbortSignal to cancel the operation (e.g., from MCP client timeout) */
  signal?: AbortSignal;
}

export interface PollResult<T> {
  /** Whether the operation completed successfully */
  success: boolean;

  /** Final result from poll function (if available) */
  result?: T;

  /** True if operation timed out */
  timedOut: boolean;

  /** True if we experienced a blackout during monitoring */
  hadBlackout: boolean;

  /** If connection was lost, the reason why */
  disconnectReason?: DisconnectReason;
}

/**
 * Classify why a connection failed using detailed health checks.
 * Uses the same logic as connection-tools.ts for consistency.
 *
 * IMPORTANT: Be conservative - only report 'crashed' if we're very sure.
 * False positives are worse than false negatives here.
 */
async function classifyConnectionFailure(
  conn: KosConnection | undefined,
  errorOutput?: string
): Promise<DisconnectReason> {
  // Check error message/output for signal loss indicators
  // IMPORTANT: Only match the specific kOS message, not generic 'signal' which causes false positives
  if (errorOutput && errorOutput.includes('Signal lost')) {
    return 'signal_lost';
  }

  // If we have a connection, try a health check
  if (conn) {
    try {
      // Try a health check command with unique marker
      const marker = `POLL_CHECK_${Date.now()}`;
      const result = await conn.execute(`PRINT "${marker}".`, 2000);

      // Check for signal lost message
      if (result.output.includes('Signal lost')) {
        return 'signal_lost';
      }

      // If we got ANY response at all (even without marker), connection is working.
      // This was likely a transient parsing error or timing issue, not a real disconnect.
      // Only truly empty output suggests a real problem.
      if (result.output.trim().length > 0) {
        return 'unknown'; // Transient error, connection is fine
      }

      // Truly empty output - might be signal loss (commands echo but no response)
      return 'signal_lost';
    } catch {
      // Health check threw - connection is broken
      // Try Ctrl+D to distinguish power loss from crash
      try {
        const canDetach = await conn.tryDetach(2000);
        if (canDetach) {
          return 'power_loss';
        } else {
          return 'crashed';
        }
      } catch {
        // Even tryDetach failed - likely crashed
        return 'crashed';
      }
    }
  }

  return 'unknown';
}

/**
 * Get user-friendly message for disconnect reason.
 * Returns null for 'unknown' since those are transient errors that don't need logging.
 */
function getDisconnectMessage(reason: DisconnectReason, context: string): string | null {
  switch (reason) {
    case 'signal_lost':
      return `[${context}] Radio blackout - autopilot continues autonomously`;
    case 'power_loss':
      return `[${context}] Vessel has no power - waiting for batteries to recharge`;
    case 'crashed':
      return `[${context}] Vessel may have crashed - checking...`;
    case 'unknown':
      return null; // Don't log transient errors
    default:
      return null;
  }
}

/**
 * Poll with resilience to radio blackouts.
 *
 * Instead of failing when connection is lost, continues waiting
 * until signal returns or timeout is reached.
 *
 * Distinguishes between signal loss (wait), power loss (wait), and crash (fail).
 */
export async function pollWithBlackoutResilience<T>(
  options: PollOptions<T>
): Promise<PollResult<T>> {
  const {
    poll,
    isDone,
    isSuccess = () => true,
    timeoutMs,
    pollIntervalMs,
    logger = nullLogger,
    context = 'Operation',
    onPoll,
    connection,
  } = options;

  const startTime = Date.now();
  let inBlackout = false;
  let hadBlackout = false;
  let blackoutStartTime = 0;
  let lastBlackoutLogTime = 0;
  const BLACKOUT_LOG_INTERVAL_MS = 30_000; // Log every 30 seconds during blackout
  let lastResult: T | undefined;
  let currentReason: DisconnectReason | undefined;
  let crashConfirmCount = 0;
  const CRASH_CONFIRM_THRESHOLD = 3; // Require multiple crash readings to confirm

  // Lazy classification: only do expensive network classification after multiple failures
  let consecutiveFailures = 0;
  const CLASSIFY_AFTER_FAILURES = 3; // First 2 failures are quick retries

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await poll();
      lastResult = result;
      consecutiveFailures = 0; // Reset on success

      // If we were in blackout, we're back
      if (inBlackout) {
        const blackoutDuration = Math.round((Date.now() - blackoutStartTime) / 1000);
        logger.progress(`[${context}] Signal restored after ${blackoutDuration}s - resuming monitoring`);
        inBlackout = false;
        crashConfirmCount = 0;
      }

      // Call custom poll handler
      if (onPoll) {
        onPoll(result);
      }

      // Check if operation is complete
      if (isDone(result)) {
        // Yield to event loop to flush pending notifications before returning
        await new Promise(resolve => setImmediate(resolve));
        return {
          success: isSuccess(result),
          result,
          timedOut: false,
          hadBlackout,
          disconnectReason: currentReason,
        };
      }
    } catch (error) {
      consecutiveFailures++;
      const errorMsg = error instanceof Error ? error.message : String(error);

      // Lazy classification: for first few failures, assume transient and retry quickly
      // This avoids expensive network-based classification on every hiccup
      if (consecutiveFailures < CLASSIFY_AFTER_FAILURES) {
        logger.debug(`[${context}] Poll timeout (${consecutiveFailures}/${CLASSIFY_AFTER_FAILURES}), retrying...`);
        await delay(200); // Quick retry
        continue;
      }

      // After multiple failures, do full classification
      logger.debug(`[${context}] ${consecutiveFailures} consecutive failures, classifying connection...`);
      const classifyStart = Date.now();
      const reason = await classifyConnectionFailure(connection, errorMsg);
      const classifyMs = Date.now() - classifyStart;
      logger.debug(`[${context}] Classification: ${reason} (${classifyMs}ms)`);

      // 'unknown' = transient error (parsing issue, timing, etc.) - just retry
      if (reason === 'unknown') {
        // Don't log, don't set blackout - continue to next poll iteration
        // Small delay to prevent tight looping and allow I/O to flush
        await delay(100);
        continue;
      }

      if (!inBlackout) {
        // First real failure - log it
        currentReason = reason;
        const message = getDisconnectMessage(reason, context);
        if (message) {
          logger.progress(message);
        }
        inBlackout = true;
        hadBlackout = true;
        blackoutStartTime = Date.now();
        lastBlackoutLogTime = blackoutStartTime;

        // If crashed, start confirmation counter
        if (reason === 'crashed') {
          crashConfirmCount = 1;
        }
      } else {
        // Already in blackout - log periodic status updates
        const now = Date.now();
        if (now - lastBlackoutLogTime >= BLACKOUT_LOG_INTERVAL_MS) {
          const elapsedSec = Math.round((now - blackoutStartTime) / 1000);
          const reasonText = currentReason === 'power_loss' ? 'no power' : 'no signal';
          logger.progress(`[${context}] Still waiting for ${reasonText} (${elapsedSec}s)...`);
          lastBlackoutLogTime = now;
        }

        if (currentReason === 'crashed') {
          // Already in blackout, re-check if still crashed
          crashConfirmCount++;
          if (crashConfirmCount >= CRASH_CONFIRM_THRESHOLD) {
            // Confirmed crash - abort monitoring
            logger.progress(`[${context}] Vessel crash confirmed - aborting`);
            // Yield to event loop to flush pending notifications before returning
            await new Promise(resolve => setImmediate(resolve));
            return {
              success: false,
              result: lastResult,
              timedOut: false,
              hadBlackout: true,
              disconnectReason: 'crashed',
            };
          }
        }
      }

      // For signal_lost or power_loss, keep waiting - autopilot runs on the vessel
    }

    await delay(pollIntervalMs);
  }

  // Timeout - try one final poll
  try {
    const finalResult = await poll();
    // Yield to event loop to flush pending notifications before returning
    await new Promise(resolve => setImmediate(resolve));
    return {
      success: isDone(finalResult) && isSuccess(finalResult),
      result: finalResult,
      timedOut: true,
      hadBlackout,
      disconnectReason: currentReason,
    };
  } catch {
    // Still in blackout at timeout
    // Yield to event loop to flush pending notifications before returning
    await new Promise(resolve => setImmediate(resolve));
    return {
      success: false,
      result: lastResult,
      timedOut: true,
      hadBlackout,
      disconnectReason: currentReason,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
