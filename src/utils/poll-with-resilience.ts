/**
 * Blackout-Resilient Polling Utility
 *
 * When connection is lost during a long-running operation:
 * 1. Protect the TCP socket (suppressReset) so we can watch for recovery
 * 2. Check peekBuffer() for "Signal lost" text — early detection
 * 3. On confirmed blackout: launch independent probe connection
 * 4. Probe polls with concatenated markers until radio returns
 * 5. Return to caller — caller does forceDisconnect() + ensureConnected()
 *
 * kOS autopilots (MechJeb, WHEN triggers) continue running during blackout.
 */

import type { KosConnection } from '../transport/kos-connection.js';
import { SocketTransport } from '../transport/socket-transport.js';
import { config } from '../config/index.js';

/** Simple logger interface for progress and debug messages */
interface ProgressLogger {
  progress: (message: string) => void;
  debug: (message: string) => void;
}

const nullLogger: ProgressLogger = { progress: () => {}, debug: () => {} };

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

  /** Optional: kOS connection for blackout detection and probe recovery */
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
}

/**
 * Launch an independent probe connection to detect radio return.
 *
 * The probe connects to kOS telnet on a separate TCP socket, selects the
 * same CPU, and polls with concatenated PRINT markers. During blackout,
 * commands echo but produce no output — so only a complete marker in the
 * response means radio is back.
 *
 * Also watches the original transport's peekBuffer() for "Choose a CPU"
 * which kOS sends on the existing connection when radio returns.
 *
 * @returns true if radio contact was restored
 */
export async function probeForRadioReturn(
  conn: KosConnection,
  logger: ProgressLogger,
  context: string,
  timeoutMs: number = 300_000,
): Promise<boolean> {
  const transport = conn.getTransport();
  const cpuId = conn.getState().cpuId;
  let recovered = false;

  const probe = new SocketTransport(config.kos.host, config.kos.port);
  try {
    await probe.init();
    await probe.waitFor('Choose a CPU', 5000);
    logger.progress(`[${context}] Probe: kOS alive, selecting CPU ${cpuId}...`);

    await probe.send(String(cpuId) + '\r\n');
    await new Promise(r => setTimeout(r, 1000));
    await probe.read(); // Clear attach output + Signal lost text

    const maxIterations = Math.floor(timeoutMs / 1000);
    for (let i = 0; i < maxIterations; i++) {
      await delay(1000);

      // Check original transport for "Choose a CPU" (radio returned)
      if (transport?.isOpen()) {
        const origBuf = transport.peekBuffer();
        if (origBuf.includes('Choose a CPU')) {
          logger.progress(`[${context}] Original connection: radio returned! Reattaching...`);
          await transport.read();
          await transport.send(String(cpuId) + '\r\n');
          await new Promise(r => setTimeout(r, 500));
          await transport.read();
          // Verify with concatenated marker
          const vMarker = `BL_${Date.now()}`;
          await transport.send(`PRINT "["+"${vMarker}"+"]".\n`);
          try {
            await transport.waitFor(`[${vMarker}]`, 3000);
            recovered = true;
            break;
          } catch {
            logger.progress(`[${context}] Reattach verify failed`);
          }
        }
      }

      // Probe: send PRINT with concatenated marker
      const ts = Date.now();
      await probe.send(`PRINT "["+"PROBE_${ts}"+"]".\n`);
      try {
        await probe.waitFor(`[PROBE_${ts}]`, 2000);
        logger.progress(`[${context}] Probe: radio returned!`);
        // Wait for original connection to get "Choose a CPU"
        await delay(3000);
        // Check original again
        if (transport?.isOpen()) {
          const origBuf = transport.peekBuffer();
          if (origBuf.includes('Choose a CPU')) {
            await transport.read();
            await transport.send(String(cpuId) + '\r\n');
            await new Promise(r => setTimeout(r, 500));
            await transport.read();
            const vMarker = `BL_${Date.now()}`;
            await transport.send(`PRINT "["+"${vMarker}"+"]".\n`);
            try {
              await transport.waitFor(`[${vMarker}]`, 3000);
              recovered = true;
            } catch { /* verify failed */ }
          }
        }
        if (!recovered) {
          logger.progress(`[${context}] Probe confirmed radio, original transport needs reconnect`);
          recovered = true;
        }
        break;
      } catch {
        // Still in blackout
      }

      if (i % 10 === 9) {
        logger.progress(`[${context}] Still in blackout... (${i + 1}s)`);
      }
    }
  } catch (err) {
    logger.progress(`[${context}] Probe failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await probe.close().catch(() => {});
  }

  return recovered;
}

/**
 * Poll with resilience to radio blackouts.
 *
 * On connection failure:
 * 1. Protects TCP socket with suppressReset
 * 2. Checks peekBuffer() for "Signal lost" (early detection)
 * 3. After 3 consecutive failures, launches probe to detect radio return
 * 4. Returns { hadBlackout: true } — caller reconnects and decides next steps
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
  let lastResult: T | undefined;
  let consecutiveFailures = 0;

  // Protect TCP socket from resetConnection() during polling
  if (connection) {
    connection.suppressReset = true;
  }

  try {
    while (Date.now() - startTime < timeoutMs) {
      // Early blackout detection: check buffer for "Signal lost" text
      if (connection) {
        const transport = connection.getTransport();
        if (transport) {
          const buf = transport.peekBuffer();
          if (buf.includes('Signal lost')) {
            logger.progress(`[${context}] Blackout detected (Signal lost) — launching probe...`);

            const remaining = timeoutMs - (Date.now() - startTime);
            await probeForRadioReturn(connection, logger, context, remaining);

            return {
              success: false,
              result: lastResult,
              timedOut: false,
              hadBlackout: true,
            };
          }
        }
      }

      try {
        const result = await poll();
        lastResult = result;
        consecutiveFailures = 0;

        // Call custom poll handler
        if (onPoll) {
          try {
            await onPoll(result);
          } catch (onPollError) {
            logger.debug(`[${context}] Handler error (will retry): ${onPollError instanceof Error ? onPollError.message : onPollError}`);
          }
        }

        // Check if operation is complete
        if (isDone(result)) {
          await new Promise(resolve => setImmediate(resolve));
          return {
            success: isSuccess(result),
            result,
            timedOut: false,
            hadBlackout: false,
          };
        }
      } catch {
        consecutiveFailures++;

        // First 2 failures: quick retry (transient)
        if (consecutiveFailures < 3) {
          await delay(200);
          continue;
        }

        // 3+ failures: confirmed blackout — launch probe
        logger.progress(`[${context}] Signal lost — launching probe...`);

        if (connection) {
          const remaining = timeoutMs - (Date.now() - startTime);
          await probeForRadioReturn(connection, logger, context, remaining);
        }

        return {
          success: false,
          result: lastResult,
          timedOut: false,
          hadBlackout: true,
        };
      }

      await delay(pollIntervalMs);
    }

    // Timeout — try one final poll
    try {
      const finalResult = await poll();
      await new Promise(resolve => setImmediate(resolve));
      return {
        success: isDone(finalResult) && isSuccess(finalResult),
        result: finalResult,
        timedOut: true,
        hadBlackout: false,
      };
    } catch {
      await new Promise(resolve => setImmediate(resolve));
      return {
        success: false,
        result: lastResult,
        timedOut: true,
        hadBlackout: false,
      };
    }
  } finally {
    if (connection) {
      connection.suppressReset = false;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
