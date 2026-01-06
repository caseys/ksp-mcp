/**
 * Circularize - Make orbit circular at current altitude
 */

import { z } from 'zod';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { executeManeuverCommand, formatResultingOrbit, type ManeuverResult } from '../shared.js';
import { validateVesselState, ORBITAL_REQUIREMENTS } from '../../kos/vessel/validate.js';
import { ManeuverOrchestrator } from '../orchestrator.js';
import type { ToolDefinition } from '../../tool-types.js';
import { executeSchema } from '../../tool-types.js';
import { formatTime, fmtNum } from '../../utils/format.js';

/**
 * Create a maneuver node to circularize the orbit.
 *
 * @param conn kOS connection
 * @param timeRef When to execute: 'APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW'
 */
export async function circularize(
  conn: KosConnection,
  timeRef = 'APOAPSIS'
): Promise<ManeuverResult> {
  // Validate vessel state: must not be on ground
  const validation = await validateVesselState(conn, ORBITAL_REQUIREMENTS, 'circularize');
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const cmd = `SET PLANNER TO ADDONS:MJ:MANEUVERPLANNER. PRINT PLANNER:CIRCULARIZE("${timeRef}").`;
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
  const initialResult = await conn.execute(
    'IF HASNODE { ' +
    'PRINT "NODE|" + ROUND(NEXTNODE:ETA) + "|" + ROUND(NEXTNODE:ORBIT:PERIAPSIS) + "|" + ROUND(NEXTNODE:ORBIT:APOAPSIS). ' +
    '} ELSE { PRINT "NONODE". }'
  );

  if (initialResult.output.includes('NONODE')) {
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
      const checkResult = await conn.execute(
        `SET NEXTNODE:ETA TO ${tryEta}. WAIT 0.1. ` +
        'PRINT "CHECK|" + ROUND(NEXTNODE:ORBIT:PERIAPSIS) + "|" + ROUND(NEXTNODE:ORBIT:APOAPSIS).'
      );

      const checkMatch = checkResult.output.match(/CHECK\|(-?\d+)\|(-?\d+)/);
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
        await conn.execute(`SET NEXTNODE:ETA TO ${bestEta}.`);
        improved = false;
      }
    }
  }

  // Ensure we're at the best ETA
  if (bestEta !== originalEta) {
    await conn.execute(`SET NEXTNODE:ETA TO ${bestEta}.`);
  }

  log.info(`[OptimizeNode] Optimized: shifted ${totalAdjustment}s earlier, gap now ${Math.round(bestGap/1000)}km`);

  return { success: true, adjustment: totalAdjustment, finalGap: bestGap };
}

// ============================================================================
// Tool Definition
// ============================================================================

export const circularizeTool: ToolDefinition = {
  name: 'circularize',
  description: 'Circularize to a stable orbit in current SOI.  Used after warp to SOI or launch to orbit.  Do NOT use if orbit near circular.',
  inputSchema: {
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

      // Check if already circular - return early to prevent loop
      // Use both eccentricity AND altitude ratio to determine if circular
      const orbitCheck = await conn.execute(
        'PRINT ROUND(ORBIT:ECCENTRICITY, 4) + "|" + ROUND(APOAPSIS/1000) + "|" + ROUND(PERIAPSIS/1000).'
      );
      const parts = orbitCheck.output.split('|').map(s => s.trim());
      const currentEcc = Number.parseFloat(parts[0]?.match(/[\d.]+/)?.[0] ?? '1');
      const apoKm = Number.parseFloat(parts[1] ?? '0');
      const peKm = Number.parseFloat(parts[2] ?? '0');

      // Consider circular if: ecc < 0.02 OR (ecc < 0.1 AND altitudes within 15%)
      const altRatio = peKm > 0 ? apoKm / peKm : 999;
      const isCircular = currentEcc < 0.02 || (currentEcc < 0.1 && altRatio < 1.18 && altRatio > 0.85);

      if (isCircular) {
        return ctx.successResponse('circularize',
          `Orbit is already circular (${apoKm}km x ${peKm}km, ecc=${currentEcc.toFixed(4)}). No circularization needed.`);
      }

      // Auto-detect best timeRef if 'auto'
      let timeRef = args.timeRef as string;
      if (timeRef === 'auto') {
        const orbitInfo = await conn.execute(
          'PRINT SHIP:ORBIT:ECCENTRICITY + "|" + ETA:APOAPSIS + "|" + ETA:PERIAPSIS.'
        );
        const parts = orbitInfo.output.split('|').map(s => Number.parseFloat(s.trim()));
        const [ecc, etaApo, etaPe] = parts;

        if (ecc >= 1) {
          timeRef = 'PERIAPSIS';  // Hyperbolic orbit - no apoapsis
        } else {
          timeRef = etaApo < etaPe ? 'APOAPSIS' : 'PERIAPSIS';  // Nearest apse
        }
      }

      const orchestrator = new ManeuverOrchestrator(conn);
      const result = await orchestrator.circularize(timeRef, {
        execute: args.execute as boolean,
        logger,
        callerTool: 'circularize',
      });

      if (result.success) {
        const execInfo = result.executed ? ' (executed)' : '';
        let text = `Node: ${result.deltaV != null ? fmtNum(result.deltaV) : '?'} m/sec, T-${formatTime(result.timeToNode ?? 0)}${execInfo}`;

        // Show resulting orbit after execution
        if (result.executed) {
          text += await formatResultingOrbit(conn);

          // Check if orbit is now circular enough - tell LLM explicitly
          const orbitCheck = await conn.execute(
            'PRINT ROUND(ORBIT:ECCENTRICITY, 4) + "|" + ROUND(APOAPSIS/1000) + "|" + ROUND(PERIAPSIS/1000).'
          );
          const parts = orbitCheck.output.split('|').map(s => s.trim());
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
