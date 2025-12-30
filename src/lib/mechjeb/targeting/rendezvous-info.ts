/**
 * Get Rendezvous Info - Query phase angle, closest approach, and node times
 */

import type { ToolDefinition } from '../../tool-types.js';
import { targetSchema } from '../../tool-types.js';
import { setTarget } from '../../kos/target/set-target.js';
import { getRendezvousInfo,  } from './shared.js';

// ============================================================================
// Tool Definition
// ============================================================================

export const getRendezvousInfoTool: ToolDefinition = {
  name: 'get_rendezvous_info',
  description:
    'Get rendezvous data: phase angle, closest approach time/distance, relative inclination, ' +
    'and time to orbital nodes. Optionally specify target, or uses current target.',
  inputSchema: {
    target: targetSchema,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 2,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();

      // Set target if provided
      const target = args.target as string | undefined;
      if (target) {
        const setResult = await setTarget(conn, target);
        if (!setResult.success) {
          return ctx.errorResponse('get_rendezvous_info', setResult.error ?? 'Failed to set target');
        }
      }

      const info = await getRendezvousInfo(conn);

      if (!info) {
        return ctx.errorResponse(
          'get_rendezvous_info',
          'No target set or target is a position (not body/vessel). Specify target or use set_target first.'
        );
      }

      return ctx.successResponse('get_rendezvous_info', info.formatted);
    } catch (error) {
      return ctx.errorResponse(
        'get_rendezvous_info',
        error instanceof Error ? error.message : String(error)
      );
    }
  },
};

// Re-export for library use


export {type RendezvousInfo, getRendezvousInfo} from './shared.js';