/**
 * Get Landing Prediction - Query where and when the vessel will land
 */

import { z } from 'zod';
import type { ToolDefinition } from '../../tool-types.js';
import { getLandingPrediction,  } from './shared.js';

// ============================================================================
// Tool Definition
// ============================================================================

export const getLandingPredictionTool: ToolDefinition = {
  name: 'get_landing_prediction',
  description:
    'Get predicted landing location, time, and outcome. Shows where vessel will land based on ' +
    'current trajectory. Works during descent or after deorbit burn. ' +
    'Returns coordinates, altitude, time to landing, and safety info (max speed, chute readiness).',
  inputSchema: {
    _placeholder: z.boolean()
      .optional()
      .describe('No parameters needed'),
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

      const prediction = await getLandingPrediction(conn);

      return ctx.successResponse('get_landing_prediction', prediction.formatted);
    } catch (error) {
      return ctx.errorResponse(
        'get_landing_prediction',
        error instanceof Error ? error.message : String(error)
      );
    }
  },
};

// Re-export for library use


export {type LandingPrediction, getLandingPrediction} from './shared.js';