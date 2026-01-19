import { z } from 'zod';
import { KosConnection, ConnectionState, CommandResult } from '../transport/kos-connection.js';
import { config } from '../config/index.js';
import {
  checkDaemonStatus,
  deployDaemon,
  ensureBootFile,
  runDaemon,
  MCP_COMBINED_VERSION,
} from '../utils/boot-deploy.js';

// Shared connection instance
let connection: KosConnection | null = null;

// Track the last connected vessel to detect crashes
interface ConnectedVesselInfo {
  name: string;
  cpuTag: string;
}
let lastConnectedVessel: ConnectedVesselInfo | null = null;

// Runtime CPU preference (overrides config, persists until changed or process stops)
interface CpuPreference {
  cpuId?: number;
  cpuLabel?: string;
}
let cpuPreference: CpuPreference | null = null;

// Cache for daemon status to avoid redundant checks
let lastDaemonCheck: { timestamp: number; running: boolean; version: string | null } | null = null;
const DAEMON_CACHE_TTL_MS = 30_000; // 30 seconds - daemon doesn't change often

// =============================================================================
// MCP-Daemon Boot Script
// =============================================================================

/**
 * Ensure the mcp-daemon boot script is installed and running on the vessel.
 *
 * The daemon is a single boot file (0:/boot/mcp_daemon.ks) that:
 * - Sets up WHEN triggers for autonomous blackout recovery
 * - Stays alive with WAIT UNTIL FALSE so triggers persist
 * - Auto-warps to radio contact when idle in blackout
 *
 * Uses caching to avoid redundant daemon checks on every command.
 */
async function ensureMcpDaemon(conn: KosConnection): Promise<void> {
  try {
    // Use cached status if recent and daemon was running with current version
    const now = Date.now();
    if (lastDaemonCheck &&
        now - lastDaemonCheck.timestamp < DAEMON_CACHE_TTL_MS &&
        lastDaemonCheck.running &&
        lastDaemonCheck.version === MCP_COMBINED_VERSION) {
      // Daemon was recently verified as running and up-to-date, skip check
      return;
    }

    // Check daemon status (includes boot file check)
    const status = await checkDaemonStatus(conn);

    // Update cache
    lastDaemonCheck = {
      timestamp: now,
      running: status.running,
      version: status.version,
    };

    // Always ensure boot file is set (even if daemon is running)
    if (!status.bootFileSet) {
      console.log('[ksp-mcp] Setting boot file...');
      await ensureBootFile(conn);
    }

    // If locally installed and current version, nothing more to do
    // Note: We don't check status.running here - daemon will be restarted
    // by restartDaemon() AFTER the command completes, not before
    if (status.locallyInstalled && !status.needsUpdate) {
      return;
    }

    // Deploy to archive if not locally installed or needs update
    if (!status.locallyInstalled || status.needsUpdate) {
      if (!status.locallyInstalled) {
        console.log(`[ksp-mcp] Installing mcp-daemon v${MCP_COMBINED_VERSION}...`);
      } else {
        console.log(`[ksp-mcp] Updating mcp-daemon v${status.version} -> v${MCP_COMBINED_VERSION}...`);
      }

      const deployResult = await deployDaemon(conn);
      if (!deployResult.success) {
        console.warn('[ksp-mcp] mcp-daemon deployment failed:', deployResult.error);
        // Invalidate cache on failure
        lastDaemonCheck = null;
        return;
      }
      console.log(`[ksp-mcp] Deployed via ${deployResult.method}.`);
    }

    // Copy, compile, reboot ONLY if local scripts missing or need update
    // Do NOT reboot just because daemon isn't running - that's handled by
    // restartDaemon() after command completes
    if (!status.locallyInstalled || status.needsUpdate) {
      try {
        await runDaemon(conn);
        // Brief pause to let it initialize
        await new Promise(resolve => setTimeout(resolve, 200));
        console.log(`[ksp-mcp] mcp-daemon v${MCP_COMBINED_VERSION} installed and started.`);
        // Update cache after successful install
        lastDaemonCheck = {
          timestamp: Date.now(),
          running: true,
          version: MCP_COMBINED_VERSION,
        };
      } catch (error) {
        console.warn('[ksp-mcp] Failed to run mcp-daemon:', error);
        lastDaemonCheck = null;
      }
    }
  } catch (error) {
    console.warn('[ksp-mcp] mcp-daemon setup failed:', error);
    lastDaemonCheck = null;
  }
}

/**
 * Set runtime CPU preference for all subsequent connections.
 * This overrides config.kos.cpuId/cpuLabel until cleared or process stops.
 *
 * @param pref - CPU preference (cpuId or cpuLabel), or null to clear
 */
export function setCpuPreference(pref: CpuPreference | null): void {
  cpuPreference = pref;
}

export function getConnection(): KosConnection {
  if (!connection) {
    connection = new KosConnection();
  }
  return connection;
}

// Input/Output schemas - defaults come from config
export const connectInputSchema = z.object({
  host: z.string().optional().default(config.kos.host).describe('kOS server host'),
  port: z.number().optional().default(config.kos.port).describe('kOS server port'),
  cpuId: z.number().optional().describe('CPU ID to connect to (numeric). If neither cpuId nor cpuLabel provided, auto-selects first CPU.'),
  cpuLabel: z.string().optional().describe('CPU label/tag to connect to (e.g., "guidance"). If neither cpuId nor cpuLabel provided, auto-selects first CPU.'),
  transportType: z.enum(['socket', 'tmux']).optional().describe(`Transport type (default: ${config.transport.type})`),
});
// Note: Both cpuId and cpuLabel are optional - if neither provided, auto-selects first CPU

export const executeInputSchema = z.object({
  command: z.string().describe('kOS command to execute'),
  timeout: z.number().default(config.timeouts.command).describe('Command timeout in milliseconds'),
});

// Tool handlers
export async function handleConnect(
  rawInput: z.input<typeof connectInputSchema>
): Promise<ConnectionState> {
  // Parse input to apply defaults
  const input = connectInputSchema.parse(rawInput);
  // Disconnect existing connection before creating a new one
  // This prevents orphaned telnet/tmux sessions
  if (connection && connection.isConnected()) {
    await connection.disconnect();
  }

  // Create new connection with specified options
  connection = new KosConnection({
    host: input.host,
    port: input.port,
    cpuId: input.cpuId,
    cpuLabel: input.cpuLabel,
    transportType: input.transportType,
  });
  return await connection.connect();
}

export interface EnsureConnectedOptions {
  cpuId?: number;
  cpuLabel?: string;
  /** Enable retry loop (default: false for quick single attempt) */
  retry?: boolean;
  /** Timeout for retry loop in ms (default: 120000 = 2 min) */
  timeoutMs?: number;
  /** Poll interval for retry loop in ms (default: 2000) */
  pollIntervalMs?: number;
  /** Progress callback during retry loop */
  onProgress?: (elapsedMs: number) => void;
  /**
   * Allow returning connection during blackout (default: false).
   * When false, throws an error if vessel has no signal.
   * When true, returns connection with health.reason='signal_lost' set.
   * Use for tools like status that want to return cached data during blackout.
   */
  allowBlackout?: boolean;
}

// Delay helper
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// No delay needed - event-driven waitFor and "Proceed" confirmation ensure readiness
const POST_CONNECT_DELAY_MS = 0;

// Health check timeout - shorter to detect stale connections faster
const HEALTH_CHECK_TIMEOUT_MS = 1500;

// Default wait timeout for kOS to become ready
const DEFAULT_WAIT_TIMEOUT_MS = 120_000; // 2 minutes

// Poll interval when waiting for kOS
const WAIT_POLL_INTERVAL_MS = 2000;

/**
 * Health check result with reason for failure
 */
interface HealthCheckResult {
  healthy: boolean;
  reason?: 'signal_lost' | 'no_response' | 'error';
  output?: string;
}

/**
 * Verify connection is healthy by executing a simple command.
 * Returns detailed result including failure reason.
 *
 * Note: "Signal lost" message only appears once after signal loss.
 * Subsequent commands are echoed but produce no output.
 */
async function checkConnectionHealth(conn: KosConnection): Promise<HealthCheckResult> {
  try {
    // Ctrl+C (clear=true) kills daemon, then we clear MCP_DAEMON_RUNNING so ensureMcpDaemon knows to restart
    // Also check heartbeat and radio status for health verification
    const result = await conn.execute(
      'IF DEFINED MCP_DAEMON_RUNNING { SET MCP_DAEMON_RUNNING TO FALSE. } PRINT "HB:" + (CHOOSE _MCP_HEARTBEAT IF DEFINED _MCP_HEARTBEAT ELSE -1) + " R:" + (CHOOSE _MCP_RADIO IF DEFINED _MCP_RADIO ELSE HOMECONNECTION:ISCONNECTED).',
      HEALTH_CHECK_TIMEOUT_MS,
      { clear: true }
    );

    // Check for radio blackout - signal lost message
    if (result.output.includes('Signal lost')) {
      return { healthy: false, reason: 'signal_lost', output: result.output };
    }

    // Parse heartbeat response: "HB:12345.67 R:True" or "HB:-1 R:True"
    const hbMatch = result.output.match(/HB:([-\d.]+)\s+R:(True|False)/i);
    if (hbMatch) {
      const hasRadio = hbMatch[2].toLowerCase() === 'true';

      if (!hasRadio) {
        return { healthy: false, reason: 'signal_lost', output: result.output };
      }

      // Heartbeat valid (daemon was running) or -1 (daemon not yet started, but radio OK)
      return { healthy: true };
    }

    // Fallback: check for any valid response
    if (result.success && result.output.length > 0) {
      return { healthy: true };
    }

    return { healthy: false, reason: 'no_response', output: result.output };
  } catch {
    return { healthy: false, reason: 'error' };
  }
}

/**
 * Force close the connection and reset state.
 * Used when health check fails to ensure clean reconnection,
 * or when CPU preference is cleared to force auto-selection.
 */
export async function forceDisconnect(): Promise<void> {
  if (connection) {
    try {
      await connection.disconnect();
    } catch {
      // Ignore disconnect errors - we're forcing a reset
    }
    connection = null;
  }
  // Invalidate daemon cache on disconnect (vessel may have changed)
  lastDaemonCheck = null;
  // Note: Don't clear lastConnectedVessel here - we may need it to detect crashes
  // It's cleared in handleDisconnect() for explicit disconnects
}

/**
 * Single connection attempt (internal helper).
 */
async function tryConnect(options?: EnsureConnectedOptions): Promise<KosConnection> {
  const conn = getConnection();
  const state = conn.getState();

  // Priority: runtime preference (set_cpu) > config defaults
  // Per-call options are only used internally; MCP tools use set_cpu for CPU selection
  const effectiveCpuId = options?.cpuId ?? cpuPreference?.cpuId;
  const effectiveCpuLabel = options?.cpuLabel ?? cpuPreference?.cpuLabel;

  // Check if we need to reconnect to a different CPU
  const needsReconnect = (
    (effectiveCpuId !== undefined && effectiveCpuId !== state.cpuId) ||
    (effectiveCpuLabel !== undefined && effectiveCpuLabel !== state.cpuTag)
  );

  if (conn.isConnected() && !needsReconnect) {
    // Verify connection is actually healthy (not stale)
    const healthCheck = await checkConnectionHealth(conn);
    if (healthCheck.healthy) {
      conn.clearHealth();  // Signal recovered
      return conn;
    }
    // Signal lost = radio blackout - connection is fine, just no radio
    if (healthCheck.reason === 'signal_lost') {
      conn.setHealth('signal_lost');  // Mark blackout state
      // Only return connection if caller wants to handle blackout themselves
      if (options?.allowBlackout) {
        return conn;
      }
      // Default: throw error so tools don't hang waiting for kOS
      const vesselName = conn.getState().vesselName || 'Unknown';
      throw new Error(
        `Radio blackout - vessel '${vesselName}' has no signal. ` +
        `Wait for line-of-sight to Kerbin or a relay.`
      );
    }
    // No response is ambiguous - could be blackout, slow response, or buffered output
    // Retry up to 5 times (1 second apart) before concluding it's a problem
    if (healthCheck.reason === 'no_response') {
      for (let retry = 0; retry < 5; retry++) {
        await delay(1000);
        const retryCheck = await checkConnectionHealth(conn);
        if (retryCheck.healthy) {
          conn.clearHealth();
          return conn;
        }
        if (retryCheck.reason === 'signal_lost') {
          conn.setHealth('signal_lost');
          if (options?.allowBlackout) {
            return conn;
          }
          const vesselName = conn.getState().vesselName || 'Unknown';
          throw new Error(
            `Radio blackout - vessel '${vesselName}' has no signal. ` +
            `Wait for line-of-sight to Kerbin or a relay.`
          );
        }
        // Still no_response - continue retrying
      }
      // Still no response after 5 retries - try fresh reconnect
      await forceDisconnect();
    }
    // Other failures (crash, power loss) - disconnect and try fresh reconnect
    await forceDisconnect();
  }

  // Connect (or reconnect) with merged options
  try {
    const connectResult = await handleConnect({
      cpuId: effectiveCpuId,
      cpuLabel: effectiveCpuLabel,
    });

    if (!connectResult.connected) {
      throw new Error(`Auto-connect failed: ${connectResult.lastError || 'Unknown error'}`);
    }

    // Wait for kOS to stabilize after new connection
    await delay(POST_CONNECT_DELAY_MS);

    // Verify fresh connection is healthy - if not, vessel may have crashed or lost signal
    const freshConn = getConnection();
    const healthCheck = await checkConnectionHealth(freshConn);
    if (!healthCheck.healthy) {
      const connectedState = freshConn.getState();
      const vesselName = connectedState.vesselName || lastConnectedVessel?.name || 'Unknown';

      if (healthCheck.reason === 'signal_lost') {
        // Radio blackout - mark state
        freshConn.setHealth('signal_lost');
        // Return connection if caller wants to handle blackout themselves
        if (options?.allowBlackout) {
          return freshConn;
        }
        // Default: throw error so tools don't hang waiting for kOS
        throw new Error(
          `Vessel '${vesselName}' has lost radio signal - waiting to re-acquire. ` +
          `Wait for the vessel to regain line-of-sight to Kerbin or a relay.`
        );
      }

      // No response at all - could be blackout, power loss, or crash
      // If caller wants to handle blackout, return early without slow diagnosis
      if (options?.allowBlackout) {
        // Treat no_response as potential blackout (after "Signal lost" message was already shown)
        freshConn.setHealth('signal_lost', 'Radio blackout - no response from vessel');
        return freshConn;
      }

      // Try Ctrl+D to distinguish power loss from crash
      // Power loss: Ctrl+D returns to CPU menu
      // Crashed: Ctrl+D has no effect, connection stuck
      const canDetach = await freshConn.tryDetach(2000);

      if (canDetach) {
        // Got back to menu - could be power loss OR transient issue
        // Reconnect and retry health check before concluding power loss
        const retryResult = await handleConnect({
          cpuId: effectiveCpuId,
          cpuLabel: effectiveCpuLabel,
        });

        if (retryResult.connected) {
          await delay(POST_CONNECT_DELAY_MS);
          const retryConn = getConnection();
          const retryHealth = await checkConnectionHealth(retryConn);

          if (retryHealth.healthy) {
            // Transient issue - connection is fine now, continue normally
            retryConn.clearHealth();
            const connectedState = retryConn.getState();
            if (connectedState.vesselName) {
              lastConnectedVessel = {
                name: connectedState.vesselName,
                cpuTag: connectedState.cpuTag || '(unnamed)',
              };
            }
            return retryConn;
          }
        }

        // Still failing after retry - now we can conclude power loss
        freshConn.setHealth('power_loss');
        await forceDisconnect();
        throw new Error(
          `Vessel '${vesselName}' appears to have no power - connection works but no response. ` +
          `Wait for batteries to recharge or solar panels to receive sunlight.`
        );
      }

      // Couldn't detach - vessel crashed
      freshConn.setHealth('crashed');
      lastConnectedVessel = null;
      await forceDisconnect();
      throw new Error(
        `Vessel '${vesselName}' appears to have crashed - connection established but no response. ` +
        `Load a save or switch to another vessel.`
      );
    }

    // Connection healthy - clear any stale health state
    const successfulConn = getConnection();
    successfulConn.clearHealth();

    // Save the vessel info for crash detection
    const connectedState = successfulConn.getState();
    if (connectedState.vesselName) {
      lastConnectedVessel = {
        name: connectedState.vesselName,
        cpuTag: connectedState.cpuTag || '(unnamed)',
      };
    }

    // Install and run mcp-daemon if not present (provides blackout recovery)
    // Note: First deployment to a new vessel may take a few seconds
    await ensureMcpDaemon(successfulConn);

    return successfulConn;
  } catch (error) {
    // If connection failed, force cleanup and re-throw
    await forceDisconnect();
    throw error;
  }
}

/**
 * Ensure connection is established, auto-connecting if needed.
 *
 * @param options Configuration options
 * @returns The connected KosConnection
 * @throws Error if connection fails (or timeout if retry enabled)
 *
 * Behavior:
 * - If not connected: connects to specified CPU or CPU 0 if not specified
 * - If connected and no options: verifies connection health, reconnects if stale
 * - If connected but different CPU requested: reconnects to requested CPU
 * - After new connection: waits 500ms for kOS to stabilize
 * - If retry=true: polls until success or timeout (for KSP startup scenarios)
 */
export async function ensureConnected(options?: EnsureConnectedOptions): Promise<KosConnection> {
  // Single attempt mode (default)
  if (!options?.retry) {
    return tryConnect(options);
  }

  // Retry mode - poll until success or timeout
  const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? WAIT_POLL_INTERVAL_MS;

  const startTime = Date.now();
  let lastError: string | null = null;

  while (Date.now() - startTime < timeoutMs) {
    try {
      return await tryConnect(options);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);

      // Report progress if callback provided
      if (options.onProgress) {
        options.onProgress(Date.now() - startTime);
      }

      // Wait before retrying
      await delay(pollIntervalMs);
    }
  }

  throw new Error(
    `Timeout waiting for kOS after ${Math.round(timeoutMs / 1000)}s. ` +
    `Last error: ${lastError ?? 'Unknown'}`
  );
}

/** @deprecated Use ensureConnected({ retry: true }) instead */
export type WaitForKosOptions = EnsureConnectedOptions;

/**
 * Wait for kOS to become ready, with retry logic.
 *
 * This is a convenience wrapper for ensureConnected({ retry: true }).
 * Use this when KSP/kOS might not be ready yet (e.g., after KSP startup).
 *
 * @param options Configuration options
 * @returns The connected KosConnection
 * @throws Error if timeout exceeded
 */
export async function waitForKosReady(options?: EnsureConnectedOptions): Promise<KosConnection> {
  return ensureConnected({ ...options, retry: true });
}

/**
 * Check if kOS is currently reachable without throwing.
 * Returns true if kOS is ready, false otherwise.
 */
export async function isKosReady(options?: EnsureConnectedOptions): Promise<boolean> {
  try {
    await ensureConnected(options);
    return true;
  } catch {
    return false;
  }
}

export async function handleDisconnect(): Promise<{ disconnected: boolean }> {
  const conn = getConnection();
  await conn.disconnect();
  lastConnectedVessel = null; // Clear vessel tracking on explicit disconnect
  return { disconnected: true };
}

export async function handleStatus(): Promise<ConnectionState> {
  const conn = getConnection();
  return conn.getState();
}

export async function handleExecute(
  input: z.infer<typeof executeInputSchema>
): Promise<CommandResult> {
  // Auto-connect if needed
  const conn = await ensureConnected();

  // Output is automatically tracked in KosConnection.execute()
  return await conn.execute(input.command, input.timeout);
}

// ============================================================================
// Tool Definitions
// ============================================================================

import type { ToolDefinition } from '../lib/tool-types.js';

/**
 * Command tool definition
 */
export const commandTool: ToolDefinition = {
  name: 'command',
  description: 'Run raw kOS command.',
  inputSchema: {
    command: z.string().describe('kOS script command to send'),
    timeout: z.number().optional().default(5000).describe('Command timeout in milliseconds'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  tier: 4,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      // Tool wrapper auto-restarts daemon after execution
      const result = await conn.execute(args.command as string, args.timeout as number);

      if (result.success) {
        return ctx.successResponse('command', result.output || '(no output)');
      } else {
        return ctx.errorResponse('command', result.error ?? 'Command failed');
      }
    } catch (error) {
      return ctx.errorResponse('command', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Disconnect tool definition
 */
export const disconnectTool: ToolDefinition = {
  name: 'disconnect',
  description: 'Disconnect from kOS.',
  inputSchema: {},
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 4,
  handler: async (_args, ctx) => {
    try {
      await handleDisconnect();
      return ctx.successResponse('disconnect', 'Disconnected from kOS.');
    } catch (error) {
      return ctx.errorResponse('disconnect', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Switch CPU tool definition
 */
export const switchCpuTool: ToolDefinition = {
  name: 'switch_cpu',
  description: 'Switch kOS CPU.',
  inputSchema: {
    cpuId: z.number().optional().describe('CPU ID (1-based) to switch to'),
    cpuLabel: z.string().optional().describe('CPU label/tag. Use list_cpus to see available CPUs.'),
    clear: z.boolean().optional().describe('Clear preference and revert to auto-select'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 4,
  handler: async (args, ctx) => {
    try {
      if (args.clear) {
        // Clear preference and force reconnect with auto-selection
        setCpuPreference(null);
        await forceDisconnect();
        return ctx.successResponse('switch_cpu', 'CPU preference cleared. Next connection will auto-select.');
      }

      if (args.cpuId !== undefined || args.cpuLabel !== undefined) {
        // Set preference and trigger reconnect
        setCpuPreference({
          cpuId: args.cpuId as number | undefined,
          cpuLabel: args.cpuLabel as string | undefined,
        });

        // Force reconnect with new preference
        await forceDisconnect();
        const conn = await ensureConnected();
        const state = conn.getState();

        return ctx.successResponse('switch_cpu',
          `Switched to CPU ${state.cpuId ?? '?'}: ${state.vesselName ?? 'unknown'} (${state.cpuTag ?? 'unnamed'})`);
      }

      return ctx.errorResponse('switch_cpu', 'Specify cpuId, cpuLabel, or clear=true');
    } catch (error) {
      return ctx.errorResponse('switch_cpu', error instanceof Error ? error.message : String(error));
    }
  },
};

