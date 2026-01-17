/**
 * Tool Registry
 *
 * Central registry that collects all tool definitions and registers them with the MCP server.
 * Includes operation guard to prevent conflicting operations.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDefinition, ToolContext } from './tool-types.js';
import { getKosOperation } from '../utils/kos-operation-state.js';

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
import { loadSaveTool, listSavesTool, quicksaveTool } from './kos/kuniverse.js';
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
  'list_cpus',
  'abort_operation',
  'continue_operation',
  // MechJeb landing (read-only)
  'get_landing_prediction',
]);

/**
 * All registered tools.
 * Each tool file exports a toolDefinition that is imported and added here.
 */
export const allTools: ToolDefinition[] = [
  // Tier 1 - Core Mission Operations
  landTool,
  launchAscentTool,
  circularizeTool,
  inclinationTool,
  transferTool,
  adjustOrbitTool,
  courseCorrectTool,
  warpTool,
  statusTool,

  // Tier 2 - Maneuvers & Orbital Changes
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
  crashAvoidanceTool,
  executeNodeTool,
  clearNodesTool,

  // Tier 3 - Targeting & Landing Config
  getTargetInfoTool,
  getTargetsTool,
  setTargetTool,
  setPositionTargetTool,
  clearTargetTool,
  findLandingSiteTool,
  configureLandingTool,
  getLandingPredictionTool,

  // Tier 4 - Utility & Low-Level
  abortOperationTool,
  continueOperationTool,
  runScriptTool,
  loadSaveTool,
  listSavesTool,
  quicksaveTool,
  listCpusTool,
  switchCpuTool,
  commandTool,
  disconnectTool,
];

/**
 * Register all tools with the MCP server.
 * Includes operation guard to prevent conflicting concurrent operations.
 */
export function registerAllTools(server: McpServer, context: ToolContext): void {
  for (const tool of allTools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        _meta: { tier: tool.tier },
      },
      async (args, extra) => {
        // Check operation guard (exempt certain tools)
        if (!GUARD_EXEMPT_TOOLS.has(tool.name)) {
          const conn = context.getConnection();
          if (conn) {
            const activeOp = await getKosOperation(conn);
            if (activeOp && activeOp.toolName !== tool.name) {
              const duration = Math.round(activeOp.duration);
              return {
                isError: true,
                content: [{
                  type: 'text' as const,
                  text: `Cannot run ${tool.name}: ${activeOp.toolName} is currently executing (${duration}s). Use abort_operation to cancel, or continue_operation to subscribe to notifications.`,
                }],
              };
            }
          }
        }

        // Execute tool handler
        const result = await tool.handler(args as Record<string, unknown>, context, extra);

        // Auto-restart daemon after tool execution (keeps daemon running for blackout recovery)
        // Fire-and-forget: don't block response to user
        context.restartDaemon();

        return result;
      }
    );
  }
}
