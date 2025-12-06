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
  const conn = getConnection();
  if (!conn.isConnected()) {
    return { success: false, output: '', error: 'Not connected to kOS' };
  }

  // Output is automatically tracked in KosConnection.execute()
  return await conn.execute(input.command, input.timeout);
}

// Tool definitions for MCP registration
export const connectionToolDefinitions = {
  kos_connect: {
    description: 'Connect to kOS terminal server and attach to a CPU',
    inputSchema: connectInputSchema,
    handler: handleConnect,
  },
  kos_disconnect: {
    description: 'Disconnect from kOS terminal',
    inputSchema: z.object({}),
    handler: handleDisconnect,
  },
  kos_status: {
    description: 'Get current kOS connection status',
    inputSchema: z.object({}),
    handler: handleStatus,
  },
  kos_execute: {
    description: 'Execute a raw kOS command (for advanced use)',
    inputSchema: executeInputSchema,
    handler: handleExecute,
  },
};
