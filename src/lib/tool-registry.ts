/**
 * Tool Registry
 *
 * Central registry that collects all tool definitions and registers them with the MCP server.
 * Includes operation guard to prevent conflicting operations.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDefinition, ToolContext } from './tool-types.js';
import { getActiveOperation, clearActiveOperation } from '../utils/operation-state.js';

// Import tool definitions from lib files

// MechJeb basic maneuver tools
import {
  circularizeTool,
  adjustApoapsisTool,
  adjustPeriapsisTool,
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

// MechJeb targeting tools
import {
  setPositionTargetTool,
  getRendezvousInfoTool,
  getTargetOrbitTool,
  getTargetPositionTool,
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
  getTargetTool,
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

/**
 * Abort operation tool - cancels the currently running operation.
 */
const abortOperationTool: ToolDefinition = {
  name: 'abort_operation',
  description: 'Cancel the currently running operation. Use if something goes wrong or you need to stop.',
  inputSchema: {},
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 3,
  handler: async (_args, context) => {
    const activeOp = getActiveOperation();
    if (!activeOp) {
      return context.successResponse('Abort', 'No operation is currently running.');
    }

    const toolName = activeOp.toolName;
    const duration = Math.round((Date.now() - activeOp.startedAt) / 1000);

    clearActiveOperation();

    return context.successResponse('Abort',
      `Aborted ${toolName} after ${duration}s. Note: KSP may still be executing - use SAS or manual control.`
    );
  },
};

/**
 * Tools that are exempt from the operation guard.
 * - Read-only tools: can always check status
 * - abort_operation: must always work to cancel running ops
 */
const GUARD_EXEMPT_TOOLS = new Set([
  'status',
  'get_target',
  'get_targets',
  'list_saves',
  'list_cpus',
  'abort_operation',
  // MechJeb targeting (read-only)
  'get_rendezvous_info',
  'get_target_orbit',
  'get_target_position',
  // MechJeb landing (read-only)
  'get_landing_prediction',
]);

/**
 * All registered tools.
 * Each tool file exports a toolDefinition that is imported and added here.
 */
export const allTools: ToolDefinition[] = [
  // Core/Status
  statusTool,
  abortOperationTool,

  // Maneuver Planning (Tier 1 - Most Common)
  launchAscentTool,
  circularizeTool,
  hohmannTransferTool,
  courseCorrectTool,
  matchPlanesTool,
  executeNodeTool,
  crashAvoidanceTool,
  landTool,

  // Maneuver Planning (Tier 2 - Common)
  adjustApoapsisTool,
  adjustPeriapsisTool,
  ellipticizeTool,
  changeInclinationTool,
  matchVelocitiesTool,
  interplanetaryTransferTool,
  returnFromMoonTool,
  resonantOrbitTool,
  warpTool,
  getTargetTool,
  getTargetsTool,
  loadSaveTool,
  listSavesTool,
  quicksaveTool,
  listCpusTool,
  // MechJeb targeting (Tier 2)
  setPositionTargetTool,
  getRendezvousInfoTool,
  findLandingSiteTool,
  // MechJeb landing (Tier 2)
  configureLandingTool,
  getLandingPredictionTool,

  // Advanced (Tier 3)
  changeAscendingNodeTool,
  changePeriapsisLongitudeTool,
  changeSemiMajorAxisTool,
  changeEccentricityTool,
  setTargetTool,
  clearTargetTool,
  clearNodesTool,
  commandTool,
  disconnectTool,
  switchCpuTool,
  runScriptTool,
  // MechJeb targeting (Tier 3)
  getTargetOrbitTool,
  getTargetPositionTool,
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
      (args, extra) => {
        // Check operation guard (exempt certain tools)
        if (!GUARD_EXEMPT_TOOLS.has(tool.name)) {
          const activeOp = getActiveOperation();
          if (activeOp && activeOp.toolName !== tool.name) {
            const duration = Math.round((Date.now() - activeOp.startedAt) / 1000);
            return {
              isError: true,
              content: [{
                type: 'text' as const,
                text: `Cannot run ${tool.name}: ${activeOp.toolName} is currently executing (${duration}s). Wait for completion or use abort_operation.`,
              }],
            };
          }
        }

        return tool.handler(args as Record<string, unknown>, context, extra);
      }
    );
  }
}
