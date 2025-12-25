/**
 * MCP Client for CLI
 *
 * Spawns ksp-mcp in stdio mode and communicates via MCP protocol.
 * This allows CLI to use the same tool definitions as MCP clients.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to the main ksp-mcp entry point
const KSP_MCP_PATH = resolve(__dirname, '../../dist/index.js');

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
 * Creates a subprocess running ksp-mcp in stdio mode.
 */
export class McpCliClient {
  private client: Client;
  private transport: StdioClientTransport;
  private connected = false;

  constructor() {
    this.client = new Client(
      { name: 'ksp-mcp-cli', version: '1.0.0' },
      { capabilities: {} }
    );

    this.transport = new StdioClientTransport({
      command: 'node',
      args: [KSP_MCP_PATH],
      stderr: 'inherit', // Show server errors
    });
  }

  /**
   * Connect to the MCP server (spawns subprocess)
   */
  async connect(): Promise<void> {
    if (this.connected) return;

    await this.client.connect(this.transport);
    this.connected = true;
  }

  /**
   * Disconnect from the MCP server
   */
  async disconnect(): Promise<void> {
    if (!this.connected) return;

    await this.transport.close();
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
   * Call a tool by name with arguments
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    await this.connect();

    const result = await this.client.callTool({ name, arguments: args });

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
