/**
 * Tool Registry
 *
 * Central registry that collects all tool definitions and registers them with the MCP server.
 * Includes operation guard to prevent conflicting operations.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDefinition, ToolContext } from './tool-types.js';
import { getKosOperation, clearKosOperation } from '../utils/kos-operation-state.js';
import { getOperationProgressFromKosOp } from './mechjeb/telemetry.js';
import { addBroadcastSubscriber, getActiveBroadcastLogger } from '../utils/mcp-logger.js';

// Import tool definitions from lib files

// MechJeb basic maneuver tools
import {
  circularizeTool,
  ellipticizeTool,
  changeSemiMajorAxisTool,
} from './mechjeb/basic/index.js';

// MechJeb orbital orientation tools
import {
  changeInclinationTool,
  changeEccentricityTool,
  changeAscendingNodeTool,
  changePeriapsisLongitudeTool,
} from './mechjeb/orbital/index.js';

// MechJeb rendezvous tools
import {
  matchPlanesTool,
  matchVelocitiesTool,
} from './mechjeb/rendezvous/index.js';

// MechJeb transfer tools
import {
  hohmannTransferTool,
  courseCorrectTool,
  resonantOrbitTool,
  returnFromMoonTool,
  interplanetaryTransferTool,
} from './mechjeb/transfer/index.js';

// Meta tools (smart routing wrappers)
import {
  transferTool,
  inclinationTool,
  adjustOrbitTool,
} from './mechjeb/meta/index.js';

// MechJeb targeting tools
import {
  setPositionTargetTool,
  getTargetInfoTool,
} from './mechjeb/targeting/index.js';

// MechJeb landing tools
import {
  landTool,
  configureLandingTool,
  getLandingPredictionTool,
  findLandingSiteTool,
} from './mechjeb/landing/index.js';

// kOS target tools (pure kOS, no MechJeb)
import {
  setTargetTool,
  getTargetsTool,
  clearTargetTool,
} from './kos/target/index.js';

// MechJeb ascent tools
import { launchAscentTool } from './mechjeb/ascent.js';

// MechJeb execute node tools
import { executeNodeTool } from './mechjeb/execute-node.js';

// MechJeb telemetry tools
import { statusTool } from './mechjeb/telemetry.js';

// kOS tools
import { clearNodesTool } from './kos/nodes.js';
import { warpTool } from './kos/warp.js';
import { crashAvoidanceTool } from './kos/crash-avoidance.js';
import { loadSaveTool, listSavesTool, quicksaveTool, listShipsTool, loadShipTool, switchVesselTool } from './kos/kuniverse.js';
import { runScriptTool } from './kos/run-script.js';

// Connection tools
import { commandTool, disconnectTool, switchCpuTool } from '../transport/connection-tools.js';
import { listCpusTool } from '../transport/list-cpus.js';

// Abort and continue operation tools
import { abortOperationTool } from './abort-operation.js';
import { continueOperationTool } from './continue-operation.js';

/**
 * Tools that are exempt from the operation guard.
 * - Read-only tools: can always check status
 * - abort_operation: must always work to cancel running ops
 */
const GUARD_EXEMPT_TOOLS = new Set([
  'status',
  'get_target_info',
  'get_targets',
  'list_saves',
  'list_ships',
  'list_cpus',
  'abort_operation',
  'continue_operation',
  // MechJeb landing (read-only)
  'get_landing_prediction',
  // Low-level kOS command (debugging)
  'command',
]);

/**
 * All registered tools.
 * Each tool file exports a toolDefinition that is imported and added here.
 */
export const allTools: ToolDefinition[] = [
  // === TIER 1 - Core Mission Operations (LLM-ready) ===
  landTool,
  launchAscentTool,
  circularizeTool,
  inclinationTool,
  transferTool,
  adjustOrbitTool,
  courseCorrectTool,
  warpTool,

  // === TIER 2 - Utility Tools (LLM-ready) ===
  statusTool,
  executeNodeTool,
  clearNodesTool,
  setTargetTool,
  clearTargetTool,
  getTargetInfoTool,
  getTargetsTool,
  runScriptTool,
  commandTool,
  listCpusTool,
  switchCpuTool,
  loadSaveTool,
  listSavesTool,
  quicksaveTool,
  listShipsTool,
  loadShipTool,
  switchVesselTool,

  // === TIER -1 - Low-level Orbital (Hidden from LLM) ===
  crashAvoidanceTool,
  matchVelocitiesTool,
  matchPlanesTool,
  ellipticizeTool,
  resonantOrbitTool,
  hohmannTransferTool,
  interplanetaryTransferTool,
  returnFromMoonTool,
  changeInclinationTool,
  changeAscendingNodeTool,
  changePeriapsisLongitudeTool,
  changeSemiMajorAxisTool,
  changeEccentricityTool,

  // === TIER -2 - Landing Config (Hidden from LLM) ===
  setPositionTargetTool,
  findLandingSiteTool,
  configureLandingTool,
  getLandingPredictionTool,

  // === TIER -3 - Internal Operations (Hidden from LLM) ===
  abortOperationTool,
  continueOperationTool,
  disconnectTool,
];

/**
 * Register all tools with the MCP server.
 * Includes operation guard to prevent conflicting concurrent operations.
 *
 * Only tools with positive tiers (1, 2, etc.) are registered with MCP.
 * Negative tier tools (-1, -2, -3) are hidden from LLM but still accessible
 * internally via the allTools array.
 */
export function registerAllTools(server: McpServer, context: ToolContext): void {
  // Only register tools with positive tiers to MCP (LLM-ready tools)
  const llmTools = allTools.filter(tool => tool.tier > 0);

  for (const tool of llmTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        _meta: { tier: tool.tier },
      },
      async (args, extra) => {
        // Smart operation guard with auto-recovery from stale operations
        if (!GUARD_EXEMPT_TOOLS.has(tool.name)) {
          const conn = context.getConnection();
          if (conn) {
            const activeOp = await getKosOperation(conn);
            if (activeOp) {
              const isSameTool = activeOp.toolName === tool.name;
              const isStale = activeOp.duration > 600; // 10 minutes

              // Check if MechJeb autopilot is actually still running
              // Use getOperationProgressFromKosOp to avoid redundant status query
              const progress = await getOperationProgressFromKosOp(conn, activeOp);
              const isRunning = progress.running;

              if (!isRunning) {
                // Operation completed or failed - clear and proceed
                await clearKosOperation(conn);
              } else if (!isSameTool) {
                // Different tool requested - clear and proceed
                await clearKosOperation(conn);
              } else if (isStale) {
                // Same tool but stale (>10 min) - clear and proceed
                await clearKosOperation(conn);
              } else {
                // Same tool, <10 min, still running - subscribe to broadcast
                const broadcastLogger = getActiveBroadcastLogger();
                if (broadcastLogger) {
                  addBroadcastSubscriber(extra);
                  const duration = Math.round(activeOp.duration);
                  return {
                    content: [{
                      type: 'text' as const,
                      text: `${tool.name} is already running (${duration}s). Subscribed to progress notifications.\nTarget: ${activeOp.target || 'N/A'}`,
                    }],
                  };
                }
                // No broadcast logger means operation lost its logger (shouldn't happen)
                await clearKosOperation(conn);
              }
            }
          }
        }

        // Execute tool handler
        const result = await tool.handler(args as Record<string, unknown>, context, extra);

        return result;
      }
    );
  }
}
