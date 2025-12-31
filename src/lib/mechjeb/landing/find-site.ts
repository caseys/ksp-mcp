/**
 * Smart Landing Site Selection
 *
 * Finds an optimal landing site along the orbital ground track with:
 * - Sunlight (site is illuminated)
 * - Radio contact (line-of-sight to Kerbin)
 * - Low terrain (altitude proxy for flat lowlands)
 *
 * Auto-relaxes requirements if no perfect site found.
 */

import { z } from 'zod';
import type { ToolDefinition } from '../../tool-types.js';
import type { KosConnection } from '../../../transport/kos-connection.js';
import { setLandingPositionTarget } from './shared.js';

// ============================================================================
// Types
// ============================================================================

export interface LandingSiteResult {
  found: boolean;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  ut?: number;
  timeFromNow?: number;
  sunlit: boolean;
  radioContact: boolean;
  relaxedRequirements?: string;
  formatted: string;
}

export interface FindSiteOptions {
  maxAltitude?: number;
  searchWindow?: number;
  searchStep?: number;
}

// ============================================================================
// Core Function
// ============================================================================

/**
 * Find an optimal landing site along the orbital ground track.
 *
 * Search strategy:
 * 1. Center search on terminator (midpoint between sun and Kerbin directions)
 * 2. Search ±window seconds around that point
 * 3. Filter by altitude (low terrain = flat lowlands proxy)
 * 4. Filter by sunlight and radio contact
 * 5. Auto-relax soft requirements if no perfect site found
 */
export async function findLandingSite(
  conn: KosConnection,
  options: FindSiteOptions = {}
): Promise<LandingSiteResult> {
  const {
    maxAltitude = 4000,
    searchWindow = 2400,
    searchStep = 20,
  } = options;

  // Build the kOS script for site finding
  // We'll run multiple passes with different requirements
  const passes = [
    { requireSun: true, requireRadio: true, label: 'sun+radio' },
    { requireSun: true, requireRadio: false, label: 'sun only' },
    { requireSun: false, requireRadio: true, label: 'radio only' },
    { requireSun: false, requireRadio: false, label: 'terrain only' },
  ];

  for (const pass of passes) {
    const result = await runSiteSearch(conn, {
      maxAltitude,
      searchWindow,
      searchStep,
      requireSun: pass.requireSun,
      requireRadio: pass.requireRadio,
    });

    if (result.found) {
      // Determine if we relaxed requirements
      let relaxed: string | undefined;
      switch (pass.label) {
      case 'sun only': {
      relaxed = 'No radio contact (far side of body)';
      break;
      }
      case 'radio only': {
      relaxed = 'No sunlight (night side)';
      break;
      }
      case 'terrain only': {
      relaxed = 'No sunlight or radio contact';
      // No default
      }
      break;
      }

      return {
        ...result,
        relaxedRequirements: relaxed,
      };
    }
  }

  // No site found even with all requirements relaxed
  return {
    found: false,
    sunlit: false,
    radioContact: false,
    formatted: 'No suitable landing site found along orbital ground track. Try adjusting maxAltitude or orbit.',
  };
}

/**
 * Run a single site search pass with specific requirements.
 */
async function runSiteSearch(
  conn: KosConnection,
  options: {
    maxAltitude: number;
    searchWindow: number;
    searchStep: number;
    requireSun: boolean;
    requireRadio: boolean;
  }
): Promise<LandingSiteResult> {
  const { maxAltitude, searchWindow, searchStep, requireSun, requireRadio } = options;

  // Check if we're in Kerbin SOI (for radio contact check)
  const soiCheck = await conn.execute(
    'IF SHIP:BODY:BODY:NAME = "Kerbin" OR SHIP:BODY:NAME = "Kerbin" { PRINT "KERBIN_SOI". } ELSE { PRINT "OTHER_SOI". }',
    3000
  );
  const inKerbinSOI = soiCheck.output.includes('KERBIN_SOI');

  // Build kOS script (no // comments - they break when newlines are removed!)
  const script = `
SET sb TO SHIP:BODY.
SET sun_pos TO SUN:POSITION.
SET kerbin_pos TO BODY("Kerbin"):POSITION.
SET max_alt TO ${maxAltitude}.
SET window TO ${searchWindow}.
SET step TO ${searchStep}.
SET require_sun TO ${requireSun ? 'TRUE' : 'FALSE'}.
SET require_radio TO ${requireRadio && inKerbinSOI ? 'TRUE' : 'FALSE'}.
SET sb_pos TO sb:POSITION.
SET sun_dir TO (sun_pos - sb_pos):NORMALIZED.
SET kerbin_dir TO (kerbin_pos - sb_pos):NORMALIZED.
SET period TO SHIP:ORBIT:PERIOD.
SET min_approach TO period / 16.
SET found TO FALSE.
SET result_lat TO 0.
SET result_lng TO 0.
SET result_alt TO 0.
SET result_ut TO 0.
SET result_sun TO FALSE.
SET result_radio TO FALSE.
SET dt TO min_approach.
UNTIL dt > (min_approach + period) OR found {
  SET ut TO TIME:SECONDS + dt.
  IF ut > TIME:SECONDS {
    SET pos TO POSITIONAT(SHIP, ut).
    SET geo TO sb:GEOPOSITIONOF(pos).
    SET alt_est TO geo:TERRAINHEIGHT.
    IF alt_est <= max_alt {
      SET surf_pos TO geo:POSITION.
      SET upVec TO (surf_pos - sb:POSITION):NORMALIZED.
      SET sun_angle TO VANG(upVec, sun_pos - surf_pos).
      SET is_sunlit TO sun_angle < 90.
      SET kerbin_angle TO VANG(upVec, kerbin_pos - surf_pos).
      SET has_radio TO kerbin_angle < 90.
      SET sun_ok TO (NOT require_sun) OR is_sunlit.
      SET radio_ok TO (NOT require_radio) OR has_radio.
      IF sun_ok AND radio_ok {
        SET found TO TRUE.
        SET result_lat TO geo:LAT.
        SET result_lng TO geo:LNG.
        SET result_alt TO alt_est.
        SET result_ut TO ut.
        SET result_sun TO is_sunlit.
        SET result_radio TO has_radio.
      }
    }
  }
  SET dt TO dt + step.
}
IF found {
  PRINT "SITE|" + result_lat + "|" + result_lng + "|" + ROUND(result_alt) + "|" + ROUND(result_ut) + "|" + result_sun + "|" + result_radio.
} ELSE {
  PRINT "SITE|NONE".
}
`.trim().replaceAll('\n', ' ');

  const result = await conn.execute(script, 30_000);

  // Parse result
  const match = result.output.match(/SITE\|([-\d.]+)\|([-\d.]+)\|([-\d]+)\|([-\d]+)\|(True|False)\|(True|False)/i);

  if (match) {
    const latitude = Number.parseFloat(match[1]);
    const longitude = Number.parseFloat(match[2]);
    const altitude = Number.parseInt(match[3]);
    const ut = Number.parseInt(match[4]);
    const sunlit = match[5].toLowerCase() === 'true';
    const radioContact = match[6].toLowerCase() === 'true';

    // Get current time to calculate timeFromNow
    const timeResult = await conn.execute('PRINT ROUND(TIME:SECONDS).', 3000);
    const currentTime = Number.parseInt(timeResult.output.match(/(\d+)/)?.[1] ?? '0');
    const timeFromNow = ut - currentTime;

    // Build formatted output
    let formatted = `Landing site found: ${latitude.toFixed(3)}°, ${longitude.toFixed(3)}°\n`;
    formatted += `Terrain altitude: ${altitude} m\n`;
    formatted += `Time to overflight: ${formatTime(timeFromNow)}\n`;
    formatted += `Sunlit: ${sunlit ? 'yes' : 'no'}\n`;
    formatted += `Radio contact: ${radioContact ? 'yes' : 'no'}`;

    return {
      found: true,
      latitude,
      longitude,
      altitude,
      ut,
      timeFromNow,
      sunlit,
      radioContact,
      formatted,
    };
  }

  return {
    found: false,
    sunlit: false,
    radioContact: false,
    formatted: 'No site found with current requirements.',
  };
}

function formatTime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// ============================================================================
// Tool Definition
// ============================================================================

export const findLandingSiteTool: ToolDefinition = {
  name: 'find_landing_site',
  description:
    'Find optimal landing site along orbital ground track. Selects location with sunlight, ' +
    'radio contact (Kerbin LOS), and low terrain. Auto-relaxes requirements if needed. ' +
    'Sets position target - use with land tool or call land directly after.',
  inputSchema: {
    maxAltitude: z.number()
      .optional()
      .default(4000)
      .describe('Maximum terrain altitude in meters (default 4000m allows midlands)'),
    searchWindow: z.number()
      .optional()
      .default(2400)
      .describe('Seconds of orbital arc to search'),
    searchStep: z.number()
      .optional()
      .default(20)
      .describe('Seconds between sample points'),
  },
  annotations: {
    readOnlyHint: false,  // Sets position target
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 3,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();

      const result = await findLandingSite(conn, {
        maxAltitude: args.maxAltitude as number | undefined,
        searchWindow: args.searchWindow as number | undefined,
        searchStep: args.searchStep as number | undefined,
      });

      if (!result.found) {
        return ctx.errorResponse('find_landing_site', result.formatted);
      }

      // Set position target with found coordinates
      const setResult = await setLandingPositionTarget(conn, result.latitude!, result.longitude!);
      if (!setResult.success) {
        return ctx.errorResponse('find_landing_site',
          `Found site but failed to set target: ${setResult.error}`);
      }

      let message = result.formatted;
      if (result.relaxedRequirements) {
        message += `\n\nNote: ${result.relaxedRequirements}`;
      }
      message += '\n\nPosition target set. Ready for landing.';

      return ctx.successResponse('find_landing_site', message);
    } catch (error) {
      return ctx.errorResponse(
        'find_landing_site',
        error instanceof Error ? error.message : String(error)
      );
    }
  },
};
