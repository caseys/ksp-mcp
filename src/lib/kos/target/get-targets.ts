/**
 * Get Targets - List all available targets
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import type { ToolDefinition } from '../../tool-types.js';
import type { ListTargetsResult } from './types.js';
import { formatDistance } from './shared.js';

/**
 * List all targetable bodies and vessels sorted by distance.
 *
 * Returns all celestial bodies in the solar system and all vessels
 * in the current SOI, both sorted by distance from ship.
 *
 * @param conn kOS connection
 */
export async function listTargets(conn: KosConnection): Promise<ListTargetsResult> {
  // Single atomic kOS command that lists bodies and vessels with distances
  // Categorizes bodies as MOON (of parent planet) or PLANET (orbits Sun)
  // Excludes current body and Sun from all lists
  const cmd = [
    'LIST BODIES IN bods.',
    'LIST TARGETS IN tgts.',
    'SET parentBody TO SHIP:BODY.',
    'IF parentBody:BODY:NAME <> "Sun" { SET parentBody TO parentBody:BODY. }',
    'FOR b IN bods { IF b <> SHIP:BODY AND b:NAME <> "Sun" { IF b:BODY:NAME = "Sun" { PRINT "PLANET|" + b:NAME + "|" + ROUND((b:POSITION - SHIP:POSITION):MAG). } ELSE IF b:BODY = parentBody { PRINT "MOON|" + b:NAME + "|" + ROUND((b:POSITION - SHIP:POSITION):MAG). } } }',
    'FOR t IN tgts { IF t <> SHIP AND t:BODY = SHIP:BODY { PRINT "VESSEL|" + t:NAME + "|" + ROUND((t:POSITION - SHIP:POSITION):MAG). } }',
    'PRINT "LIST_DONE".',
  ].join(' ');

  // Reduced from 10s to 3s - fail fast if kOS is slow
  const result = await conn.execute(cmd, 3000);
  const output = result.output;

  // Parse moons
  const moons: Array<{ name: string; distance: number }> = [];
  const moonRegex = /MOON\|([^|]+)\|(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = moonRegex.exec(output)) !== null) {
    moons.push({ name: match[1], distance: Number.parseInt(match[2]) });
  }

  // Parse planets
  const planets: Array<{ name: string; distance: number }> = [];
  const planetRegex = /PLANET\|([^|]+)\|(\d+)/g;
  while ((match = planetRegex.exec(output)) !== null) {
    planets.push({ name: match[1], distance: Number.parseInt(match[2]) });
  }

  // Parse vessels
  const vessels: Array<{ name: string; distance: number }> = [];
  const vesselRegex = /VESSEL\|([^|]+)\|(\d+)/g;
  while ((match = vesselRegex.exec(output)) !== null) {
    vessels.push({ name: match[1], distance: Number.parseInt(match[2]) });
  }

  // Sort by distance (nearest first)
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
  tier: 3,
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
