import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  handleDisconnect,
  handleExecute,
  getConnection,
  ensureConnected,
  setCpuPreference,
  getCpuPreference,
  forceDisconnect,
} from '../transport/connection-tools.js';
import {
  listCpusInputSchema,
  handleListCpus,
} from '../transport/list-cpus.js';
import {
  CONNECTION_GUIDE,
  CPU_MENU_FORMAT,
  TRANSPORT_OPTIONS,
} from '../config/mcp-resources.js';
import { AscentProgram, AscentHandle } from '../lib/mechjeb/ascent.js';
import { clearNodes } from '../lib/kos/nodes.js';
import { getShipTelemetry, getStatus, formatTargetEncounterInfo, type ShipTelemetryOptions } from '../lib/mechjeb/telemetry.js';
import { queryTargetEncounterInfo } from '../lib/mechjeb/shared.js';
import { ManeuverOrchestrator } from '../lib/mechjeb/orchestrator.js';
import { executeNode } from '../lib/mechjeb/execute-node.js';
import { warpTo, warpForward, WarpTarget } from '../lib/kos/warp.js';
import { crashAvoidance } from '../lib/kos/crash-avoidance.js';
import { globalKosMonitor } from '../utils/kos-monitor.js';
import { listQuicksaves, quicksave, quickload } from '../lib/kos/kuniverse.js';
import { runScript } from '../lib/kos/run-script.js';

// Track current ascent handle for status/abort
let currentAscentHandle: AscentHandle | null = null;

const INLINE_TELEMETRY_OPTIONS: ShipTelemetryOptions = {
  timeoutMs: 2500,  // Per-query timeout (max 2 queries = 5s max)
};

const FULL_TELEMETRY_OPTIONS: ShipTelemetryOptions = {
  timeoutMs: 3000,  // Per-query timeout for standalone telemetry (max 2 queries = 6s max)
};

/**
 * Clear the current ascent handle.
 * Called when disconnecting to prevent stale handle issues.
 */
export function clearAscentHandle(): void {
  currentAscentHandle = null;
}

const DEBUG = process.env.KSP_MCP_DEBUG === '1';

/**
 * Helper to create a success response.
 */
function successResponse(action: string, text: string) {
  return {
    content: [{ type: 'text' as const, text }],
  };
}

/**
 * Helper to create an error response.
 * In debug mode, includes the raw error details.
 */
function errorResponse(action: string, error: string) {
  const text = DEBUG ? `${action}: ${error}` : error;
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  };
}

/**
 * Common zod schema for the execute parameter
 */
const executeSchema = z.boolean()
  .optional()
  .default(true)
  .describe('Execute the maneuver node after planning. Optional, defaults to true.');

/**
 * Stock KSP celestial bodies for fuzzy matching.
 * Keys are canonical names, values are common misspellings/STT errors.
 * Spaces in aliases are removed during matching.
 */
const KSP_BODIES: Record<string, string[]> = {
  // Kerbol system star
  'Sun': ['sol', 'kerbol', 'star', 'the sun', 'son'],
  // Inner planets - Moho (Mercury analog)
  'Moho': ['mojo', 'mo ho', 'moo ho', 'mohoe', 'moho'],
  // Eve system (Venus analog)
  'Eve': ['eva', 'eave', 'eev', 'eve', 'eves'],
  'Gilly': ['gillie', 'ghillie', 'jilly', 'gill e', 'gily', 'gilley'],
  // Kerbin system (Earth analog)
  'Kerbin': ['kirbin', 'kerban', 'curbing', 'carbon', 'curbin', 'kerben', 'kirben', 'curb in', 'curve in'],
  'Mun': ['moon', 'munn', 'the mun', 'mune', 'mon', 'the moon'],
  'Minmus': ['minimus', 'minimum', 'mimmus', 'minmas', 'min mouse', 'min mus', 'minimums', 'min miss', 'minmis', 'minmes'],
  // Duna system (Mars analog)
  'Duna': ['dune', 'doona', 'donna', 'tuna', 'duner', 'do na', 'dune a', 'dunah', 'djna'],
  'Ike': ['ik', 'ica', 'iky', 'ike', 'mike', 'bike', 'like'],
  // Dres (Ceres analog)
  'Dres': ['dress', 'drez', 'drес', 'dressed', 'dris', 'drace'],
  // Jool system (Jupiter analog)
  'Jool': ['jule', 'joel', 'jewel', 'joule', 'jul', 'jewl', 'drool', 'juel', 'juul', 'joole'],
  'Laythe': ['lathe', 'laith', 'lath', 'late', 'lay the', 'lazy', 'lathey', 'laythee', 'laitha'],
  'Vall': ['val', 'wall', 'vaal', 'vahl', 'vol', 'ball', 'fall', 'vahl'],
  'Tylo': ['tilo', 'taylo', 'tyelow', 'tyler', 'tile', 'tile oh', 'ty lo', 'tyo', 'tallo'],
  'Bop': ['bob', 'bopp', 'pop', 'bap', 'bahp', 'baup'],
  'Pol': ['poll', 'pole', 'paul', 'pall', 'pull', 'pawl'],
  // Eeloo (Pluto analog)
  'Eeloo': ['eloo', 'elu', 'eelu', 'yellow', 'ee loo', 'eelou', 'elou', 'eelo', 'pluto'],
};

/**
 * Calculate Levenshtein distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] = b[i - 1] === a[j - 1]
        ? matrix[i - 1][j - 1]
        : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Find the best matching KSP body name for a given input.
 * Returns the canonical name if a good match is found, otherwise the original input.
 * Removes whitespace to handle STT errors like "min mouse" -> "Minmus".
 */
function matchTargetName(input: string): string {
  // Remove whitespace for matching (STT often adds spaces: "min mouse" for "Minmus")
  const normalized = input.toLowerCase().trim().replaceAll(/\s+/g, '');

  // First check exact match on canonical names (case-insensitive)
  for (const canonical of Object.keys(KSP_BODIES)) {
    if (canonical.toLowerCase() === normalized) return canonical;
  }

  // Check aliases/misspellings (also with spaces removed)
  for (const [canonical, aliases] of Object.entries(KSP_BODIES)) {
    for (const alias of aliases) {
      if (alias.toLowerCase().replaceAll(/\s+/g, '') === normalized) return canonical;
    }
  }

  // Fuzzy match using Levenshtein distance
  let bestMatch = input;
  let bestScore = Infinity;
  const maxDistance = Math.max(2, Math.floor(normalized.length * 0.4)); // Allow ~40% errors

  for (const canonical of Object.keys(KSP_BODIES)) {
    const distance = levenshtein(normalized, canonical.toLowerCase());
    if (distance < bestScore && distance <= maxDistance) {
      bestScore = distance;
      bestMatch = canonical;
    }
  }

  // Also check aliases for fuzzy match (with spaces removed)
  for (const [canonical, aliases] of Object.entries(KSP_BODIES)) {
    for (const alias of aliases) {
      const aliasNorm = alias.toLowerCase().replaceAll(/\s+/g, '');
      const distance = levenshtein(normalized, aliasNorm);
      if (distance < bestScore && distance <= maxDistance) {
        bestScore = distance;
        bestMatch = canonical;
      }
    }
  }

  return bestMatch;
}

/**
 * Preprocess target name to handle common misspellings and STT errors.
 * Only processes strings; non-strings pass through unchanged.
 */
function parseTarget(val: unknown): string | unknown {
  if (typeof val !== 'string') return val;
  return matchTargetName(val);
}

/**
 * Common zod schema for the optional target parameter.
 * Preprocesses input to fuzzy-match against known KSP body names.
 */
const targetSchema = z.preprocess(parseTarget, z.string())
  .optional()
  .describe('Target name (body or vessel). Use get_targets to list available names. If omitted, uses current target.');

/**
 * Optional target schema with auto-selection capability.
 * Preprocesses input to fuzzy-match against known KSP body names.
 * When target is not provided and no target is set, auto-selects closest non-SOI body.
 */
const autoTargetSchema = z.preprocess(parseTarget, z.string())
  .optional()
  .describe('Target name. Use get_targets to list available names. If omitted, auto-selects based on tool.');

/**
 * Parse distance string with optional units (km, m, Mm) to meters.
 * Handles LLM outputs like "50km" or "100m" and converts to meters.
 */
function parseDistance(val: unknown): number | unknown {
  if (typeof val === 'number') return val;
  if (typeof val !== 'string') return val;

  const match = val.trim().match(/^([\d.]+)\s*(km|m|Mm)?$/i);
  if (!match) return val; // Let Zod handle invalid input

  const num = Number.parseFloat(match[1]);
  const unit = (match[2] || 'm').toLowerCase();

  switch (unit) {
    case 'km': return num * 1000;
    case 'mm': return num * 1_000_000;
    default: return num; // meters
  }
}

/**
 * Zod schema for distance values that accepts numbers or strings with units.
 * Examples: 50000, "50km", "100m", "1.5Mm"
 */
const distanceSchema = z.preprocess(parseDistance, z.number());

/**
 * Target selection modes for auto-select
 */
type TargetSelectMode =
  | 'closest-body'      // Closest body (excluding SOI) - for hohmann_transfer
  | 'closest-vessel'    // Closest vessel - for match_planes, match_velocities
  | 'furthest-body'     // Furthest body - for interplanetary_transfer
  | 'second-closest';   // 2nd closest body (excluding SOI) - for set_target, course_correct

/**
 * Auto-select a target based on mode.
 * Returns null if a target is already set (unless checkExisting=false) or no suitable target found.
 */
async function selectTarget(
  orchestrator: ManeuverOrchestrator,
  mode: TargetSelectMode,
  checkExisting: boolean = true
): Promise<string | null> {
  // Check if target already set
  if (checkExisting && await orchestrator.hasTarget()) {
    return null; // Already has target, no auto-select needed
  }

  // Get current SOI body to exclude from body selections
  const soiBody = await orchestrator.getSOIBody();

  // Get all targets sorted by distance
  const targets = await orchestrator.listTargets();

  // Filter bodies to exclude SOI body
  const nonSOIBodies = targets.bodies.filter(
    b => b.name.toLowerCase() !== soiBody.toLowerCase()
  );

  switch (mode) {
    case 'closest-body':
      return nonSOIBodies[0]?.name ?? null;

    case 'closest-vessel':
      return targets.vessels[0]?.name ?? null;

    case 'furthest-body':
      return nonSOIBodies.at(-1)?.name ?? null;

    case 'second-closest':
      return nonSOIBodies[1]?.name ?? nonSOIBodies[0]?.name ?? null;

    default:
      return null;
  }
}

// Convenience wrapper for backward compatibility
async function selectClosestTarget(orchestrator: ManeuverOrchestrator): Promise<string | null> {
  return selectTarget(orchestrator, 'closest-body');
}

/**
 * Get current orbit info (periapsis, apoapsis, altitude)
 */
async function getOrbitInfo(conn: ReturnType<typeof getConnection>): Promise<{
  periapsis: number;
  apoapsis: number;
  altitude: number;
} | null> {
  if (!conn) return null;
  try {
    const result = await conn.execute(
      'PRINT SHIP:ORBIT:PERIAPSIS + "|" + SHIP:ORBIT:APOAPSIS + "|" + SHIP:ALTITUDE.',
      3000
    );
    const match = result.output.match(/([\d.]+)\|([\d.]+)\|([\d.]+)/);
    if (match) {
      return {
        periapsis: parseFloat(match[1]),
        apoapsis: parseFloat(match[2]),
        altitude: parseFloat(match[3]),
      };
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Get default launch altitude: atmosphere height + 20km, or 20km if no atmosphere
 */
async function getDefaultLaunchAltitude(conn: ReturnType<typeof getConnection>): Promise<number> {
  const DEFAULT_ALTITUDE = 80_000; // 80km fallback (Kerbin-like)
  if (!conn) return DEFAULT_ALTITUDE;
  try {
    const result = await conn.execute(
      'IF SHIP:BODY:ATM:EXISTS { PRINT SHIP:BODY:ATM:HEIGHT. } ELSE { PRINT 0. }',
      3000
    );
    const match = result.output.match(/([\d.]+)/);
    if (match) {
      const atmHeight = parseFloat(match[1]);
      return atmHeight > 0 ? atmHeight + 20_000 : 20_000;
    }
  } catch {
    // Ignore errors
  }
  return DEFAULT_ALTITUDE;
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'ksp-mcp',
    version: '0.3.0',
  });

  // Register connection tools
  // Note: 'connect' is intentionally not exposed - all tools auto-connect via ensureConnected()

  server.registerTool(
    'launch_ascent',
    {
      description: 'Launch into orbit. Circularizes after ascent by default.',
      inputSchema: {
        altitude: distanceSchema.optional().describe('Target orbit altitude in meters (default: atmosphere + 20km, or 20km if no atmosphere)'),
        inclination: z.number().optional().default(0).describe('Target orbit inclination in degrees'),
        circularize: z.boolean().optional().default(true).describe('Circularize orbit after ascent (default: true)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { tier: 1 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();

        // Default altitude: atmosphere height + 20km
        const altitude = args.altitude ?? await getDefaultLaunchAltitude(conn);

        const ascent = new AscentProgram(conn);
        currentAscentHandle = await ascent.launchToOrbit({
          altitude,
          inclination: args.inclination,
          circularize: args.circularize,
          autoStage: true,
          autoWarp: true,
        });

        // Wait for ascent to complete (polls every 5 seconds, up to 15 min)
        const result = await currentAscentHandle.waitForCompletion();
        currentAscentHandle = null;

        return result.success ? successResponse('launch_ascent',
            `In orbit: Ap ${Math.round(result.finalOrbit.apoapsis / 1000)}km, Pe ${Math.round(result.finalOrbit.periapsis / 1000)}km`) : errorResponse('launch_ascent', result.aborted ? 'Ascent aborted' : 'Ascent failed');
      } catch (error) {
        return errorResponse('launch_ascent', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'circularize',
    {
      description: 'Make orbit circular. Use after launch or transfer.',
      inputSchema: {
        timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW'])
          .optional()
          .describe('When to circularize. If omitted, auto-picks based on orbit (periapsis for hyperbolic, nearest apse for elliptical)'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 1 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();

        // Auto-detect best timeRef if not specified
        let timeRef = args.timeRef;
        if (!timeRef) {
          const orbitInfo = await conn.execute(
            'PRINT SHIP:ORBIT:ECCENTRICITY + "|" + ETA:APOAPSIS + "|" + ETA:PERIAPSIS.'
          );
          const parts = orbitInfo.output.split('|').map(s => Number.parseFloat(s.trim()));
          const [ecc, etaApo, etaPe] = parts;

          if (ecc >= 1) {
            // Hyperbolic orbit - no apoapsis exists
            timeRef = 'PERIAPSIS';
          } else {
            // Elliptical orbit - pick whichever is sooner
            timeRef = etaApo < etaPe ? 'APOAPSIS' : 'PERIAPSIS';
          }
        }

        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.circularize(timeRef!, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('circularize',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('circularize', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('circularize', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'adjust_apoapsis',
    {
      description: 'Change orbit high point. Use to raise/lower orbit.',
      inputSchema: {
        altitude: distanceSchema.optional().describe('Target apoapsis altitude in meters (default: current + 10km)'),
        timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
          .optional()
          .default('PERIAPSIS')
          .describe('When to execute the maneuver'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);

        // Default altitude: current apoapsis + 10km
        let altitude = args.altitude;
        if (altitude === undefined) {
          const orbitInfo = await getOrbitInfo(conn);
          altitude = orbitInfo ? orbitInfo.apoapsis + 10_000 : 100_000;
        }

        const result = await orchestrator.adjustApoapsis(altitude, args.timeRef, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('adjust_ap',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('adjust_ap', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('adjust_ap', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'adjust_periapsis',
    {
      description: 'Change orbit low point. Use for deorbit or orbit adjustments.',
      inputSchema: {
        altitude: distanceSchema.optional().describe('Target periapsis altitude in meters (default: current - 10km)'),
        timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
          .optional()
          .default('APOAPSIS')
          .describe('When to execute the maneuver'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);

        // Default altitude: current periapsis - 10km (minimum 0)
        let altitude = args.altitude;
        if (altitude === undefined) {
          const orbitInfo = await getOrbitInfo(conn);
          altitude = orbitInfo ? Math.max(0, orbitInfo.periapsis - 10_000) : 50_000;
        }

        const result = await orchestrator.adjustPeriapsis(altitude, args.timeRef, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('adjust_pe',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('adjust_pe', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('adjust_pe', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'ellipticize',
    {
      description: 'Set both orbit high and low points in one maneuver.',
      inputSchema: {
        periapsis: distanceSchema.optional().describe('Target periapsis altitude in meters (default: current periapsis)'),
        apoapsis: distanceSchema.optional().describe('Target apoapsis altitude in meters (default: current apoapsis)'),
        timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
          .optional()
          .default('APOAPSIS')
          .describe('When to execute the maneuver'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);

        // Default to current orbital parameters
        let periapsis = args.periapsis;
        let apoapsis = args.apoapsis;
        if (periapsis === undefined || apoapsis === undefined) {
          const orbitInfo = await getOrbitInfo(conn);
          if (orbitInfo) {
            periapsis = periapsis ?? orbitInfo.periapsis;
            apoapsis = apoapsis ?? orbitInfo.apoapsis;
          } else {
            periapsis = periapsis ?? 70_000;
            apoapsis = apoapsis ?? 70_000;
          }
        }

        const result = await orchestrator.ellipticize(periapsis, apoapsis, args.timeRef, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('ellipticize',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('ellipticize', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('ellipticize', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'change_inclination',
    {
      description: 'Tilt orbit. Use for polar orbit or equatorial orbit.',
      inputSchema: {
        newInclination: z.number().optional().default(0).describe('Target inclination in degrees (default: 0 for equatorial)'),
        timeRef: z.enum(['EQ_ASCENDING', 'EQ_DESCENDING', 'EQ_NEAREST_AD', 'EQ_HIGHEST_AD', 'X_FROM_NOW'])
          .optional()
          .default('EQ_NEAREST_AD')
          .describe('When to execute: at ascending node, descending node, nearest AN/DN, or highest AD'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.changeInclination(args.newInclination, args.timeRef, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('change_inclination',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('change_inclination', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('change_inclination', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'change_ascending_node',
    {
      description: 'Change LAN. Advanced orbital adjustment.',
      inputSchema: {
        lan: z.number().optional().default(90).describe('Target LAN in degrees (0 to 360, default: 90)'),
        timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
          .optional()
          .default('APOAPSIS')
          .describe('When to execute the maneuver'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.changeLAN(args.lan, args.timeRef, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('change_ascending_node',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('change_ascending_node', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('change_ascending_node', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'change_periapsis_longitude',
    {
      description: 'Rotate orbit orientation. Advanced.',
      inputSchema: {
        longitude: z.number().optional().default(90).describe('Target longitude in degrees (-180 to 180, default: 90)'),
        timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
          .optional()
          .default('APOAPSIS')
          .describe('When to execute the maneuver'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.changeLongitude(args.longitude, args.timeRef, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('change_periapsis_longitude',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('change_periapsis_longitude', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('change_periapsis_longitude', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'change_semi_major_axis',
    {
      description: 'Change orbital period. Advanced.',
      inputSchema: {
        semiMajorAxis: distanceSchema.optional().default(1_000_000).describe('Target semi-major axis in meters (default: 1000km)'),
        timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
          .optional()
          .default('APOAPSIS')
          .describe('When to execute the maneuver'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.changeSemiMajorAxis(args.semiMajorAxis, args.timeRef, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('change_semi_major_axis',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('change_semi_major_axis', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('change_semi_major_axis', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'change_eccentricity',
    {
      description: 'Change orbit shape (0=circular). Advanced.',
      inputSchema: {
        eccentricity: z.number().min(0).max(0.99).optional().default(0).describe('Target eccentricity (0 = circular, <1 = elliptical, default: 0)'),
        timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
          .optional()
          .default('APOAPSIS')
          .describe('When to execute the maneuver'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.changeEccentricity(args.eccentricity, args.timeRef, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('change_eccentricity',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('change_eccentricity', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('change_eccentricity', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'hohmann_transfer',
    {
      description: 'Go to a moon or planet. Use for: fly to Mun, navigate to Minmus, transfer to vessel.',
      inputSchema: {
        target: autoTargetSchema,
        timeReference: z.enum(['COMPUTED', 'PERIAPSIS', 'APOAPSIS'])
          .optional()
          .default('COMPUTED')
          .describe('When to execute: COMPUTED (optimal), PERIAPSIS, or APOAPSIS'),
        capture: z.boolean()
          .optional()
          .default(false)
          .describe('Include capture burn for vessel rendezvous. Default: false (transfer only).'),
        execute: executeSchema,
        includeTelemetry: z.boolean()
          .optional()
          .default(false)
          .describe('Include ship telemetry in response (slower but more info)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 1 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);

        // Auto-select target if not provided
        let target = args.target;
        if (!target) {
          const autoTarget = await selectClosestTarget(orchestrator);
          if (autoTarget) {
            target = autoTarget;
          }
        }

        const result = await orchestrator.hohmannTransfer(args.timeReference, args.capture, { target, execute: args.execute });

        if (result.success) {
          const nodeCount = result.nodesCreated ?? 1;
          const execInfo = result.executed ? ' (executed)' : '';
          let text = `${nodeCount} node(s): ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`;

          // Include warning if present (crash trajectory, close approach, etc.)
          if (result.error) {
            text += '\n\n' + result.error;
          }

          if (args.includeTelemetry) {
            // Query target encounter info
            const targetInfo = await queryTargetEncounterInfo(conn);
            if (targetInfo) {
              text += '\n\n' + formatTargetEncounterInfo(targetInfo);
            }
            const telemetry = await getShipTelemetry(conn, INLINE_TELEMETRY_OPTIONS);
            text += '\n\n' + telemetry.formatted;
          }

          return successResponse('hohmann', text);
        } else {
          return errorResponse('hohmann', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('hohmann', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'course_correct',
    {
      description: 'Fine-tune approach after transfer. Adjusts periapsis at destination.',
      inputSchema: {
        target: targetSchema,
        targetDistance: distanceSchema.optional().default(50_000).describe('Target periapsis (bodies) or closest approach (vessels) in meters (default: 50km)'),
        execute: executeSchema,
        includeTelemetry: z.boolean()
          .optional()
          .default(false)
          .describe('Include ship telemetry in response (slower but more info)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 1 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);

        // Auto-select 2nd closest body if no target provided
        let target = args.target;
        if (!target) {
          const autoTarget = await selectTarget(orchestrator, 'second-closest');
          if (autoTarget) {
            target = autoTarget;
          }
        }

        // Try course correction
        let result = await orchestrator.courseCorrection(args.targetDistance, { target, execute: args.execute });

        // If no encounter, do hohmann transfer first
        if (!result.success && result.error?.toLowerCase().includes('no encounter')) {
          const hohmannResult = await orchestrator.hohmannTransfer('COMPUTED', false, { target, execute: args.execute });
          if (hohmannResult.success) {
            // Try course correction again
            result = await orchestrator.courseCorrection(args.targetDistance, { execute: args.execute });
          }
        }

        if (!result.success) {
          return errorResponse('course_correct', result.error ?? 'Failed');
        }

        const execInfo = result.executed ? ' (executed)' : '';
        let text = `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`;

        if (args.includeTelemetry) {
          // Query target encounter info
          const targetInfo = await queryTargetEncounterInfo(conn);
          if (targetInfo) {
            text += '\n\n' + formatTargetEncounterInfo(targetInfo);
          }
          const telemetry = await getShipTelemetry(conn, INLINE_TELEMETRY_OPTIONS);
          text += '\n\n' + telemetry.formatted;
        }

        return successResponse('course_correct', text);
      } catch (error) {
        return errorResponse('course_correct', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'match_planes',
    {
      description: 'Align orbit with target for rendezvous or docking.',
      inputSchema: {
        target: autoTargetSchema,
        timeRef: z.enum(['REL_NEAREST_AD', 'REL_HIGHEST_AD', 'REL_ASCENDING', 'REL_DESCENDING'])
          .optional()
          .default('REL_NEAREST_AD')
          .describe('When to execute: nearest AN/DN, highest AN/DN, ascending node, or descending node'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 1 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);

        // Auto-select closest vessel if not provided
        let target = args.target;
        if (!target) {
          const autoTarget = await selectTarget(orchestrator, 'closest-vessel');
          if (autoTarget) {
            target = autoTarget;
          }
        }

        const result = await orchestrator.matchPlane(args.timeRef, { target, execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('match_planes',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('match_planes', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('match_planes', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'match_velocities',
    {
      description: 'Match speed with target for docking. Use at closest approach.',
      inputSchema: {
        target: autoTargetSchema,
        timeRef: z.enum(['CLOSEST_APPROACH', 'X_FROM_NOW'])
          .optional()
          .default('CLOSEST_APPROACH')
          .describe('When to execute: at closest approach or after X seconds'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);

        // Auto-select closest vessel if not provided
        let target = args.target;
        if (!target) {
          const autoTarget = await selectTarget(orchestrator, 'closest-vessel');
          if (autoTarget) {
            target = autoTarget;
          }
        }

        const result = await orchestrator.killRelVel(args.timeRef, { target, execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('match_velocities',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('match_velocities', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('match_velocities', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'interplanetary_transfer',
    {
      description: 'Go to another planet: Duna, Eve, Jool. Waits for transfer window.',
      inputSchema: {
        target: autoTargetSchema,
        waitForPhaseAngle: z.boolean()
          .optional()
          .default(true)
          .describe('If true, waits for optimal phase angle. If false, transfers immediately.'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);

        // Auto-select furthest body if not provided (interplanetary = distant planets)
        let target = args.target;
        if (!target) {
          const autoTarget = await selectTarget(orchestrator, 'furthest-body');
          if (autoTarget) {
            target = autoTarget;
          }
        }

        const result = await orchestrator.interplanetaryTransfer(args.waitForPhaseAngle, { target, execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          let text = `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`;

          // Include warning if present (crash trajectory, close approach, etc.)
          if (result.error) {
            text += '\n\n' + result.error;
          }

          return successResponse('interplanetary', text);
        } else {
          return errorResponse('interplanetary', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('interplanetary', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'return_from_moon',
    {
      description: 'Return from Mun/Minmus to Kerbin. Sets up reentry trajectory.',
      inputSchema: {
        targetPeriapsis: distanceSchema.optional().default(40_000).describe('Target periapsis at parent body in meters (default: 40km)'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.returnFromMoon(args.targetPeriapsis, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('return_from_moon',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('return_from_moon', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('return_from_moon', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'resonant_orbit',
    {
      description: 'Create orbit for deploying satellite constellation.',
      inputSchema: {
        numerator: z.number().int().positive().optional().default(2).describe('Numerator of resonance ratio (default: 2 for 2:3)'),
        denominator: z.number().int().positive().optional().default(3).describe('Denominator of resonance ratio (default: 3 for 2:3)'),
        timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW'])
          .optional()
          .default('APOAPSIS')
          .describe('When to execute the maneuver'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.resonantOrbit(args.numerator, args.denominator, args.timeRef, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('resonant_orbit',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('resonant_orbit', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('resonant_orbit', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'set_target',
    {
      description: 'Set navigation target. Prefer target param on transfer tools.',
      inputSchema: {
        name: z.preprocess(parseTarget, z.string()).optional().describe('Target name. Use get_targets to list available names. (default: 2nd closest body)'),
        type: z.enum(['auto', 'body', 'vessel']).optional().default('auto')
          .describe('Target type: "auto" tries name directly, "body" for celestial bodies, "vessel" for ships'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { tier: 3 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);

        // Default to 2nd closest body if no name provided
        let name = args.name;
        if (!name) {
          const autoTarget = await selectTarget(orchestrator, 'second-closest', false);
          if (!autoTarget) {
            return errorResponse('set_target', 'No suitable target found');
          }
          name = autoTarget;
        }

        const result = await orchestrator.setTarget(name, args.type);
        if (!result.success) {
          return errorResponse('set_target', result.error ?? `Failed to set target "${name}"`);
        }

        return successResponse('set_target', `Target: ${result.name} (${result.type})`);
      } catch (error) {
        return errorResponse('set_target', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'get_target',
    {
      description: 'Show current navigation target.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async () => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);

        const info = await orchestrator.getTargetInfo();
        if (!info.hasTarget) {
          return successResponse('get_target', 'No target set.');
        }

        return successResponse('get_target', info.details ?? `Target: ${info.name}`);
      } catch (error) {
        return errorResponse('get_target', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'get_targets',
    {
      description: 'List all moons, planets, and vessels you can travel to.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async () => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.listTargets();
        return successResponse('get_targets', JSON.stringify(result, null, 2));
      } catch (error) {
        return errorResponse('get_targets', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'clear_target',
    {
      description: 'Clear navigation target.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async () => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.clearTarget();

        if (result.cleared) {
          return successResponse('clear_target', 'Target cleared.');
        }

        return successResponse('clear_target', result.warning ?? 'Clear command sent.');
      } catch (error) {
        return errorResponse('clear_target', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'execute_node',
    {
      description: 'Execute next maneuver. Prefer execute param on maneuver tools.',
      inputSchema: {
        async: z.boolean()
          .optional()
          .default(false)
          .describe('If true, return immediately after starting executor instead of waiting for completion'),
        timeoutSeconds: z.number()
          .optional()
          .default(240)
          .describe('Maximum time to wait for node execution in seconds (default: 240 = 4 minutes)'),
        includeTelemetry: z.boolean()
          .optional()
          .default(false)
          .describe('Include ship telemetry in response (slower but more info)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { tier: 3 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const result = await executeNode(conn, {
          timeoutMs: args.timeoutSeconds * 1000,
          async: args.async,
        });

        if (result.success) {
          let text: string;
          text = args.async ? `Executor started: ${result.deltaV?.required.toFixed(1)} m/s required` : `Node executed: ${result.nodesExecuted} node(s)`;

          if (args.includeTelemetry) {
            // Query target encounter info
            const targetInfo = await queryTargetEncounterInfo(conn);
            if (targetInfo) {
              text += '\n\n' + formatTargetEncounterInfo(targetInfo);
            }
            const telemetry = await getShipTelemetry(conn, INLINE_TELEMETRY_OPTIONS);
            text += '\n\n' + telemetry.formatted;
          }

          return successResponse('execute_node', text);
        } else {
          return errorResponse('execute_node', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('execute_node', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'clear_nodes',
    {
      description: 'Delete all planned maneuvers.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async () => {
      try {
        const conn = await ensureConnected();
        const result = await clearNodes(conn);

        return result.success ? successResponse('clear_nodes', `Cleared ${result.nodesCleared} node(s)`) : errorResponse('clear_nodes', result.error ?? 'Failed to clear nodes');
      } catch (error) {
        return errorResponse('clear_nodes', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'command',
    {
      description: 'Run raw kOS command. Advanced.',
      inputSchema: {
        command: z.string().describe('kOS script command to send'),
        timeout: z.number().optional().default(5000).describe('Command timeout in milliseconds'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { tier: 3 },
    },
    async (args) => {
      const result = await handleExecute(args);
      return result.success ? successResponse('command', result.output || '(no output)') : errorResponse('command', result.error ?? 'Failed');
    }
  );

  // =============================================================================
  // SCRIPT EXECUTION
  // =============================================================================

  server.registerTool(
    'run_script',
    {
      description: 'Run kOS script file. Advanced.',
      inputSchema: {
        sourcePath: z.string().describe('Absolute path to the .ks script file to run'),
        timeout: z.number()
          .optional()
          .default(60_000)
          .describe('Maximum execution time in milliseconds (default: 60000 = 1 minute)'),
        cleanup: z.boolean()
          .optional()
          .default(true)
          .describe('Delete script from Archive after execution (default: true)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const result = await runScript(conn, args.sourcePath, {
          timeout: args.timeout,
          cleanup: args.cleanup,
        });

        if (result.success) {
          const outputPreview = result.output.slice(-30).join('\n');
          const timeStr = result.executionTime ? `${(result.executionTime / 1000).toFixed(1)}s` : 'unknown';
          return successResponse('run_script',
            `Script completed in ${timeStr}\n\nOutput (last 30 lines):\n${outputPreview}`);
        } else {
          const outputPreview = result.output.slice(-20).join('\n');
          return errorResponse('run_script',
            `${result.error}\n\nOutput:\n${outputPreview}`);
        }
      } catch (error) {
        return errorResponse('run_script',
          error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'status',
    {
      description: 'Get ship info: orbit, fuel, position, encounters.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 1 },
    },
    async () => {
      const status = await getStatus(undefined, FULL_TELEMETRY_OPTIONS);
      return successResponse('status', JSON.stringify(status, null, 2));
    }
  );

  server.registerTool(
    'disconnect',
    {
      description: 'Disconnect from kOS.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async () => {
      try {
        await handleDisconnect();
        return successResponse('disconnect', 'Disconnected successfully.');
      } catch (error) {
        return errorResponse('disconnect', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'list_cpus',
    {
      description: 'List kOS CPUs.',
      inputSchema: listCpusInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async (args) => {
      try {
        const cpus = await handleListCpus(args);
        const text = cpus.length > 0
          ? `Found ${cpus.length} CPU(s):\n` + cpus.map(c => `  ${c.id}: ${c.vessel} (${c.tag || 'no tag'})`).join('\n')
          : 'No CPUs found';
        return successResponse('list_cpus', text);
      } catch (error) {
        return errorResponse('list_cpus', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'switch_cpu',
    {
      description: 'Switch kOS CPU.',
      inputSchema: {
        cpuId: z.number().optional().describe('CPU ID (1-based) to switch to'),
        cpuLabel: z.string().optional().describe('CPU label/tag. Use list_cpus to see available CPUs.'),
        clear: z.boolean().optional().describe('Clear preference and revert to auto-select'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async (args) => {
      try {
        if (args.clear) {
          setCpuPreference(null);
          await forceDisconnect();
          return successResponse('switch_cpu', 'CPU preference cleared.');
        }

        if (args.cpuId === undefined && args.cpuLabel === undefined) {
          const current = getCpuPreference();
          if (current) {
            const desc = current.cpuLabel ? `label="${current.cpuLabel}"` : `id=${current.cpuId}`;
            return successResponse('switch_cpu', `Current: ${desc}`);
          }
          return successResponse('switch_cpu', 'Auto-select (no preference).');
        }

        setCpuPreference({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const desc = args.cpuLabel ? `label="${args.cpuLabel}"` : `id=${args.cpuId}`;
        return successResponse('switch_cpu', `Switched to ${desc}`);
      } catch (error) {
        return errorResponse('switch_cpu', error instanceof Error ? error.message : String(error));
      }
    }
  );

  // Register resources (documentation)
  server.resource(
    'kos-connection-guide',
    'kos://connection-guide',
    async () => ({
      contents: [{
        uri: 'kos://connection-guide',
        mimeType: 'text/markdown',
        text: CONNECTION_GUIDE,
      }],
    })
  );

  server.resource(
    'kos-cpu-menu-format',
    'kos://cpu-menu-format',
    async () => ({
      contents: [{
        uri: 'kos://cpu-menu-format',
        mimeType: 'text/markdown',
        text: CPU_MENU_FORMAT,
      }],
    })
  );

  server.resource(
    'kos-transport-options',
    'kos://transport-options',
    async () => ({
      contents: [{
        uri: 'kos://transport-options',
        mimeType: 'text/markdown',
        text: TRANSPORT_OPTIONS,
      }],
    })
  );

  // Monitoring resources
  server.resource(
    'kos-status',
    'kos://status',
    async () => {
      const conn = getConnection();
      const connState = conn?.getState();
      const status = globalKosMonitor.getStatus();

      return {
        contents: [{
          uri: 'kos://status',
          mimeType: 'application/json',
          text: JSON.stringify({
            connected: conn?.isConnected() || false,
            cpuId: connState?.cpuId || null,
            vessel: connState?.vesselName || null,
            lastError: status.lastError,
            errorCount: status.errorCount,
            isLooping: status.isLooping,
            hasErrors: status.hasErrors,
          }, null, 2),
        }],
      };
    }
  );

  // Time Warp Tool
  server.registerTool(
    'warp',
    {
      description: 'Fast-forward time to maneuver, SOI change, or specific point.',
      inputSchema: {
        target: z.preprocess(
          (val) => typeof val === 'string' ? val.toLowerCase() : val,
          z.enum(['node', 'soi', 'periapsis', 'apoapsis']).or(z.number())
        ).describe('Warp target: "node", "soi", "periapsis", "apoapsis", or a number of seconds to warp forward'),
        leadTime: z.number()
          .optional()
          .default(60)
          .describe('Seconds before target to stop warping (default: 60)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 1 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();

        const result = await (typeof args.target === 'number' ? warpForward(conn, args.target) : warpTo(conn, args.target as WarpTarget, { leadTime: args.leadTime }));

        if (result.success) {
          let msg = `Warp complete: ${result.body}, ${((result.altitude || 0) / 1000).toFixed(0)}km`;
          if (result.periapsis !== undefined) {
            msg += `, periapsis: ${(result.periapsis / 1000).toFixed(0)}km`;
          }
          if (result.warning) {
            msg += `\n\n${result.warning}`;
          }
          return successResponse('warp', msg);
        } else {
          return errorResponse('warp', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('warp', error instanceof Error ? error.message : String(error));
      }
    }
  );

  // Crash Avoidance Tool
  server.registerTool(
    'crash_avoidance',
    {
      description: 'Emergency burn to prevent crash. Raises periapsis to safe altitude.',
      inputSchema: {
        targetPeriapsis: distanceSchema
          .optional()
          .default(10_000)
          .describe('Target periapsis in meters (default: 10000 = 10km)'),
        timeoutMs: z.number()
          .optional()
          .default(300_000)
          .describe('Maximum burn time in milliseconds (default: 300000 = 5 min)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 1 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const result = await crashAvoidance(conn, {
          targetPeriapsis: args.targetPeriapsis,
          timeoutMs: args.timeoutMs,
        });

        return result.success ? successResponse('crash_avoidance',
            `Crash avoided! Pe: ${result.initialPeriapsis?.toFixed(0)}m → ${result.finalPeriapsis?.toFixed(0)}m, ΔV: ${result.deltaVUsed?.toFixed(1)} m/s, Stages: ${result.stagesUsed}`
          ) : errorResponse('crash_avoidance', result.error ?? 'Burn failed');
      } catch (error) {
        return errorResponse('crash_avoidance', error instanceof Error ? error.message : String(error));
      }
    }
  );

  // Save/Load Tools (using kuniverse library)
  server.registerTool(
    'load_save',
    {
      description: 'Load a quicksave.',
      inputSchema: {
        saveName: z.string().describe('Quicksave name. Use list_saves to see available saves.'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      const conn = await ensureConnected();
      const result = await quickload(conn, args.saveName);

      return result.success ? successResponse('load_save', `Loading: ${result.saveName}`) : errorResponse('load_save', result.error ?? 'Failed');
    }
  );

  server.registerTool(
    'list_saves',
    {
      description: 'List quicksaves.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async () => {
      const conn = await ensureConnected();
      const result = await listQuicksaves(conn);

      if (result.success) {
        const savesList = result.saves.length > 0
          ? result.saves.join(', ')
          : '(none)';
        return successResponse('list_saves', `Saves: ${savesList}`);
      } else {
        return errorResponse('list_saves', result.error ?? 'Failed');
      }
    }
  );

  server.registerTool(
    'quicksave',
    {
      description: 'Create quicksave.',
      inputSchema: {
        saveName: z.string().describe('Name for the quicksave'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async (args) => {
      const conn = await ensureConnected();
      const result = await quicksave(conn, args.saveName);

      return result.success ? successResponse('quicksave', `Saved: ${result.saveName}`) : errorResponse('quicksave', result.error ?? 'Failed');
    }
  );

  server.resource(
    'kos-terminal-recent',
    'kos://terminal/recent',
    async () => {
      const status = globalKosMonitor.getStatus();

      return {
        contents: [{
          uri: 'kos://terminal/recent',
          mimeType: 'application/json',
          text: JSON.stringify({
            recentLines: status.recentLines,
            hasErrors: status.hasErrors,
            isLooping: status.isLooping,
            errorPattern: status.errorPattern,
            errorCount: status.errorCount,
            summary: globalKosMonitor.getSummary(),
          }, null, 2),
        }],
      };
    }
  );

  // =============================================================================
  // KSP Data Resources (live game data)
  // =============================================================================

  server.resource(
    'status',
    'ksp://status',
    async () => {
      const status = await getStatus(undefined, FULL_TELEMETRY_OPTIONS);
      return {
        contents: [{
          uri: 'ksp://status',
          mimeType: 'application/json',
          text: JSON.stringify(status, null, 2),
        }],
      };
    }
  );

  server.resource(
    'targets',
    'ksp://targets',
    async () => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.listTargets();
        return {
          contents: [{
            uri: 'ksp://targets',
            mimeType: 'application/json',
            text: JSON.stringify({
              bodies: result.bodies,
              vessels: result.vessels,
              formatted: result.formatted,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          contents: [{
            uri: 'ksp://targets',
            mimeType: 'application/json',
            text: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              bodies: [],
              vessels: [],
            }, null, 2),
          }],
        };
      }
    }
  );

  server.resource(
    'target',
    'ksp://target',
    async () => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const info = await orchestrator.getTargetInfo();
        return {
          contents: [{
            uri: 'ksp://target',
            mimeType: 'application/json',
            text: JSON.stringify(info, null, 2),
          }],
        };
      } catch (error) {
        return {
          contents: [{
            uri: 'ksp://target',
            mimeType: 'application/json',
            text: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              hasTarget: false,
            }, null, 2),
          }],
        };
      }
    }
  );

  server.resource(
    'saves',
    'ksp://saves',
    async () => {
      try {
        const conn = await ensureConnected();
        const result = await listQuicksaves(conn);
        return {
          contents: [{
            uri: 'ksp://saves',
            mimeType: 'application/json',
            text: JSON.stringify({
              success: result.success,
              saves: result.saves,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          contents: [{
            uri: 'ksp://saves',
            mimeType: 'application/json',
            text: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              saves: [],
            }, null, 2),
          }],
        };
      }
    }
  );

  // =============================================================================
  // MCP Prompts (workflow templates)
  // =============================================================================

  server.prompt(
    'launch-to-orbit',
    {
      altitude: z.string().optional().describe('Target orbit altitude (e.g., "100km")'),
    },
    async (args) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Launch to ${args.altitude || '80km'} circular orbit:

1. Use the launch_ascent tool with altitude=${args.altitude || '80000'}
2. Wait for orbit insertion (the tool blocks until complete)
3. If orbit is not circular, use circularize tool

The launch_ascent tool handles staging, gravity turn, and fairing deployment automatically.`,
        },
      }],
    })
  );

  server.prompt(
    'transfer-to-moon',
    {
      target: z.string().describe('Target moon (Mun or Minmus)'),
    },
    async (args) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Transfer to ${args.target}:

1. set_target to "${args.target}"
2. hohmann_transfer - plans and executes the transfer burn
3. If no SOI encounter after burn, use course_correct to fine-tune
4. warp to SOI change
5. circularize at destination

Note: hohmann_transfer will report if it achieves an encounter or just a close approach.
If you get a close approach warning, course_correct should establish the encounter.`,
        },
      }],
    })
  );

  server.prompt(
    'return-to-kerbin',
    {
      targetPeriapsis: z.string().optional().describe('Kerbin periapsis (e.g., "40km")'),
    },
    async (args) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Return to Kerbin with ${args.targetPeriapsis || '40km'} periapsis:

1. return_from_moon - plans and executes escape burn back to Kerbin
2. warp to Kerbin SOI
3. If needed, adjust_periapsis to set reentry altitude

For aerobraking/landing, target 30-40km periapsis.
For capture into orbit, target higher periapsis (70km+) and circularize.`,
        },
      }],
    })
  );

  return server;
}
