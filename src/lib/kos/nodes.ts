/**
 * Maneuver Node Operations
 *
 * Library functions for managing maneuver nodes.
 */

import type { KosConnection } from '../../transport/kos-connection.js';

export interface ClearNodesResult {
  success: boolean;
  nodesCleared: number;
  error?: string;
}

/**
 * Clear all maneuver nodes.
 *
 * @param conn kOS connection
 * @returns Result with count of nodes cleared
 */
export async function clearNodes(conn: KosConnection): Promise<ClearNodesResult> {
  try {
    const result = await conn.execute(
      'SET _N TO ALLNODES:LENGTH. UNTIL NOT HASNODE { REMOVE NEXTNODE. } PRINT "CLEARED|" + _N.',
      5000
    );

    const match = result.output.match(/CLEARED\|(\d+)/);
    const nodesCleared = match ? Number.parseInt(match[1], 10) : 0;

    return { success: true, nodesCleared };
  } catch (error) {
    return {
      success: false,
      nodesCleared: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// Tool Definition
// ============================================================================

import type { ToolDefinition } from '../tool-types.js';

/**
 * Clear nodes tool definition
 */
export const clearNodesTool: ToolDefinition = {
  name: 'clear_nodes',
  description: 'Delete all planned maneuvers.',
  inputSchema: {},
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 3,
  handler: async (_args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const result = await clearNodes(conn);

      if (result.success) {
        return ctx.successResponse('clear_nodes', `Cleared ${result.nodesCleared} node(s)`);
      } else {
        return ctx.errorResponse('clear_nodes', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('clear_nodes', error instanceof Error ? error.message : String(error));
    }
  },
};
