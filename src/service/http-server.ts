/**
 * MCP HTTP Server
 *
 * ARCHITECTURE NOTE: Keep this file thin!
 * - This file handles MCP server setup and request routing only
 * - Tool-specific logic belongs in the tool handler files (src/lib/mechjeb/*)
 * - Tool-specific messages and guidance belong in tool files, not here
 * - The orchestrator is for shared execution patterns, not tool-specific behavior
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  getConnection,
  ensureConnected,
} from '../transport/connection-tools.js';
import { runDaemon } from '../utils/boot-deploy.js';
import { config } from '../config/index.js';
import { isClaudeClient, type ClientInfo } from '../lib/tool-types.js';
import { ManeuverOrchestrator } from '../lib/mechjeb/orchestrator.js';
import { createLogger } from '../utils/mcp-logger.js';
import { registerAllTools } from '../lib/tool-registry.js';
import { registerAllResources } from '../lib/resources/index.js';
import type { ToolContext, TargetSelectMode, OrbitInfo } from '../lib/tool-types.js';


const DEBUG = process.env.KSP_MCP_DEBUG === '1';

/**
 * Helper to create a success response.
 */
function successResponse(action: string, text: string) {
  return {
    content: [{ type: 'text' as const, text }],
  };
}

/**
 * Helper to create an error response.
 * In debug mode, includes the raw error details.
 */
function errorResponse(action: string, error: string) {
  const text = DEBUG ? `${action}: ${error}` : error;
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  };
}

/**
 * Auto-select a target based on mode.
 * Returns null if a target is already set (unless checkExisting=false) or no suitable target found.
 */
async function selectTarget(
  orchestrator: ManeuverOrchestrator,
  mode: TargetSelectMode,
  checkExisting: boolean = true
): Promise<string | null> {
  // Check if target already set
  if (checkExisting && await orchestrator.hasTarget()) {
    return null; // Already has target, no auto-select needed
  }

  // Get all targets sorted by distance
  const targets = await orchestrator.listTargets();

  // Combine moons and planets for body selection (already excludes current body)
  const allBodies = [...targets.moons, ...targets.planets];

  switch (mode) {
    case 'closest-body':
      return allBodies[0]?.name ?? null;

    case 'closest-vessel':
      return targets.vessels[0]?.name ?? null;

    case 'furthest-body':
      return allBodies.at(-1)?.name ?? null;

    case 'second-closest':
      return allBodies[1]?.name ?? allBodies[0]?.name ?? null;

    default:
      return null;
  }
}

/**
 * Get basic orbit info for tool context (periapsis, apoapsis, altitude)
 * Note: This is a simpler helper than the full getOrbitInfo from telemetry.ts
 */
async function getBasicOrbitInfo(conn: ReturnType<typeof getConnection> | null): Promise<OrbitInfo | null> {
  if (!conn) return null;
  try {
    const result = await conn.execute(
      'PRINT SHIP:ORBIT:PERIAPSIS + "|" + SHIP:ORBIT:APOAPSIS + "|" + SHIP:ALTITUDE.',
      3000
    );
    const match = result.output.match(/([\d.]+)\|([\d.]+)\|([\d.]+)/);
    if (match) {
      return {
        periapsis: parseFloat(match[1]),
        apoapsis: parseFloat(match[2]),
        altitude: parseFloat(match[3]),
      };
    }
  } catch {
    // Ignore errors
  }
  return null;
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'ksp-mcp',
    version: '0.3.0',
  });

  // Create tool context with shared utilities
  const context: ToolContext = {
    ensureConnected,
    getConnection,
    createLogger,
    successResponse,
    errorResponse,
    selectTarget,
    getBasicOrbitInfo,
    /**
     * Check if the MCP client supports notifications well.
     * Detection priority:
     * 1. MCP_NOTIFY env var (explicit override)
     * 2. HTTP user-agent header (web clients)
     * 3. MCP client info from initialize request (stdio clients)
     * 4. Fallback to true (assume notification support)
     */
    supportsNotifications: (extra: RequestHandlerExtra<ServerRequest, ServerNotification>): boolean => {
      // 1. Check explicit config override
      if (config.mcp.notifyConfigured) {
        if (DEBUG) console.error(`[supportsNotifications] MCP_NOTIFY configured: ${config.mcp.notify}`);
        return config.mcp.notify;
      }

      // 2. Check HTTP user-agent header (available for HTTP transport)
      const userAgent = (extra as { requestInfo?: { headers?: Map<string, string> } }).requestInfo?.headers?.get?.('user-agent');
      if (userAgent) {
        const supports = !userAgent.toLowerCase().includes('claude');
        if (DEBUG) console.error(`[supportsNotifications] HTTP user-agent "${userAgent}" -> ${supports}`);
        return supports;
      }

      // 3. Check stdio client info from MCP SDK initialize request
      // Use server.server to access the underlying Server class with getClientVersion
      const clientInfo = server.server.getClientVersion?.() as ClientInfo | undefined;
      if (DEBUG) console.error(`[supportsNotifications] clientInfo: ${JSON.stringify(clientInfo)}`);
      if (clientInfo?.name) {
        const supports = !isClaudeClient(clientInfo);
        if (DEBUG) console.error(`[supportsNotifications] client "${clientInfo.name}" -> ${supports}`);
        return supports;
      }

      // 4. Fallback - assume notification support
      if (DEBUG) console.error(`[supportsNotifications] fallback -> true`);
      return true;
    },
    restartDaemon: async () => {
      try {
        const conn = getConnection();
        if (conn.isConnected()) {
          await runDaemon(conn);
        }
      } catch {
        // Best effort - don't fail the tool if daemon restart fails
      }
    },
  };

  // Register all tools from the tool registry
  registerAllTools(server, context);

  // Register all resources
  registerAllResources(server, { getConnection, ensureConnected });

  // =============================================================================
  // MCP Prompts (workflow templates)
  // =============================================================================

  server.prompt(
    'launch-to-orbit',
    {
      altitude: z.string().optional().describe('Target orbit altitude (e.g., "100km")'),
    },
    async (args) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Launch to ${args.altitude || '80km'} circular orbit:

1. Use the launch_ascent tool with altitude=${args.altitude || '80000'}
2. Wait for orbit insertion (the tool blocks until complete)
3. If orbit is not circular, use circularize tool

The launch_ascent tool handles staging, gravity turn, and fairing deployment automatically.`,
        },
      }],
    })
  );

  server.prompt(
    'transfer-to-moon',
    {
      target: z.string().describe('Target moon (Mun or Minmus)'),
    },
    async (args) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Transfer to ${args.target}:

1. set_target to "${args.target}"
2. hohmann_transfer - plans and executes the transfer burn
3. If no SOI encounter after burn, use course_correct to fine-tune
4. warp to SOI change
5. circularize at destination

Note: hohmann_transfer will report if it achieves an encounter or just a close approach.
If you get a close approach warning, course_correct should establish the encounter.`,
        },
      }],
    })
  );

  server.prompt(
    'return-to-kerbin',
    {
      targetPeriapsis: z.string().optional().describe('Kerbin periapsis (e.g., "40km")'),
    },
    async (args) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Return to Kerbin with ${args.targetPeriapsis || '40km'} periapsis:

1. return_from_moon - plans and executes escape burn back to Kerbin
2. warp to Kerbin SOI
3. If needed, adjust_periapsis to set reentry altitude

For aerobraking/landing, target 30-40km periapsis.
For capture into orbit, target higher periapsis (70km+) and circularize.`,
        },
      }],
    })
  );

  return server;
}
