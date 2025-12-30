/**
 * Blackout-Resilient Polling Utility
 *
 * Handles radio blackouts gracefully during long-running operations.
 * When connection is lost, continues waiting instead of failing.
 * MechJeb/kOS autopilots continue running on the vessel during blackout.
 */

/** Simple logger interface for progress messages */
interface ProgressLogger {
  progress: (message: string) => void;
}

const nullLogger: ProgressLogger = { progress: () => {} };

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
}

/**
 * Poll with resilience to radio blackouts.
 *
 * Instead of failing when connection is lost, continues waiting
 * until signal returns or timeout is reached.
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
  } = options;

  const startTime = Date.now();
  let inBlackout = false;
  let hadBlackout = false;
  let lastResult: T | undefined;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const result = await poll();
      lastResult = result;

      // If we were in blackout, we're back
      if (inBlackout) {
        logger.progress(`[${context}] Signal restored - resuming monitoring`);
        inBlackout = false;
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
        };
      }
    } catch {
      // Connection error - likely radio blackout
      if (!inBlackout) {
        logger.progress(`[${context}] Radio blackout - autopilot continues autonomously`);
        inBlackout = true;
        hadBlackout = true;
      }
      // Keep waiting - autopilot runs on the vessel
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
    };
  } catch {
    // Still in blackout at timeout
    return {
      success: false,
      result: lastResult,
      timedOut: true,
      hadBlackout,
    };
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
