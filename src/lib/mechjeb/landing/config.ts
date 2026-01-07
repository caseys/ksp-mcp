/**
 * Configure Landing - Set landing parameters without starting
 */

import { z } from 'zod';
import type { ToolDefinition } from '../../tool-types.js';
import {
  getLandingConfig,
  setLandingConfig,
  setLandingPositionTarget,
  setLandingPositionTargetKSC,
  type LandingConfig,
} from './shared.js';
import { fmtVel } from '../../utils/format.js';

// ============================================================================
// Tool Definition
// ============================================================================

export const configureLandingTool: ToolDefinition = {
  name: 'configure_landing',
  description:
    'Configure landing settings without starting. Set touchdown speed, gear/chute deployment, ' +
    'RCS usage, and optionally a landing target. Does NOT start landing - use land tool for that. ' +
    'Useful for pre-configuring before reaching landing altitude.',
  inputSchema: {
    // Position target (optional)
    latitude: z.number()
      .min(-90)
      .max(90)
      .optional()
      .describe('Target latitude for precision landing (-90 to 90)'),
    longitude: z.number()
      .min(-180)
      .max(180)
      .optional()
      .describe('Target longitude for precision landing (-180 to 180)'),
    preset: z.enum(['KSC'])
      .optional()
      .describe('Use preset location. "KSC" = Kerbin Space Center runway'),

    // Landing configuration
    touchdownSpeed: z.number()
      .min(0)
      .max(10)
      .optional()
      .describe('Target touchdown velocity in m/s (default ~2)'),
    deployGears: z.boolean()
      .optional()
      .describe('Auto-deploy landing gear'),
    deployChutes: z.boolean()
      .optional()
      .describe('Auto-deploy parachutes'),
    useRCS: z.boolean()
      .optional()
      .describe('Use RCS for fine position adjustments'),
    gearStage: z.number()
      .int()
      .min(0)
      .optional()
      .describe('Maximum stage number to deploy gears from'),
    chuteStage: z.number()
      .int()
      .min(0)
      .optional()
      .describe('Maximum stage number to deploy chutes from'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 3,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();

      // Step 1: Set position target if provided
      const latitude = args.latitude as number | undefined;
      const longitude = args.longitude as number | undefined;
      const preset = args.preset as 'KSC' | undefined;

      let targetMessage = '';
      if (preset === 'KSC') {
        const targetResult = await setLandingPositionTargetKSC(conn);
        if (!targetResult.success) {
          return ctx.errorResponse('configure_landing', targetResult.error ?? 'Failed to set KSC target');
        }
        targetMessage = 'Target: KSC runway\n';
      } else if (latitude !== undefined && longitude !== undefined) {
        const targetResult = await setLandingPositionTarget(conn, latitude, longitude);
        if (!targetResult.success) {
          return ctx.errorResponse('configure_landing', targetResult.error ?? 'Failed to set position target');
        }
        targetMessage = `Target: ${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°\n`;
      }

      // Step 2: Apply configuration
      const config: Partial<LandingConfig> = {};
      if (args.touchdownSpeed !== undefined) config.touchdownSpeed = args.touchdownSpeed as number;
      if (args.deployGears !== undefined) config.deployGears = args.deployGears as boolean;
      if (args.deployChutes !== undefined) config.deployChutes = args.deployChutes as boolean;
      if (args.useRCS !== undefined) config.useRCS = args.useRCS as boolean;
      if (args.gearStage !== undefined) config.gearStage = args.gearStage as number;
      if (args.chuteStage !== undefined) config.chuteStage = args.chuteStage as number;

      if (Object.keys(config).length > 0) {
        await setLandingConfig(conn, config);
      }

      // Step 3: Get current config for confirmation
      const currentConfig = await getLandingConfig(conn);

      let message = 'Landing configured:\n';
      if (targetMessage) message += targetMessage;
      message += `Touchdown speed: ${fmtVel(currentConfig.touchdownSpeed)}\n`;
      message += `Deploy gears: ${currentConfig.deployGears ? 'yes' : 'no'}\n`;
      message += `Deploy chutes: ${currentConfig.deployChutes ? 'yes' : 'no'}\n`;
      message += `Use RCS: ${currentConfig.useRCS ? 'yes' : 'no'}\n`;
      message += `Gear stage limit: ${currentConfig.gearStage}\n`;
      message += `Chute stage limit: ${currentConfig.chuteStage}\n`;
      message += '\nUse land tool with action="start" to begin landing.';

      return ctx.successResponse('configure_landing', message);
    } catch (error) {
      return ctx.errorResponse(
        'configure_landing',
        error instanceof Error ? error.message : String(error)
      );
    }
  },
};

// Re-export for library use


export {getLandingConfig, setLandingConfig, type LandingConfig} from './shared.js';