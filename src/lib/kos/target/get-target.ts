/**
 * Get Target - Show current navigation target
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import type { ToolDefinition } from '../../tool-types.js';
import type { GetTargetInfo } from './types.js';
import { fmtVel } from '../../utils/format.js';

/**
 * Get detailed information about the current target.
 *
 * Returns target name, type, distance, and type-specific details:
 * - Bodies: radius, orbital altitude
 * - Vessels: relative velocity
 *
 * @param conn kOS connection
 */
export async function getTargetInfo(conn: KosConnection): Promise<GetTargetInfo> {
  // Use queue() for clean output extraction
  const result = await conn.queue(
    'IF HASTARGET { ' +
    '  PRINT "TGT_NAME|" + TARGET:NAME. ' +
    '  PRINT "TGT_TYPE|" + TARGET:TYPENAME. ' +
    '  PRINT "TGT_DIST|" + ROUND(TARGET:DISTANCE / 1000, 1). ' +
    '  IF TARGET:TYPENAME = "Body" { ' +
    '    PRINT "TGT_RAD|" + ROUND(TARGET:RADIUS / 1000, 1). ' +
    '    PRINT "TGT_ALT|" + ROUND(TARGET:ALTITUDE / 1000, 1). ' +
    '  } ELSE IF TARGET:TYPENAME = "Vessel" { ' +
    '    PRINT "TGT_VEL|" + ROUND(TARGET:VELOCITY:ORBIT:MAG, 1). ' +
    '  } ' +
    '} ELSE { ' +
    '  PRINT "TGT_NONE". ' +
    '}',
    5000
  );

  if (!result.success) {
    return { hasTarget: false };
  }

  const output = result.output;
  const markers = ['TGT_NAME|', 'TGT_TYPE|', 'TGT_DIST|', 'TGT_RAD|', 'TGT_ALT|', 'TGT_VEL|', 'TGT_NONE'];

  const findMarker = (token: string, start = 0): number => {
    let idx = output.indexOf(token, start);
    while (idx !== -1) {
      // Ignore command echo: it always appears inside quotes
      const prevChar = idx > 0 ? output[idx - 1] : '';
      if (prevChar !== '"') {
        return idx;
      }
      idx = output.indexOf(token, idx + token.length);
    }
    return -1;
  };

  const findNextMarker = (start: number): number => {
    let next = -1;
    for (const token of markers) {
      const idx = findMarker(token, start);
      if (idx !== -1 && (next === -1 || idx < next)) {
        next = idx;
      }
    }
    return next;
  };

  const extractValue = (token: string): string | undefined => {
    const start = findMarker(token);
    if (start === -1) return undefined;
    const valueStart = start + token.length;
    const next = findNextMarker(valueStart);
    const raw = next === -1 ? output.slice(valueStart) : output.slice(valueStart, next);
    return raw.trim();
  };

  const noneMarker = findMarker('TGT_NONE');
  const name = extractValue('TGT_NAME|');
  if (noneMarker !== -1 && !name) {
    return { hasTarget: false };
  }

  const type = extractValue('TGT_TYPE|');
  const distanceKm = extractValue('TGT_DIST|');
  const radiusKm = extractValue('TGT_RAD|');
  const altKm = extractValue('TGT_ALT|');
  const velocity = extractValue('TGT_VEL|');

  const detailLines: string[] = [];
  if (name) detailLines.push(`Target: ${name}`);
  if (type) detailLines.push(`Type: ${type}`);
  if (distanceKm !== undefined) detailLines.push(`Distance: ${distanceKm} km`);
  if (radiusKm) detailLines.push(`Radius: ${radiusKm} km`);
  if (altKm) detailLines.push(`Orbital altitude: ${altKm} km`);
  if (velocity) detailLines.push(`Relative velocity: ${fmtVel(Number.parseFloat(velocity))}`);

  return {
    hasTarget: true,
    name,
    type,
    distance: distanceKm ? Number.parseFloat(distanceKm) * 1000 : undefined,
    details: detailLines.join('\n')
  };
}

// ============================================================================
// Tool Definition
// ============================================================================

// Tool replaced by unified get_target_info in mechjeb/targeting
const _getTargetTool: ToolDefinition = {
  name: 'get_target',
  description: 'Show current navigation target.',
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

      const info = await getTargetInfo(conn);
      if (!info.hasTarget) {
        return ctx.successResponse('get_target', 'No target set.');
      }

      return ctx.successResponse('get_target', info.details ?? `Target: ${info.name}`);
    } catch (error) {
      return ctx.errorResponse('get_target', error instanceof Error ? error.message : String(error));
    }
  },
};
