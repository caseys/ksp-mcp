import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest, ProgressToken } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  getConnection,
  ensureConnected,
} from '../transport/connection-tools.js';
import {
  CONNECTION_GUIDE,
  CPU_MENU_FORMAT,
  TRANSPORT_OPTIONS,
} from '../config/mcp-resources.js';
import { getStatus, type ShipTelemetryOptions } from '../lib/mechjeb/telemetry.js';
import { ManeuverOrchestrator } from '../lib/mechjeb/orchestrator.js';
import { globalKosMonitor } from '../utils/kos-monitor.js';
import { listQuicksaves } from '../lib/kos/kuniverse.js';
import { registerAllTools } from '../lib/tool-registry.js';
import type { ToolContext, TargetSelectMode, OrbitInfo } from '../lib/tool-types.js';

const FULL_TELEMETRY_OPTIONS: ShipTelemetryOptions = {
  timeoutMs: 3000,  // Per-query timeout for standalone telemetry (max 2 queries = 6s max)
};

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
 * Create a progress callback from the MCP request handler extra context.
 * Sends MCP progress notifications to keep the connection alive during long operations.
 * Falls back to logging notifications if client doesn't provide a progressToken.
 *
 * @param extra The RequestHandlerExtra from the tool callback
 * @returns A callback function that sends progress or logging notifications
 */
function createProgressCallback(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): (message: string) => void {
  const progressToken = extra._meta?.progressToken as ProgressToken | undefined;

  if (progressToken) {
    // Client requested progress updates - use progress notifications
    let progressCount = 0;
    return (message: string) => {
      progressCount++;
      extra.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken,
          progress: progressCount,
          message,
        },
      }).catch(() => {}); // Fire and forget
    };
  } else {
    // No progressToken - fall back to logging notifications
    return (message: string) => {
      extra.sendNotification({
        method: 'notifications/message',
        params: {
          level: 'info',
          logger: 'ksp-mcp',
          data: message,
        },
      }).catch(() => {}); // Fire and forget
    };
  }
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
 * Get current orbit info (periapsis, apoapsis, altitude)
 */
async function getOrbitInfo(conn: ReturnType<typeof getConnection> | null): Promise<OrbitInfo | null> {
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

/**
 * Get default launch altitude: atmosphere height + 20km, or 20km if no atmosphere
 */
async function getDefaultLaunchAltitude(conn: ReturnType<typeof getConnection> | null): Promise<number> {
  const DEFAULT_ALTITUDE = 80_000; // 80km fallback (Kerbin-like)
  if (!conn) return DEFAULT_ALTITUDE;
  try {
    const result = await conn.execute(
      'IF SHIP:BODY:ATM:EXISTS { PRINT SHIP:BODY:ATM:HEIGHT. } ELSE { PRINT 0. }',
      3000
    );
    const match = result.output.match(/([\d.]+)/);
    if (match) {
      const atmHeight = parseFloat(match[1]);
      return atmHeight > 0 ? atmHeight + 20_000 : 20_000;
    }
  } catch {
    // Ignore errors
  }
  return DEFAULT_ALTITUDE;
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
    createProgressCallback,
    successResponse,
    errorResponse,
    selectTarget,
    getDefaultLaunchAltitude,
    getOrbitInfo,
  };

  // Register all tools from the tool registry
  registerAllTools(server, context);

  // =============================================================================
  // MCP Resources (documentation)
  // =============================================================================

  server.resource(
    'kos-connection-guide',
    'kos://connection-guide',
    async () => ({
      contents: [{
        uri: 'kos://connection-guide',
        mimeType: 'text/markdown',
        text: CONNECTION_GUIDE,
      }],
    })
  );

  server.resource(
    'kos-cpu-menu-format',
    'kos://cpu-menu-format',
    async () => ({
      contents: [{
        uri: 'kos://cpu-menu-format',
        mimeType: 'text/markdown',
        text: CPU_MENU_FORMAT,
      }],
    })
  );

  server.resource(
    'kos-transport-options',
    'kos://transport-options',
    async () => ({
      contents: [{
        uri: 'kos://transport-options',
        mimeType: 'text/markdown',
        text: TRANSPORT_OPTIONS,
      }],
    })
  );

  // =============================================================================
  // Monitoring resources
  // =============================================================================

  server.resource(
    'kos-status',
    'kos://status',
    async () => {
      const conn = getConnection();
      const connState = conn?.getState();
      const status = globalKosMonitor.getStatus();

      return {
        contents: [{
          uri: 'kos://status',
          mimeType: 'application/json',
          text: JSON.stringify({
            connected: conn?.isConnected() || false,
            cpuId: connState?.cpuId || null,
            vessel: connState?.vesselName || null,
            lastError: status.lastError,
            errorCount: status.errorCount,
            isLooping: status.isLooping,
            hasErrors: status.hasErrors,
          }, null, 2),
        }],
      };
    }
  );

  server.resource(
    'kos-terminal-recent',
    'kos://terminal/recent',
    async () => {
      const status = globalKosMonitor.getStatus();

      return {
        contents: [{
          uri: 'kos://terminal/recent',
          mimeType: 'application/json',
          text: JSON.stringify({
            recentLines: status.recentLines,
            hasErrors: status.hasErrors,
            isLooping: status.isLooping,
            errorPattern: status.errorPattern,
            errorCount: status.errorCount,
            summary: globalKosMonitor.getSummary(),
          }, null, 2),
        }],
      };
    }
  );

  // =============================================================================
  // KSP Data Resources (live game data)
  // =============================================================================

  server.resource(
    'status',
    'ksp://status',
    async () => {
      const status = await getStatus(undefined, FULL_TELEMETRY_OPTIONS);
      return {
        contents: [{
          uri: 'ksp://status',
          mimeType: 'application/json',
          text: JSON.stringify(status, null, 2),
        }],
      };
    }
  );

  server.resource(
    'targets',
    'ksp://targets',
    async () => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.listTargets();
        return {
          contents: [{
            uri: 'ksp://targets',
            mimeType: 'application/json',
            text: JSON.stringify({
              moons: result.moons,
              planets: result.planets,
              vessels: result.vessels,
              formatted: result.formatted,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          contents: [{
            uri: 'ksp://targets',
            mimeType: 'application/json',
            text: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              moons: [],
              planets: [],
              vessels: [],
            }, null, 2),
          }],
        };
      }
    }
  );

  server.resource(
    'target',
    'ksp://target',
    async () => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const info = await orchestrator.getTargetInfo();
        return {
          contents: [{
            uri: 'ksp://target',
            mimeType: 'application/json',
            text: JSON.stringify(info, null, 2),
          }],
        };
      } catch (error) {
        return {
          contents: [{
            uri: 'ksp://target',
            mimeType: 'application/json',
            text: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              hasTarget: false,
            }, null, 2),
          }],
        };
      }
    }
  );

  server.resource(
    'saves',
    'ksp://saves',
    async () => {
      try {
        const conn = await ensureConnected();
        const result = await listQuicksaves(conn);
        return {
          contents: [{
            uri: 'ksp://saves',
            mimeType: 'application/json',
            text: JSON.stringify({
              success: result.success,
              saves: result.saves,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          contents: [{
            uri: 'ksp://saves',
            mimeType: 'application/json',
            text: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              saves: [],
            }, null, 2),
          }],
        };
      }
    }
  );

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
