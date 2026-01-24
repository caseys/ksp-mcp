/**
 * Set Target - Set navigation target
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import type { ToolDefinition } from '../../tool-types.js';
import { parseTarget } from '../../tool-types.js';
import type { SetTargetResult } from './types.js';
import { listTargets } from './get-targets.js';

/**
 * Internal implementation of setTarget with quick confirmation.
 */
async function setTargetInternal(
  conn: KosConnection,
  name: string,
  type: 'body' | 'vessel'
): Promise<SetTargetResult> {
  // Build the SET TARGET command based on type
  const setCmd = type === 'body'
    ? `SET TARGET TO BODY("${name}").`
    : `SET TARGET TO VESSEL("${name}").`;

  // Single atomic kOS command that:
  // 1. Sets the target
  // 2. Brief wait for game to process (0.1s is enough)
  // 3. Reports result immediately - no polling needed
  // Note: Target setting is synchronous in KSP; if it didn't work after 0.1s, it won't work.
  const atomicCmd = [
    setCmd,
    'WAIT 0.1.',
    'IF HASTARGET { PRINT "TARGET_OK|" + TARGET:NAME + "|" + TARGET:TYPENAME. }',
    'ELSE { PRINT "TARGET_FAILED". }',
  ].join(' ');

  const result = await conn.queue(atomicCmd, 5000);
  const output = result.success ? result.output : '';

  // Only success case: explicit TARGET_OK marker
  const okMatch = output.match(/TARGET_OK\|([^|]+)\|(\w+)/);
  if (okMatch) {
    const [, targetName, targetType] = okMatch;
    return { success: true, name: targetName, type: targetType };
  }

  // Everything else is failure - fetch available targets for helpful error
  let availableTargets = '';
  try {
    const targets = await listTargets(conn);
    const moonNames = targets.moons.map(m => m.name).join(', ');
    const planetNames = targets.planets.map(p => p.name).join(', ');
    const vesselNames = targets.vessels.map(v => v.name).join(', ');
    if (moonNames || planetNames) {
      if (moonNames) availableTargets += `\nMoons: ${moonNames}`;
      if (planetNames) availableTargets += `\nPlanets: ${planetNames}`;
      if (vesselNames) availableTargets += `\nVessels: ${vesselNames}`;
    } else {
      // listTargets returned empty - include raw output for debugging
      availableTargets = `\nlistTargets returned 0 bodies (parsing may have failed)`;
    }
  } catch (err) {
    availableTargets = `\nFailed to list targets: ${err instanceof Error ? err.message : String(err)}`;
  }
  return {
    success: false,
    error: `Target "${name}" not found.${availableTargets}`
  };
}

/**
 * Set the navigation target (celestial body or vessel).
 *
 * Uses an atomic kOS command with built-in confirmation polling:
 * - Sets the target
 * - Waits up to 10s for HASTARGET to become true
 * - Returns confirmed target name and type from kOS
 *
 * @param conn kOS connection
 * @param name Target name (e.g., "Mun", "Minmus", or vessel name)
 * @param type 'auto' tries body first then vessel, 'body' for celestial bodies, 'vessel' for ships
 */
export async function setTarget(
  conn: KosConnection,
  name: string,
  type: 'auto' | 'body' | 'vessel' = 'body'
): Promise<SetTargetResult> {
  // For 'auto' mode, try body first, then fall back to vessel
  if (type === 'auto') {
    const bodyResult = await setTargetInternal(conn, name, 'body');
    if (bodyResult.success) {
      return bodyResult;
    }
    // Body failed, try vessel
    return setTargetInternal(conn, name, 'vessel');
  }

  return setTargetInternal(conn, name, type);
}

// ============================================================================
// Tool Definition
// ============================================================================

export const setTargetTool: ToolDefinition = {
  name: 'set_target',
  description: 'Set navigation target.',
  inputSchema: {
    name: z.preprocess(parseTarget, z.union([z.string(), z.literal('auto')]))
      .optional()
      .default('auto')
      .describe('Target name. Use get_targets to list available names. (default: 2nd closest body)'),
    type: z.enum(['auto', 'body', 'vessel']).optional().default('auto')
      .describe('Target type: "auto" tries name directly, "body" for celestial bodies, "vessel" for ships'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  tier: 2,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();

      // Resolve 'auto' to 2nd closest body
      let name = args.name as string;
      if (name === 'auto') {
        // Import dynamically to avoid circular dependency
        const { ManeuverOrchestrator } = await import('../../mechjeb/orchestrator.js');
        const orchestrator = new ManeuverOrchestrator(conn);
        const autoTarget = await ctx.selectTarget(orchestrator, 'second-closest', false);
        if (!autoTarget) {
          return ctx.errorResponse('set_target', 'No suitable target found');
        }
        name = autoTarget;
      }

      const result = await setTarget(conn, name, args.type as 'auto' | 'body' | 'vessel');
      if (!result.success) {
        return ctx.errorResponse('set_target', result.error ?? `Failed to set target "${name}"`);
      }

      return ctx.successResponse('set_target', `Target: ${result.name} (${result.type})`);
    } catch (error) {
      return ctx.errorResponse('set_target', error instanceof Error ? error.message : String(error));
    }
  },
};
