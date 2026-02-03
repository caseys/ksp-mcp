/**
 * Circularize - Make orbit circular at current altitude
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, formatResultingOrbit, type ManeuverResult } from '../shared.js';
import { validateVesselState, ORBITAL_REQUIREMENTS } from '../../kos/vessel/validate.js';
import { clearNodes } from '../../kos/nodes.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema, distanceSchema } from '../../tool-types.js';
import { formatTime, fmtVel, fmtDist } from '../../utils/format.js';

/**
 * Create a maneuver node to circularize the orbit.
 *
 * @param conn kOS connection
 * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW'
 * @param xFromNowSeconds When using X_FROM_NOW, the time in seconds from now
 */
export async function circularize(
  conn: KosConnection,
  timeRef = 'APOAPSIS',
  xFromNowSeconds?: number
): Promise<ManeuverResult> {
  // Validate vessel state: must not be on ground
  const validation = await validateVesselState(conn, ORBITAL_REQUIREMENTS, 'circularize');
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // Build command - use CIRCULARIZETIMED for X_FROM_NOW (thread-safe, no shared state)
  let cmd: string;
  if (timeRef === 'X_FROM_NOW' && xFromNowSeconds !== undefined) {
    cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CIRCULARIZETIMED("${timeRef}", ${xFromNowSeconds}).`;
  } else {
    cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CIRCULARIZE("${timeRef}").`;
  }
  return executeManeuverCommand(conn, cmd, 10_000, 'circularize');
}

/**
 * Optimize circularization node timing by sliding it earlier until Pe ≈ Ap.
 * MechJeb sometimes places the node slightly late, causing periapsis to come up short.
 *
 * Algorithm: Binary search to find optimal timing where |Ap - Pe| is minimized.
 *
 * @param conn kOS connection
 * @param logger Optional logger for progress
 * @returns Object with success and adjustment made (seconds earlier)
 */
export async function optimizeCircularizationTiming(
  conn: KosConnection,
  logger?: { info: (msg: string) => void }
): Promise<{ success: boolean; adjustment: number; finalGap: number }> {
  const log = logger ?? { info: () => {} };

  // Query initial state
  const initialResult = await conn.queue(
    'IF HASNODE { ' +
    'PRINT "NODE|" + ROUND(NEXTNODE:ETA) + "|" + ROUND(NEXTNODE:ORBIT:PERIAPSIS) + "|" + ROUND(NEXTNODE:ORBIT:APOAPSIS). ' +
    '} ELSE { PRINT "NONODE". }',
    3000
  );

  if (!initialResult.success || initialResult.output.includes('NONODE')) {
    return { success: false, adjustment: 0, finalGap: 0 };
  }

  const initialMatch = initialResult.output.match(/NODE\|(\d+)\|(-?\d+)\|(-?\d+)/);
  if (!initialMatch) {
    return { success: false, adjustment: 0, finalGap: 0 };
  }

  const originalEta = parseInt(initialMatch[1]);
  const initialPe = parseInt(initialMatch[2]);
  const initialAp = parseInt(initialMatch[3]);
  const initialGap = Math.abs(initialAp - initialPe);

  log.info(`[OptimizeNode] Initial: ETA=${originalEta}s, Pe=${Math.round(initialPe/1000)}km, Ap=${Math.round(initialAp/1000)}km, gap=${Math.round(initialGap/1000)}km`);

  // If already very circular, skip
  if (initialGap < 1000) {
    log.info(`[OptimizeNode] Already circular enough, skipping`);
    return { success: true, adjustment: 0, finalGap: initialGap };
  }

  let bestEta = originalEta;
  let bestGap = initialGap;
  let totalAdjustment = 0;

  // Try sliding earlier in steps: 5s, 2s, 1s
  const steps = [5, 2, 1];

  for (const step of steps) {
    let improved = true;
    let iterations = 0;
    const maxIterations = 20; // Safety limit per step size

    while (improved && iterations < maxIterations) {
      iterations++;
      const tryEta = bestEta - step;

      // Don't go too early (need at least 30s for alignment)
      if (tryEta < 30) break;

      // Adjust node and check result
      const checkResult = await conn.queue(
        `SET NEXTNODE:ETA TO ${tryEta}. WAIT 0.1. ` +
        'PRINT "CHECK|" + ROUND(NEXTNODE:ORBIT:PERIAPSIS) + "|" + ROUND(NEXTNODE:ORBIT:APOAPSIS).',
        3000
      );

      const checkMatch = checkResult.success ? checkResult.output.match(/CHECK\|(-?\d+)\|(-?\d+)/) : null;
      if (!checkMatch) {
        improved = false;
        break;
      }

      const newPe = parseInt(checkMatch[1]);
      const newAp = parseInt(checkMatch[2]);
      const newGap = Math.abs(newAp - newPe);

      if (newGap < bestGap) {
        bestGap = newGap;
        bestEta = tryEta;
        totalAdjustment = originalEta - tryEta;
      } else {
        // Went too far, restore best and try smaller step
        await conn.raw(`SET NEXTNODE:ETA TO ${bestEta}.`);
        improved = false;
      }
    }
  }

  // Ensure we're at the best ETA
  if (bestEta !== originalEta) {
    await conn.raw(`SET NEXTNODE:ETA TO ${bestEta}.`);
  }

  log.info(`[OptimizeNode] Optimized: shifted ${totalAdjustment}s earlier, gap now ${Math.round(bestGap/1000)}km`);

  return { success: true, adjustment: totalAdjustment, finalGap: bestGap };
}

// ============================================================================
// Tool Definition
// ============================================================================

export const circularizeTool: ToolDefinition = {
  name: 'circularize',
  description: 'Circularize to a stable orbit in current SOI.  Used after warp to SOI or launch to orbit.',
  inputSchema: {
    altitude: distanceSchema
      .optional()
      .describe('Target circular orbit altitude in meters. If omitted, circularizes at current altitude.'),
    timeRef: z.union([z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW']), z.literal('auto')])
      .optional()
      .default('auto')
      .describe('When to circularize. If omitted, auto-picks based on orbit (periapsis for hyperbolic, nearest node for elliptical)'),
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
      const logger = ctx.createLogger(extra);

      // Clear any leftover nodes from failed operations
      await clearNodes(conn);

      // Check orbit shape — query Pe and ecc first (APOAPSIS may not exist on crash/hyperbolic orbits)
      const peEccCheck = await conn.queue(
        'PRINT ROUND(ORBIT:ECCENTRICITY, 4) + "|" + ROUND(PERIAPSIS).',
        2000
      );
      const peEccParts = peEccCheck.success ? peEccCheck.output.split('|').map(s => s.trim()) : [];
      const currentEcc = Number.parseFloat(peEccParts[0]?.match(/[\d.]+/)?.[0] ?? '1');
      const peM = Number.parseFloat(peEccParts[1]?.match(/[-\d.]+/)?.[0] ?? '-1');

      const peKm = peM / 1000;
      logger.info(`[Circularize] Orbit check: ecc=${currentEcc}, Pe=${Math.round(peKm)}km`);

      // Crash trajectory (negative Pe) or hyperbolic orbit (ecc >= 1)
      // Fix periapsis first, then continue with normal circularization
      const isCrashTrajectory = peM < 0;
      const isHyperbolic = currentEcc >= 1;
      const orchestrator = new ManeuverOrchestrator(conn);

      if (isCrashTrajectory || isHyperbolic) {
        const situation = isCrashTrajectory ? `Crash trajectory (Pe=${Math.round(peKm)}km)` : `Hyperbolic orbit (ecc=${currentEcc.toFixed(2)})`;

        // Determine target periapsis: 20km above surface/atmosphere
        const altitudeArg = args.altitude as number | undefined;
        const atmQuery = await conn.queue(
          'IF SHIP:BODY:ATM:EXISTS { PRINT SHIP:BODY:ATM:HEIGHT. } ELSE { PRINT 0. }',
          2000
        );
        const captureAtmHeight = Number.parseInt(atmQuery.success ? atmQuery.output.match(/\d+/)?.[0] ?? '0' : '0');
        const capturePe = captureAtmHeight + 20_000;
        const targetPe = altitudeArg ?? capturePe;

        logger.progress(`[Circularize] ${situation} — fixing periapsis to ${fmtDist(targetPe)}`);

        // First burn: fix periapsis with time-based burn
        const peResult = await orchestrator.adjustPeriapsis(targetPe, 'X_FROM_NOW', {
          execute: args.execute as boolean,
          logger,
          callerTool: 'circularize',
          xFromNowSeconds: isCrashTrajectory ? 30 : 60,  // More urgent for crash
        });

        if (!peResult.success) {
          return ctx.errorResponse('circularize', peResult.error ?? 'Failed to fix periapsis');
        }

        if (!(args.execute as boolean)) {
          return ctx.successResponse('circularize',
            `Periapsis fix planned: ${fmtVel(peResult.deltaV ?? 0)} in T-${isCrashTrajectory ? 30 : 60}s\n` +
            `Execute to continue with circularization.`);
        }

        // Validate capture periapsis is in acceptable window (15-30km above atm)
        const postCapture = await conn.queue('PRINT ROUND(PERIAPSIS).', 2000);
        const actualPe = Number.parseFloat(postCapture.success ? postCapture.output.match(/[-\d.]+/)?.[0] ?? '0' : '0');
        const peAboveAtm = actualPe - captureAtmHeight;
        if (peAboveAtm < 15_000 || peAboveAtm > 30_000) {
          logger.warn(`[Circularize] Capture Pe ${fmtDist(actualPe)} outside target window (${fmtDist(captureAtmHeight + 15_000)}–${fmtDist(captureAtmHeight + 30_000)})`);
        }

        // Continue to circularization below
        logger.progress(`[Circularize] Periapsis fixed to ${fmtDist(actualPe)}, proceeding with circularization`);
      }

      // Check if already circular (skip if we just fixed periapsis)
      if (!isCrashTrajectory && !isHyperbolic && currentEcc < 0.1) {
        const apoCheck = await conn.queue('PRINT ROUND(APOAPSIS/1000).', 2000);
        const apoKm = Number.parseFloat(apoCheck.success ? apoCheck.output.match(/[-\d.]+/)?.[0] ?? '0' : '0');
        const altRatio = peKm > 0 ? apoKm / peKm : 999;
        const isCircular = currentEcc < 0.02 || (altRatio < 1.18 && altRatio > 0.85);

        if (isCircular) {
          return ctx.successResponse('circularize',
            `Orbit is already circular (${apoKm}km x ${peKm}km, ecc=${currentEcc.toFixed(4)}). No circularization needed.`);
        }
      }

      // Auto-detect best timeRef if 'auto'
      let timeRef = args.timeRef as string;
      if (timeRef === 'auto') {
        // After crash/hyperbolic fix, always circularize at periapsis
        if (isCrashTrajectory || isHyperbolic) {
          timeRef = 'PERIAPSIS';
        } else {
          // Elliptical orbit — pick nearest apse
          const etaInfo = await conn.queue('PRINT ETA:APOAPSIS + "|" + ETA:PERIAPSIS.', 2000);
          const etaParts = etaInfo.success ? etaInfo.output.split('|').map(s => s.trim()) : [];
          const etaApo = Number.parseFloat(etaParts[0] ?? '0');
          const etaPe = Number.parseFloat(etaParts[1] ?? '0');
          timeRef = etaApo < etaPe ? 'APOAPSIS' : 'PERIAPSIS';
        }
      }

      const result = await orchestrator.circularize(timeRef, {
        execute: args.execute as boolean,
        logger,
        callerTool: 'circularize',
      });

      if (result.success) {
        let text = result.executed
          ? 'Burn complete'
          : `Node: ${result.deltaV != null ? fmtVel(result.deltaV) : '?'}, in ${formatTime(result.timeToNode ?? 0)}`;

        // Show resulting orbit after execution
        if (result.executed) {
          text += await formatResultingOrbit(conn);

          // Check if orbit is now circular enough - tell LLM explicitly
          const orbitCheck = await conn.queue(
            'PRINT ROUND(ORBIT:ECCENTRICITY, 4) + "|" + ROUND(APOAPSIS/1000) + "|" + ROUND(PERIAPSIS/1000).',
            2000
          );
          const parts = orbitCheck.success ? orbitCheck.output.split('|').map(s => s.trim()) : [];
          const ecc = Number.parseFloat(parts[0]?.match(/[\d.]+/)?.[0] ?? '1');
          const apoKm = Number.parseFloat(parts[1] ?? '0');
          const peKm = Number.parseFloat(parts[2] ?? '0');
          const altRatio = peKm > 0 ? apoKm / peKm : 999;
          const isCircular = ecc < 0.02 || (ecc < 0.1 && altRatio < 1.18 && altRatio > 0.85);

          if (isCircular) {
            text += '\nOrbit is circular - no further circularization needed.';
          }
        }

        return ctx.successResponse('circularize', text);
      } else {
        return ctx.errorResponse('circularize', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('circularize', error instanceof Error ? error.message : String(error));
    }
  },
};
