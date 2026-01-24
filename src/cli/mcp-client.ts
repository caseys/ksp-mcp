/**
 * MCP Client for CLI
 *
 * Connects to ksp-mcp via HTTP transport for server reuse.
 * Spawns server in background if not running, with idle timeout for auto-cleanup.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the main ksp-mcp entry point
const KSP_MCP_PATH = resolve(__dirname, '../../dist/index.js');

// Server configuration
const SERVER_HOST = '127.0.0.1';
const SERVER_PORT = 3000;
const SERVER_URL = `http://${SERVER_HOST}:${SERVER_PORT}/mcp`;
const IDLE_TIMEOUT_SECS = 30;

export interface ToolResult {
  success: boolean;
  content: string;
  isError?: boolean;
}

export interface Tool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * MCP Client wrapper for CLI use.
 * Uses HTTP transport to connect to a shared server instance.
 */
export class McpCliClient {
  private client: Client;
  private transport: StreamableHTTPClientTransport | null = null;
  private connected = false;

  constructor() {
    this.client = new Client(
      { name: 'ksp-mcp-cli', version: '1.0.0' },
      { capabilities: {} }
    );
  }

  /**
   * Try to connect to an existing server
   */
  private async tryConnect(): Promise<boolean> {
    try {
      this.transport = new StreamableHTTPClientTransport(new URL(SERVER_URL));
      await this.client.connect(this.transport);
      this.connected = true;
      return true;
    } catch {
      this.transport = null;
      return false;
    }
  }

  /**
   * Spawn the MCP server in background with idle timeout
   */
  private spawnServer(): void {
    const serverProcess = spawn('node', [
      KSP_MCP_PATH,
      '--transport', 'http',
      '--host', SERVER_HOST,
      '--port', String(SERVER_PORT),
      `--idle-timeout=${IDLE_TIMEOUT_SECS}`,
    ], {
      detached: true,
      stdio: 'ignore',
      env: process.env as Record<string, string>,
    });
    serverProcess.unref();
  }

  /**
   * Connect to the MCP server.
   * Tries existing server first, spawns new one if needed.
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    // Try existing server first
    if (await this.tryConnect()) {
      return;
    }

    // Spawn server in background
    this.spawnServer();

    // Wait for server to start and retry
    const maxRetries = 10;
    const retryDelay = 200;
    for (let i = 0; i < maxRetries; i++) {
      await new Promise(r => setTimeout(r, retryDelay));
      if (await this.tryConnect()) {
        return;
      }
    }

    throw new Error(`Failed to connect to MCP server at ${SERVER_URL}`);
  }

  /**
   * Disconnect from the MCP server
   */
  async disconnect(): Promise<void> {
    if (!this.connected || !this.transport) return;

    await this.transport.close();
    this.transport = null;
    this.connected = false;
  }

  /**
   * List all available tools
   */
  async listTools(): Promise<Tool[]> {
    await this.connect();

    const result = await this.client.listTools();
    return result.tools as Tool[];
  }

  /**
   * Call a tool by name with arguments.
   * Sends a progressToken to receive progress notifications during long operations.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    await this.connect();

    // Generate a unique progress token for this call
    const progressToken = randomUUID();

    // Call tool with progress token and timeout reset enabled
    const result = await this.client.callTool(
      {
        name,
        arguments: args,
        _meta: { progressToken },
      },
      CallToolResultSchema,
      {
        // Handle progress notifications - display them to stderr
        onprogress: (progress) => {
          if (progress.message) {
            // Progress messages go to stderr (same as server console.error)
            process.stderr.write(`${progress.message}\n`);
          }
        },
        // Reset timeout when receiving progress (keeps connection alive)
        resetTimeoutOnProgress: true,
        // Long timeout for operations like crash_avoidance (10 minutes)
        timeout: 600_000,
      }
    );

    // Handle the result - it could have 'content' array or 'toolResult'
    let content: string;
    let isError = false;

    if ('content' in result && Array.isArray(result.content)) {
      // Extract text content from result
      const textContent = result.content.find((c: { type: string }) => c.type === 'text');
      content = textContent && 'text' in textContent ? (textContent as { text: string }).text : JSON.stringify(result.content);
      isError = result.isError === true;
    } else if ('toolResult' in result) {
      content = typeof result.toolResult === 'string' ? result.toolResult : JSON.stringify(result.toolResult);
    } else {
      content = JSON.stringify(result);
    }

    return {
      success: !isError,
      content,
      isError,
    };
  }
}

/**
 * Singleton instance for CLI commands
 */
let clientInstance: McpCliClient | null = null;

/**
 * Get the shared MCP client instance
 */
export function getClient(): McpCliClient {
  if (!clientInstance) {
    clientInstance = new McpCliClient();
  }
  return clientInstance;
}

/**
 * Helper: Call a tool and return the result
 */
export async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const client = getClient();
  try {
    return await client.callTool(name, args);
  } finally {
    // Don't disconnect here - keep connection alive for multiple calls
  }
}

/**
 * Helper: List all available tools
 */
export async function listTools(): Promise<Tool[]> {
  const client = getClient();
  return client.listTools();
}

/**
 * Cleanup: Disconnect and cleanup resources
 */
export async function cleanup(): Promise<void> {
  if (clientInstance) {
    await clientInstance.disconnect();
    clientInstance = null;
  }
}
