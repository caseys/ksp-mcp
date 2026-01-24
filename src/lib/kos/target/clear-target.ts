/**
 * Clear Target - Clear navigation target
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import type { ToolDefinition } from '../../tool-types.js';
import type { ClearTargetResult } from './types.js';
import { bringKspToForeground } from '../../../utils/bring-to-foreground.js';

/**
 * Clear the current navigation target (if any)
 *
 * WARNING: There is a known kOS bug where `SET TARGET TO ""` does not
 * always clear the target on the first attempt. See docs/kos-clear-target.md.
 * This method brings KSP to foreground first (target switching is locked when backgrounded),
 * then tries five times with delays to work around the intermittent bug.
 *
 * @param conn kOS connection
 */
export async function clearTarget(conn: KosConnection): Promise<ClearTargetResult> {
  // KSP locks target switching when backgrounded - bring to foreground first
  await bringKspToForeground();

  // Try clearing five times with delays - the kOS bug is intermittent
  const result = await conn.queue(
    'SET TARGET TO "". WAIT 0.2. SET TARGET TO "". WAIT 0.2. SET TARGET TO "". WAIT 0.2. SET TARGET TO "". WAIT 0.2. SET TARGET TO "". WAIT 0.2. PRINT "CLEARED:" + (NOT HASTARGET).',
    5000
  );

  const cleared = result.success && result.output.toLowerCase().includes('cleared:true');

  if (!cleared) {
    return {
      success: true,  // Command executed
      cleared: false,
      warning: 'The documented approach to clear target (SET TARGET TO "") may not work. ' +
               'See: https://ksp-kos.github.io/KOS/commands/flight/systems.html#global:TARGET'
    };
  }

  return { success: true, cleared: true };
}

// ============================================================================
// Tool Definition
// ============================================================================

export const clearTargetTool: ToolDefinition = {
  name: 'clear_target',
  description: 'Clear navigation target.',
  inputSchema: {},
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 2,
  handler: async (_args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const result = await clearTarget(conn);

      if (result.cleared) {
        return ctx.successResponse('clear_target', 'Target cleared.');
      }

      return ctx.successResponse('clear_target', result.warning ?? 'Clear command sent.');
    } catch (error) {
      return ctx.errorResponse('clear_target', error instanceof Error ? error.message : String(error));
    }
  },
};
