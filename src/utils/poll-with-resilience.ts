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

/** Simple logger interface for progress messages */
interface ProgressLogger {
  progress: (message: string) => void;
}

const nullLogger: ProgressLogger = { progress: () => {} };

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
 */
async function classifyConnectionFailure(
  conn: KosConnection | undefined,
  errorOutput?: string
): Promise<DisconnectReason> {
  // Check error message/output for signal loss indicators
  if (errorOutput && (errorOutput.includes('Signal lost') || errorOutput.includes('signal'))) {
      return 'signal_lost';
    }

  // If we have a connection, try detailed detection
  if (conn) {
    try {
      // Try a health check command with unique marker
      const marker = `POLL_CHECK_${Date.now()}`;
      const result = await conn.execute(`PRINT "${marker}".`, 1500);

      // Check for signal lost message
      if (result.output.includes('Signal lost')) {
        return 'signal_lost';
      }

      // If we got the marker back, connection is actually fine
      if (result.output.includes(marker)) {
        return 'unknown'; // Transient error, not a real disconnect
      }

      // Command echoed but no result - likely signal loss (after first message consumed)
      if (result.output.includes(`PRINT "${marker}"`) && !result.output.includes(marker + '\n')) {
        return 'signal_lost';
      }

      // No response - try Ctrl+D to distinguish power loss from crash
      const canDetach = await conn.tryDetach(2000);
      if (canDetach) {
        return 'power_loss';
      } else {
        return 'crashed';
      }
    } catch {
      // Couldn't even run health check - assume worst case
      return 'crashed';
    }
  }

  return 'unknown';
}

/**
 * Get user-friendly message for disconnect reason.
 */
function getDisconnectMessage(reason: DisconnectReason, context: string): string {
  switch (reason) {
    case 'signal_lost':
      return `[${context}] Radio blackout - autopilot continues autonomously`;
    case 'power_loss':
      return `[${context}] Vessel has no power - waiting for batteries to recharge`;
    case 'crashed':
      return `[${context}] Vessel may have crashed - monitoring stopped`;
    default:
      return `[${context}] Connection lost - waiting to reconnect`;
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
  let lastResult: T | undefined;
  let currentReason: DisconnectReason | undefined;
  let crashConfirmCount = 0;
  const CRASH_CONFIRM_THRESHOLD = 3; // Require multiple crash readings to confirm

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await poll();
      lastResult = result;

      // If we were in blackout, we're back
      if (inBlackout) {
        logger.progress(`[${context}] Signal restored - resuming monitoring`);
        inBlackout = false;
        crashConfirmCount = 0;
      }

      // Call custom poll handler
      if (onPoll) {
        onPoll(result);
      }

      // Check if operation is complete
      if (isDone(result)) {
        return {
          success: isSuccess(result),
          result,
          timedOut: false,
          hadBlackout,
          disconnectReason: currentReason,
        };
      }
    } catch (error) {
      // Connection error - classify the failure
      const errorOutput = error instanceof Error ? error.message : String(error);

      if (!inBlackout) {
        // First failure - classify it
        currentReason = await classifyConnectionFailure(connection, errorOutput);
        logger.progress(getDisconnectMessage(currentReason, context));
        inBlackout = true;
        hadBlackout = true;

        // If crashed, start confirmation counter
        if (currentReason === 'crashed') {
          crashConfirmCount = 1;
        }
      } else if (currentReason === 'crashed') {
        // Already in blackout, re-check if still crashed
        crashConfirmCount++;
        if (crashConfirmCount >= CRASH_CONFIRM_THRESHOLD) {
          // Confirmed crash - abort monitoring
          logger.progress(`[${context}] Vessel crash confirmed - aborting`);
          return {
            success: false,
            result: lastResult,
            timedOut: false,
            hadBlackout: true,
            disconnectReason: 'crashed',
          };
        }
      }

      // For signal_lost or power_loss, keep waiting - autopilot runs on the vessel
    }

    await delay(pollIntervalMs);
  }

  // Timeout - try one final poll
  try {
    const finalResult = await poll();
    return {
      success: isDone(finalResult) && isSuccess(finalResult),
      result: finalResult,
      timedOut: true,
      hadBlackout,
      disconnectReason: currentReason,
    };
  } catch {
    // Still in blackout at timeout
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
