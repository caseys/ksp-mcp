/**
 * Adjust Orbit Tool - Change orbit to target altitude(s)
 *
 * Single altitude: Set both apoapsis and periapsis to same value (circular orbit)
 * Two altitudes: Set periapsis to lower value, apoapsis to higher value
 */

import { z } from 'zod';
import { ManeuverOrchestrator } from '../orchestrator.js';
import { validateVesselState, getVesselStateInfo, ORBITAL_REQUIREMENTS } from '../../kos/vessel/validate.js';
import { clearNodes } from '../../kos/nodes.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, distanceSchema } from '../../tool-types.js';
import { formatTime, fmtVel, fmtDist } from '../../utils/format.js';
import { formatResultingOrbit, checkPostBurnPeriapsis } from '../shared.js';

export const adjustOrbitTool: ToolDefinition = {
  name: 'adjust_orbit',
  description: 'Raise or lower orbit. One altitude sets circular orbit, two altitudes set periapsis (lower) and apoapsis (higher).',
  inputSchema: {
    altitude: z.union([distanceSchema, z.array(distanceSchema).length(2)])
      .describe('Target altitude in meters. Single value for circular orbit, or [low, high] for elliptical.'),
    execute: executeSchema,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 1,
  handler: async (args, ctx, extra) => {
    try {
      const conn = await ctx.ensureConnected();
      const orchestrator = new ManeuverOrchestrator(conn);
      const logger = ctx.createLogger(extra);
      const execute = args.execute as boolean;
      const toolName = 'adjust_orbit';

      // Parse altitude input
      const altInput = args.altitude as number | number[];
      let targetPe: number;
      let targetAp: number;

      if (Array.isArray(altInput)) {
        // Two values: lower is pe, higher is ap
        targetPe = Math.min(altInput[0], altInput[1]);
        targetAp = Math.max(altInput[0], altInput[1]);
      } else {
        // Single value: circular orbit
        targetPe = altInput;
        targetAp = altInput;
      }

      // Validate vessel state: must be in orbit or escaping (hyperbolic)
      const vesselValidation = await validateVesselState(conn, ORBITAL_REQUIREMENTS, toolName);
      if (!vesselValidation.valid) {
        return ctx.errorResponse(toolName, vesselValidation.error ?? 'Invalid vessel state');
      }

      // Check for hyperbolic orbit - handle specially
      const stateInfo = await getVesselStateInfo(conn);
      const isHyperbolic = stateInfo.eccentricity >= 1;

      if (isHyperbolic) {
        // Hyperbolic trajectory: altitude is target periapsis, burn in 1 minute
        const targetPe = Array.isArray(altInput) ? Math.min(altInput[0], altInput[1]) : altInput;

        logger.progress(`[AdjustOrbit] Hyperbolic trajectory: adjusting Pe to ${fmtDist(targetPe)}`);

        const result = await orchestrator.adjustPeriapsis(targetPe, 'X_FROM_NOW', {
          execute,
          logger,
          callerTool: toolName,
          xFromNowSeconds: 60,  // 1 minute ahead
        });

        if (!result.success) {
          return ctx.errorResponse(toolName, result.error ?? 'Failed to plan periapsis adjustment');
        }

        if (!execute) {
          return ctx.successResponse(toolName,
            `Periapsis adjustment planned: ${fmtVel(result.deltaV ?? 0)} in T-60s\n` +
            `Target periapsis: ${fmtDist(targetPe)}`);
        }

        return ctx.successResponse(toolName,
          `Periapsis adjusted: ${fmtVel(result.deltaV ?? 0)}\n` +
          `Target periapsis: ${fmtDist(targetPe)}`);
      }

      // Get current orbit info
      const orbitInfo = await ctx.getBasicOrbitInfo(conn);
      const currentAp = orbitInfo?.apoapsis ?? 0;
      const currentPe = orbitInfo?.periapsis ?? 0;

      // Query body info for validation
      const bodyResult = await conn.execute(
        'IF SHIP:BODY:ATM:EXISTS { PRINT SHIP:BODY:ATM:HEIGHT + "|" + SHIP:BODY:NAME. } ELSE { PRINT "0|" + SHIP:BODY:NAME. }',
        3000
      );
      const bodyMatch = bodyResult.output.match(/(\d+)\|(.+)/);
      const atmHeight = bodyMatch ? Number.parseInt(bodyMatch[1]) : 0;
      const bodyName = bodyMatch ? bodyMatch[2].trim() : 'body';

      // Validate target altitudes
      if (targetPe < 0) {
        return ctx.errorResponse(toolName, `Target periapsis ${fmtDist(targetPe)} is below surface.`);
      }
      if (atmHeight > 0 && targetPe < atmHeight) {
        return ctx.errorResponse(toolName,
          `Target periapsis ${fmtDist(targetPe)} is below ${bodyName}'s atmosphere (${fmtDist(atmHeight)}).`);
      }

      // Determine what needs to change
      const needsApChange = Math.abs(targetAp - currentAp) > 100;  // 100m tolerance
      const needsPeChange = Math.abs(targetPe - currentPe) > 100;

      if (!needsApChange && !needsPeChange) {
        return ctx.successResponse(toolName, `Already at target orbit: Pe=${fmtDist(currentPe)}, Ap=${fmtDist(currentAp)}`);
      }

      const raisingAp = targetAp > currentAp;
      const raisingPe = targetPe > currentPe;

      logger.progress(`[Orbit] Target: Pe=${fmtDist(targetPe)}, Ap=${fmtDist(targetAp)} (current: Pe=${fmtDist(currentPe)}, Ap=${fmtDist(currentAp)})`);

      let totalDeltaV = 0;
      const burns: string[] = [];

      // Determine burn order based on what we're changing
      // Rule: To raise something, burn at the opposite point. To lower, burn at the opposite point.
      // Optimal order depends on the specific changes needed.

      // If raising both or lowering both, we have a clear order
      // If mixed (raising one, lowering other), we need to be careful about intermediate states

      if (raisingAp && raisingPe) {
        // RAISING ORBIT: Burn at Pe to raise Ap, then burn at Ap to raise Pe
        if (needsApChange) {
          logger.progress(`[Orbit] Step 1: Raising apoapsis to ${fmtDist(targetAp)} at periapsis`);
          const result = await orchestrator.adjustApoapsis(targetAp, 'PERIAPSIS', {
            execute, logger, callerTool: toolName,
          });
          if (!result.success) return ctx.errorResponse(toolName, `Failed to raise apoapsis: ${result.error}`);
          if (!execute) {
            return ctx.successResponse(toolName,
              `Step 1 planned: Raise Ap to ${fmtDist(targetAp)}\n` +
              `Node: ${fmtVel(result.deltaV ?? 0)}, T-${formatTime(result.timeToNode ?? 0)}`);
          }
          totalDeltaV += result.deltaV ?? 0;
          burns.push(`Ap: ${fmtVel(result.deltaV ?? 0)}`);
        }

        if (needsPeChange) {
          logger.progress(`[Orbit] Step 2: Raising periapsis to ${fmtDist(targetPe)} at apoapsis`);
          const result = await orchestrator.adjustPeriapsis(targetPe, 'APOAPSIS', {
            execute: true, logger, callerTool: toolName,
          });
          if (!result.success) return ctx.errorResponse(toolName, `Failed to raise periapsis: ${result.error}`);
          totalDeltaV += result.deltaV ?? 0;
          burns.push(`Pe: ${fmtVel(result.deltaV ?? 0)}`);
        }

      } else if (!raisingAp && !raisingPe) {
        // LOWERING ORBIT: Burn at Ap to lower Pe, then burn at Pe to lower Ap
        if (needsPeChange) {
          logger.progress(`[Orbit] Step 1: Lowering periapsis to ${fmtDist(targetPe)} at apoapsis`);

          // Plan first for safety check
          const planResult = await orchestrator.adjustPeriapsis(targetPe, 'APOAPSIS', {
            execute: false, logger, callerTool: toolName,
          });
          if (!planResult.success) return ctx.errorResponse(toolName, `Failed to plan periapsis change: ${planResult.error}`);

          const crashWarning = await checkPostBurnPeriapsis(conn);
          if (crashWarning) {
            await clearNodes(conn);
            return ctx.errorResponse(toolName, `${crashWarning}\nTarget would result in crash trajectory.`);
          }

          if (!execute) {
            return ctx.successResponse(toolName,
              `Step 1 planned: Lower Pe to ${fmtDist(targetPe)}\n` +
              `Node: ${fmtVel(planResult.deltaV ?? 0)}, T-${formatTime(planResult.timeToNode ?? 0)}`);
          }

          // Execute the planned node
          const { executeNode } = await import('../execute-node.js');
          const execResult = await executeNode(conn, { logger, callerTool: toolName });
          if (!execResult.success) return ctx.errorResponse(toolName, `Failed to execute periapsis burn: ${execResult.error}`);
          totalDeltaV += planResult.deltaV ?? 0;
          burns.push(`Pe: ${fmtVel(planResult.deltaV ?? 0)}`);
        }

        if (needsApChange) {
          logger.progress(`[Orbit] Step 2: Lowering apoapsis to ${fmtDist(targetAp)} at periapsis`);
          const result = await orchestrator.adjustApoapsis(targetAp, 'PERIAPSIS', {
            execute: true, logger, callerTool: toolName,
          });
          if (!result.success) return ctx.errorResponse(toolName, `Failed to lower apoapsis: ${result.error}`);
          totalDeltaV += result.deltaV ?? 0;
          burns.push(`Ap: ${fmtVel(result.deltaV ?? 0)}`);
        }

      } else {
        // MIXED: One going up, one going down - handle each independently
        // Do the safer/simpler burns based on current position

        if (needsApChange) {
          const action = raisingAp ? 'Raising' : 'Lowering';
          logger.progress(`[Orbit] ${action} apoapsis to ${fmtDist(targetAp)} at periapsis`);
          const result = await orchestrator.adjustApoapsis(targetAp, 'PERIAPSIS', {
            execute, logger, callerTool: toolName,
          });
          if (!result.success) return ctx.errorResponse(toolName, `Failed to adjust apoapsis: ${result.error}`);
          if (!execute) {
            return ctx.successResponse(toolName,
              `Planned: ${action} Ap to ${fmtDist(targetAp)}\n` +
              `Node: ${fmtVel(result.deltaV ?? 0)}, T-${formatTime(result.timeToNode ?? 0)}`);
          }
          totalDeltaV += result.deltaV ?? 0;
          burns.push(`Ap: ${fmtVel(result.deltaV ?? 0)}`);
        }

        if (needsPeChange) {
          const action = raisingPe ? 'Raising' : 'Lowering';
          logger.progress(`[Orbit] ${action} periapsis to ${fmtDist(targetPe)} at apoapsis`);

          if (!raisingPe) {
            // Lowering - check for crash
            const planResult = await orchestrator.adjustPeriapsis(targetPe, 'APOAPSIS', {
              execute: false, logger, callerTool: toolName,
            });
            if (!planResult.success) return ctx.errorResponse(toolName, `Failed to plan periapsis change: ${planResult.error}`);

            const crashWarning = await checkPostBurnPeriapsis(conn);
            if (crashWarning) {
              await clearNodes(conn);
              return ctx.errorResponse(toolName, `${crashWarning}\nTarget would result in crash trajectory.`);
            }

            const { executeNode } = await import('../execute-node.js');
            const execResult = await executeNode(conn, { logger, callerTool: toolName });
            if (!execResult.success) return ctx.errorResponse(toolName, `Failed to execute periapsis burn: ${execResult.error}`);
            totalDeltaV += planResult.deltaV ?? 0;
            burns.push(`Pe: ${fmtVel(planResult.deltaV ?? 0)}`);
          } else {
            const result = await orchestrator.adjustPeriapsis(targetPe, 'APOAPSIS', {
              execute: true, logger, callerTool: toolName,
            });
            if (!result.success) return ctx.errorResponse(toolName, `Failed to adjust periapsis: ${result.error}`);
            totalDeltaV += result.deltaV ?? 0;
            burns.push(`Pe: ${fmtVel(result.deltaV ?? 0)}`);
          }
        }
      }

      const finalOrbit = await formatResultingOrbit(conn);
      const burnSummary = burns.length > 1 ? ` (${burns.join(' + ')})` : '';

      return ctx.successResponse(toolName,
        `Orbit adjusted to Pe=${fmtDist(targetPe)}, Ap=${fmtDist(targetAp)}\n` +
        `Total Δv: ${fmtVel(totalDeltaV)}${burnSummary}` +
        finalOrbit);

    } catch (error) {
      return ctx.errorResponse('adjust_orbit', error instanceof Error ? error.message : String(error));
    }
  },
};
