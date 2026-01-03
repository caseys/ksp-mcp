/**
 * Target Info - Query target orbital elements and relative position
 */

import type { ToolDefinition } from '../../tool-types.js';
import { targetSchema } from '../../tool-types.js';
import { setTarget } from '../../kos/target/set-target.js';
import {
  getTargetOrbitInfo,
  getTargetPositionInfo,
  
  
} from './shared.js';

// ============================================================================
// Get Target Orbit Tool
// ============================================================================

// Tool replaced by unified get_target_info
const _getTargetOrbitTool: ToolDefinition = {
  name: 'get_target_orbit',
  description:
    'Get target orbital elements: apoapsis, periapsis, inclination, eccentricity, period, LAN. ' +
    'Optionally specify target, or uses current target. Useful for planning rendezvous.',
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
          return ctx.errorResponse('get_target_orbit', setResult.error ?? 'Failed to set target');
        }
      }

      const info = await getTargetOrbitInfo(conn);

      if (!info) {
        return ctx.errorResponse(
          'get_target_orbit',
          'No target set or target is a position. Specify target or use set_target first.'
        );
      }

      return ctx.successResponse('get_target_orbit', info.formatted);
    } catch (error) {
      return ctx.errorResponse(
        'get_target_orbit',
        error instanceof Error ? error.message : String(error)
      );
    }
  },
};

// ============================================================================
// Get Target Position Tool
// ============================================================================

// Tool replaced by unified get_target_info
const _getTargetPositionTool: ToolDefinition = {
  name: 'get_target_position',
  description:
    'Get relative position and velocity to target. Shows distance, approach speed, ' +
    'and docking alignment availability. Optionally specify target, or uses current target.',
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
          return ctx.errorResponse('get_target_position', setResult.error ?? 'Failed to set target');
        }
      }

      const info = await getTargetPositionInfo(conn);

      if (!info) {
        return ctx.errorResponse(
          'get_target_position',
          'No target set or target is a position. Specify target or use set_target first.'
        );
      }

      return ctx.successResponse('get_target_position', info.formatted);
    } catch (error) {
      return ctx.errorResponse(
        'get_target_position',
        error instanceof Error ? error.message : String(error)
      );
    }
  },
};

// Re-export for library use


export {type TargetOrbitInfo, type TargetPositionInfo, getTargetOrbitInfo, getTargetPositionInfo} from './shared.js';