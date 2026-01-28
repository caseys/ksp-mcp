/**
 * Adjust Orbit Tool - Change orbit to target altitude(s)
 *
 * periapsis only: Circular orbit at that altitude
 * periapsis + apoapsis: Elliptical orbit with those altitudes
 */

import { ManeuverOrchestrator } from '../orchestrator.js';
import { validateVesselState, getVesselStateInfo, ORBITAL_REQUIREMENTS } from '../../kos/vessel/validate.js';
import { clearNodes } from '../../kos/nodes.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, distanceSchema } from '../../tool-types.js';
import { formatTime, fmtVel, fmtDist, fmtPeAp } from '../../utils/format.js';
import { checkPostBurnPeriapsis } from '../shared.js';
import { ensureRadioContact } from '../../../utils/radio-contact.js';

export const adjustOrbitTool: ToolDefinition = {
  name: 'adjust_orbit',
  description: 'Raise or lower orbit.',
  inputSchema: {
    periapsis: distanceSchema
      .describe('Target periapsis altitude in meters.'),
    apoapsis: distanceSchema
      .optional()
      .describe('Target apoapsis altitude in meters. If omitted, creates circular orbit at periapsis.'),
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

      // Ensure radio contact before planning (can't plan without communication)
      const radioResult = await ensureRadioContact(conn, { logger, context: toolName });
      if (!radioResult.success) {
        return ctx.errorResponse(toolName, radioResult.error ?? 'Cannot establish radio contact');
      }
      if (radioResult.warpedSeconds && radioResult.warpedSeconds > 0) {
        logger.progress(`[${toolName}] Warped ${formatTime(radioResult.warpedSeconds)} to radio contact`);
      }

      // Parse altitude inputs
      const targetPe = args.periapsis as number;
      const targetAp = (args.apoapsis as number | undefined) ?? targetPe;  // Default to circular

      // Validate vessel state: must be in orbit or escaping (hyperbolic)
      const vesselValidation = await validateVesselState(conn, ORBITAL_REQUIREMENTS, toolName);
      if (!vesselValidation.valid) {
        return ctx.errorResponse(toolName, vesselValidation.error ?? 'Invalid vessel state');
      }

      // Check for hyperbolic orbit - handle specially
      const stateInfo = await getVesselStateInfo(conn);
      const isHyperbolic = stateInfo.eccentricity >= 1;

      if (isHyperbolic) {
        // Hyperbolic trajectory: first burn adjusts periapsis, second circularizes to capture
        const hyperbolicPe = targetPe;

        logger.progress(`[AdjustOrbit] Hyperbolic trajectory: adjusting Pe to ${fmtDist(hyperbolicPe)}`);

        // First burn: adjust periapsis (time-based, 1 minute from now)
        const peResult = await orchestrator.adjustPeriapsis(hyperbolicPe, 'X_FROM_NOW', {
          execute,
          logger,
          callerTool: toolName,
          xFromNowSeconds: 60,
        });

        if (!peResult.success) {
          return ctx.errorResponse(toolName, peResult.error ?? 'Failed to plan periapsis adjustment');
        }

        if (!execute) {
          const msg = `Periapsis adjustment planned: ${fmtVel(peResult.deltaV ?? 0)} in T-60s\n` +
            `Target periapsis: ${fmtDist(hyperbolicPe)}\n` +
            `Note: Execute to continue with circularization`;
          return ctx.successResponse(toolName, msg);
        }

        let totalDeltaV = peResult.deltaV ?? 0;

        // Second burn: circularize at periapsis to capture into orbit
        logger.progress(`[AdjustOrbit] Capture burn: circularizing at periapsis`);

        const circResult = await orchestrator.circularize('PERIAPSIS', {
          execute: true,
          logger,
          callerTool: toolName,
        });

        if (!circResult.success) {
          return ctx.errorResponse(toolName,
            `Periapsis adjusted (${fmtVel(totalDeltaV)}), but capture burn failed: ${circResult.error}`);
        }

        totalDeltaV += circResult.deltaV ?? 0;

        // Get final orbit
        const finalOrbit = await ctx.getBasicOrbitInfo(conn);
        return ctx.successResponse(toolName,
          `Captured into orbit: ${fmtPeAp(finalOrbit?.periapsis ?? hyperbolicPe, finalOrbit?.apoapsis ?? hyperbolicPe)}\n` +
          `Total Δv: ${fmtVel(totalDeltaV)} (Pe: ${fmtVel(peResult.deltaV ?? 0)} + circ: ${fmtVel(circResult.deltaV ?? 0)})`);
      }

      // Get current orbit info
      const orbitInfo = await ctx.getBasicOrbitInfo(conn);
      const currentAp = orbitInfo?.apoapsis ?? 0;
      const currentPe = orbitInfo?.periapsis ?? 0;

      // Query body info for validation
      const bodyResult = await conn.queue(
        'IF SHIP:BODY:ATM:EXISTS { PRINT SHIP:BODY:ATM:HEIGHT + "|" + SHIP:BODY:NAME. } ELSE { PRINT "0|" + SHIP:BODY:NAME. }',
        3000
      );
      const bodyMatch = bodyResult.success ? bodyResult.output.match(/(\d+)\|(.+)/) : null;
      const atmHeight = bodyMatch ? Number.parseInt(bodyMatch[1]) : 0;
      const bodyName = bodyMatch ? bodyMatch[2].trim() : 'body';

      // Minimum safe altitude: atmo + 40km, or 40km for airless bodies (matches hohmann.ts)
      const minSafeAlt = atmHeight > 0 ? atmHeight + 40_000 : 40_000;

      // Check for crash trajectory (periapsis below surface or atmosphere)
      const isCrashTrajectory = currentPe < 0 || (atmHeight > 0 && currentPe < atmHeight);

      if (isCrashTrajectory) {
        // Emergency recovery: time-based burn to raise periapsis, then circularize
        const crashPe = Math.max(targetPe, minSafeAlt);  // At least minimum safe

        logger.progress(`[AdjustOrbit] Crash trajectory (Pe=${fmtDist(currentPe)}), emergency raise to ${fmtDist(crashPe)}`);

        // First burn: raise periapsis immediately (30s from now for urgency)
        const peResult = await orchestrator.adjustPeriapsis(crashPe, 'X_FROM_NOW', {
          execute,
          logger,
          callerTool: toolName,
          xFromNowSeconds: 30,
        });

        if (!peResult.success) {
          return ctx.errorResponse(toolName, peResult.error ?? 'Failed to plan emergency periapsis raise');
        }

        if (!execute) {
          const msg = `Emergency periapsis raise planned: ${fmtVel(peResult.deltaV ?? 0)} in T-30s\n` +
            `Target periapsis: ${fmtDist(crashPe)}\n` +
            `Note: Execute to continue with circularization`;
          return ctx.successResponse(toolName, msg);
        }

        let totalDeltaV = peResult.deltaV ?? 0;

        // Second burn: circularize at periapsis to establish orbit
        logger.progress(`[AdjustOrbit] Circularizing at periapsis`);

        const circResult = await orchestrator.circularize('PERIAPSIS', {
          execute: true,
          logger,
          callerTool: toolName,
        });

        if (!circResult.success) {
          return ctx.errorResponse(toolName,
            `Periapsis raised (${fmtVel(totalDeltaV)}), but circularization failed: ${circResult.error}`);
        }

        totalDeltaV += circResult.deltaV ?? 0;

        const finalOrbit = await ctx.getBasicOrbitInfo(conn);
        return ctx.successResponse(toolName,
          `Crash avoided, orbit established: ${fmtPeAp(finalOrbit?.periapsis ?? crashPe, finalOrbit?.apoapsis ?? crashPe)}\n` +
          `Total Δv: ${fmtVel(totalDeltaV)} (Pe: ${fmtVel(peResult.deltaV ?? 0)} + circ: ${fmtVel(circResult.deltaV ?? 0)})`);
      }

      // Validate target altitudes (for normal orbits)
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
              `Node: ${fmtVel(result.deltaV ?? 0)}, in ${formatTime(result.timeToNode ?? 0)}`);
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
              `Node: ${fmtVel(planResult.deltaV ?? 0)}, in ${formatTime(planResult.timeToNode ?? 0)}`);
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
              `Node: ${fmtVel(result.deltaV ?? 0)}, in ${formatTime(result.timeToNode ?? 0)}`);
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

      // Get final orbit info for result message
      const finalOrbitInfo = await ctx.getBasicOrbitInfo(conn);
      const finalPe = finalOrbitInfo?.periapsis ?? targetPe;
      const finalAp = finalOrbitInfo?.apoapsis ?? targetAp;

      // Check if circular: ap and pe within 10% of each other
      const isCircular = finalAp > 0 && Math.abs(finalAp - finalPe) / finalAp < 0.1;
      const burnSummary = burns.length > 1 ? ` (${burns.join(' + ')})` : '';

      // Build action description based on what was achieved
      let actionDescription: string;
      if (isCircular) {
        actionDescription = `Orbit circularized`;
      } else if (raisingAp && raisingPe) {
        actionDescription = `Orbit raised successfully`;
      } else if (!raisingAp && !raisingPe) {
        actionDescription = `Orbit lowered successfully`;
      } else if (raisingAp) {
        actionDescription = `Apoapsis raised successfully`;
      } else if (raisingPe) {
        actionDescription = `Periapsis raised successfully`;
      } else {
        actionDescription = `Orbit adjusted successfully`;
      }

      return ctx.successResponse(toolName,
        `${actionDescription}: ${fmtPeAp(finalPe, finalAp)}\n` +
        `Total Δv: ${fmtVel(totalDeltaV)}${burnSummary}`);

    } catch (error) {
      return ctx.errorResponse('adjust_orbit', error instanceof Error ? error.message : String(error));
    }
  },
};
