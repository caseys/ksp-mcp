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
 * Uses cached _MCP_MOONS, _MCP_PLANETS, _MCP_VESSELS when available
 * (set by mcp_env.ks), falling back to LIST BODIES/TARGETS if not.
 *
 * @param conn kOS connection
 */
export async function listTargets(conn: KosConnection): Promise<ListTargetsResult> {
  // Use cached moon/planet/vessel lists - only query distances
  // Compute the "relevant parent" for moon filtering:
  // - Orbiting Kerbin: show Kerbin's moons (Mun, Minmus)
  // - Orbiting Mun: show Kerbin's moons (siblings)
  // - Orbiting Sun: no moons to show
  // Initialize env if not already set (inline, no extra round-trip)
  // Use extensionless path - kOS prefers .ksm, falls back to .ks
  // Use cached moon/planet lists but scan vessels fresh (they can be destroyed anytime)
  const cmd = [
    'IF NOT (DEFINED _MCP_MOONS) { RUNPATH("1:/boot/mcp_env", "boot"). }',
    'LOCAL _soi IS SHIP:BODY:NAME.',
    'LOCAL _moonParent IS _soi.',
    'IF _MCP_BODIES:HASKEY(_soi) { IF _MCP_BODIES[_soi]["parent"] <> "Sun" { SET _moonParent TO _MCP_BODIES[_soi]["parent"]. } }',
    'FOR n IN _MCP_MOONS { IF n <> _soi AND _MCP_BODIES[n]["parent"] = _moonParent { LOCAL b IS BODY(n). PRINT "MOON|" + n + "|" + ROUND((b:POSITION - SHIP:POSITION):MAG). } }',
    'FOR n IN _MCP_PLANETS { IF n <> _soi { LOCAL b IS BODY(n). PRINT "PLANET|" + n + "|" + ROUND((b:POSITION - SHIP:POSITION):MAG). } }',
    // Scan vessels fresh - cached _MCP_VESSELS can become stale when vessels are destroyed
    'LOCAL _tgts IS LIST(). LIST TARGETS IN _tgts. FOR t IN _tgts { IF t <> SHIP AND t:BODY = SHIP:BODY { PRINT "VESSEL|" + t:NAME + "|" + ROUND((t:POSITION - SHIP:POSITION):MAG). } }',
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
