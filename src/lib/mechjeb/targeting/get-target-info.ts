/**
 * Get Target Info - Unified target information tool
 *
 * Combines orbit, position, velocity, and rendezvous data in one efficient query.
 */

import type { ToolDefinition } from '../../tool-types.js';
import { targetSchema } from '../../tool-types.js';
import { setTarget } from '../../kos/target/set-target.js';
import { getUnifiedTargetInfo } from './shared.js';

// ============================================================================
// Tool Definition
// ============================================================================

export const getTargetInfoTool: ToolDefinition = {
  name: 'get_target_info',
  description:
    'Get comprehensive target information: orbit, position, velocity, and rendezvous data. ' +
    'Optionally specify target, or uses current target.',
  inputSchema: {
    target: targetSchema,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 3,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();

      // Set target if provided
      const target = args.target as string | undefined;
      if (target) {
        const setResult = await setTarget(conn, target);
        if (!setResult.success) {
          return ctx.errorResponse('get_target_info', setResult.error ?? 'Failed to set target');
        }
      }

      const info = await getUnifiedTargetInfo(conn);

      if (!info.hasTarget) {
        return ctx.errorResponse('get_target_info', info.formatted);
      }

      return ctx.successResponse('get_target_info', info.formatted);
    } catch (error) {
      return ctx.errorResponse(
        'get_target_info',
        error instanceof Error ? error.message : String(error)
      );
    }
  },
};

// Re-export for library use
export { type UnifiedTargetInfo, getUnifiedTargetInfo } from './shared.js';
