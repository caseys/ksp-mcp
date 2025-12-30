/**
 * Set Position Target - Set surface coordinates for precision landing
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import type { ToolDefinition } from '../../tool-types.js';
import {
  setPositionTarget,
  setPositionTargetKSC,
  type SetPositionTargetResult,
} from './shared.js';

// ============================================================================
// Core Function
// ============================================================================

/**
 * Set a position target on the current body's surface.
 * Position targets are used for precision landing.
 *
 * @param conn kOS connection
 * @param options Either lat/lng coordinates or a preset name
 */
export async function setPositionTargetOp(
  conn: KosConnection,
  options: {
    latitude?: number;
    longitude?: number;
    preset?: 'KSC';
  }
): Promise<SetPositionTargetResult> {
  if (options.preset === 'KSC') {
    return setPositionTargetKSC(conn);
  }

  if (options.latitude !== undefined && options.longitude !== undefined) {
    return setPositionTarget(conn, options.latitude, options.longitude);
  }

  return {
    success: false,
    error: 'Either latitude/longitude or preset must be specified',
  };
}

// ============================================================================
// Tool Definition
// ============================================================================

export const setPositionTargetTool: ToolDefinition = {
  name: 'set_position_target',
  description:
    'Set landing target at surface coordinates. Required before precision landing. ' +
    'Use preset="KSC" for Kerbin runway, or specify latitude/longitude for custom location.',
  inputSchema: {
    latitude: z.number()
      .min(-90)
      .max(90)
      .optional()
      .describe('Target latitude in degrees (-90 to 90). Required unless using preset.'),
    longitude: z.number()
      .min(-180)
      .max(180)
      .optional()
      .describe('Target longitude in degrees (-180 to 180). Required unless using preset.'),
    preset: z.enum(['KSC'])
      .optional()
      .describe('Use preset location. "KSC" = Kerbin Space Center runway.'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 2,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();

      const latitude = args.latitude as number | undefined;
      const longitude = args.longitude as number | undefined;
      const preset = args.preset as 'KSC' | undefined;

      // Validate: either preset OR lat/lng, not both
      if (preset && (latitude !== undefined || longitude !== undefined)) {
        return ctx.errorResponse(
          'set_position_target',
          'Specify either preset OR latitude/longitude, not both'
        );
      }

      if (!preset && (latitude === undefined || longitude === undefined)) {
        return ctx.errorResponse(
          'set_position_target',
          'Specify latitude and longitude, or use preset="KSC"'
        );
      }

      const result = await setPositionTargetOp(conn, { latitude, longitude, preset });

      if (result.success) {
        const latStr = result.latitude?.toFixed(4) ?? '?';
        const lngStr = result.longitude?.toFixed(4) ?? '?';
        return ctx.successResponse(
          'set_position_target',
          `Position target set: ${latStr}°, ${lngStr}° on ${result.body}\nReady for precision landing with the land tool.`
        );
      } else {
        return ctx.errorResponse('set_position_target', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse(
        'set_position_target',
        error instanceof Error ? error.message : String(error)
      );
    }
  },
};
