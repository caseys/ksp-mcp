import { z } from 'zod';
import { KosConnection, ConnectionState, CommandResult } from '../transport/kos-connection.js';
import { clearAscentHandle } from '../server.js';
import { config } from '../config.js';

// Shared connection instance
let connection: KosConnection | null = null;

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
}

// Delay helper
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Delay after new connection to let kOS stabilize
const POST_CONNECT_DELAY_MS = 500;

// Health check timeout - shorter to detect stale connections faster
const HEALTH_CHECK_TIMEOUT_MS = 1500;

/**
 * Verify connection is healthy by executing a simple command.
 * Returns true if the connection is working, false if stale.
 */
async function isConnectionHealthy(conn: KosConnection): Promise<boolean> {
  try {
    const result = await conn.execute('PRINT 1.', HEALTH_CHECK_TIMEOUT_MS);
    // A healthy connection returns output containing "1"
    // Check both success and output to catch timeout cases
    return result.success && result.output.includes('1');
  } catch {
    return false;
  }
}

/**
 * Force close the connection and reset state.
 * Used when health check fails to ensure clean reconnection.
 */
async function forceDisconnect(): Promise<void> {
  if (connection) {
    try {
      await connection.disconnect();
    } catch {
      // Ignore disconnect errors - we're forcing a reset
    }
    connection = null;
  }
}

/**
 * Ensure connection is established, auto-connecting if needed.
 * @param options Optional CPU selection (cpuId or cpuLabel)
 * @returns The connected KosConnection
 * @throws Error if connection fails
 *
 * Behavior:
 * - If not connected: connects to specified CPU or CPU 0 if not specified
 * - If connected and no options: verifies connection health, reconnects if stale
 * - If connected but different CPU requested: reconnects to requested CPU
 * - After new connection: waits 500ms for kOS to stabilize
 */
export async function ensureConnected(options?: EnsureConnectedOptions): Promise<KosConnection> {
  const conn = getConnection();
  const state = conn.getState();

  // Check if we need to reconnect to a different CPU
  const needsReconnect = options && (
    (options.cpuId !== undefined && options.cpuId !== state.cpuId) ||
    (options.cpuLabel !== undefined && options.cpuLabel !== state.cpuTag)
  );

  if (conn.isConnected() && !needsReconnect) {
    // Verify connection is actually healthy (not stale)
    if (await isConnectionHealthy(conn)) {
      return conn;
    }
    // Connection is stale - force close before reconnecting
    console.log('[ensureConnected] Connection stale, forcing disconnect and reconnecting...');
    await forceDisconnect();
  }

  // Connect (or reconnect) with specified options
  try {
    const connectResult = await handleConnect({
      cpuId: options?.cpuId,
      cpuLabel: options?.cpuLabel,
    });

    if (!connectResult.connected) {
      throw new Error(`Auto-connect failed: ${connectResult.lastError || 'Unknown error'}`);
    }

    // Wait for kOS to stabilize after new connection
    await delay(POST_CONNECT_DELAY_MS);

    return getConnection();
  } catch (error) {
    // If connection failed, force cleanup and re-throw
    await forceDisconnect();
    throw error;
  }
}

export async function handleDisconnect(): Promise<{ disconnected: boolean }> {
  const conn = getConnection();
  await conn.disconnect();
  // Clear ascent handle to prevent stale references
  clearAscentHandle();
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

// Tool definitions for MCP registration
export const connectionToolDefinitions = {
  connect: {
    description: 'Connect to kOS terminal server and attach to a CPU',
    inputSchema: connectInputSchema,
    handler: handleConnect,
  },
  disconnect: {
    description: 'Disconnect from kOS terminal',
    inputSchema: z.object({}),
    handler: handleDisconnect,
  },
  status: {
    description: 'Get current kOS connection status',
    inputSchema: z.object({}),
    handler: handleStatus,
  },
  execute: {
    description: 'Execute a raw kOS command (for advanced use)',
    inputSchema: executeInputSchema,
    handler: handleExecute,
  },
};
