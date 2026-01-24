/**
 * Get Targets - List all available targets
 *
 * Uses the unified status JSON format - targets are now included in status output.
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import type { ToolDefinition } from '../../tool-types.js';
import type { ListTargetsResult } from './types.js';
import { formatDistance } from './shared.js';
import { getStatusData } from '../../mechjeb/telemetry.js';

/**
 * List all targetable bodies and vessels sorted by distance.
 *
 * Returns all celestial bodies in the solar system and all vessels
 * in the current SOI, both sorted by distance from ship.
 *
 * Now uses the unified status JSON which includes targets directly.
 *
 * @param conn kOS connection
 */
export async function listTargets(conn: KosConnection): Promise<ListTargetsResult> {
  // Get status data which now includes targets
  const status = await getStatusData(conn);

  // Separate targets by type
  const moons: Array<{ name: string; distance: number }> = [];
  const planets: Array<{ name: string; distance: number }> = [];
  const vessels: Array<{ name: string; distance: number }> = [];

  for (const target of status.targets) {
    const entry = { name: target.name, distance: target.distance };
    switch (target.type) {
      case 'moon':
        moons.push(entry);
        break;
      case 'planet':
        planets.push(entry);
        break;
      case 'vessel':
        vessels.push(entry);
        break;
    }
  }

  // Sort by distance (nearest first) - should already be sorted but ensure consistency
  moons.sort((a, b) => a.distance - b.distance);
  planets.sort((a, b) => a.distance - b.distance);
  vessels.sort((a, b) => a.distance - b.distance);

  // Format output (cap at 15 each)
  const MAX_DISPLAY = 15;
  const lines: string[] = [];

  if (moons.length > 0) {
    lines.push('=== Moons (nearby) ===');
    for (const m of moons.slice(0, MAX_DISPLAY)) {
      lines.push(`${m.name}: ${formatDistance(m.distance)}`);
    }
    if (moons.length > MAX_DISPLAY) {
      lines.push(`... and ${moons.length - MAX_DISPLAY} more`);
    }
  }

  lines.push(lines.length > 0 ? '' : '', '=== Planets ===');
  for (const p of planets.slice(0, MAX_DISPLAY)) {
    lines.push(`${p.name}: ${formatDistance(p.distance)}`);
  }
  if (planets.length > MAX_DISPLAY) {
    lines.push(`... and ${planets.length - MAX_DISPLAY} more`);
  }

  if (vessels.length > 0) {
    lines.push('', '=== Vessels in SOI ===');
    for (const v of vessels.slice(0, MAX_DISPLAY)) {
      lines.push(`${v.name}: ${formatDistance(v.distance)}`);
    }
    if (vessels.length > MAX_DISPLAY) {
      lines.push(`... and ${vessels.length - MAX_DISPLAY} more`);
    }
  }

  return {
    moons,
    planets,
    vessels,
    formatted: lines.join('\n'),
  };
}

// ============================================================================
// Tool Definition
// ============================================================================

export const getTargetsTool: ToolDefinition = {
  name: 'get_targets',
  description: 'List all moons, planets, and vessels you can travel to.',
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 2,
  handler: async (_args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const result = await listTargets(conn);
      return ctx.successResponse('get_targets', JSON.stringify(result, null, 2));
    } catch (error) {
      return ctx.errorResponse('get_targets', error instanceof Error ? error.message : String(error));
    }
  },
};
