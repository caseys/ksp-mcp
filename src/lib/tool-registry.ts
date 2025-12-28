/**
 * Tool Registry
 *
 * Central registry that collects all tool definitions and registers them with the MCP server.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolDefinition, ToolContext } from './tool-types.js';

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
 * All registered tools.
 * Each tool file exports a toolDefinition that is imported and added here.
 */
export const allTools: ToolDefinition[] = [
  // Core/Status
  statusTool,

  // Maneuver Planning (Tier 1 - Most Common)
  launchAscentTool,
  circularizeTool,
  hohmannTransferTool,
  courseCorrectTool,
  matchPlanesTool,
  executeNodeTool,
  crashAvoidanceTool,

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
];

/**
 * Register all tools with the MCP server.
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
      (args, extra) => tool.handler(args as Record<string, unknown>, context, extra)
    );
  }
}
