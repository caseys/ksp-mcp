/**
 * Tool Types and Schemas
 *
 * Shared types, interfaces, and schemas for MCP tool definitions.
 */

import { z } from 'zod';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { KosConnection } from '../transport/kos-connection.js';
import type { ManeuverOrchestrator } from './mechjeb/orchestrator.js';

// Re-export for convenience
export type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
export type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Tool definition interface.
 * Each tool file exports a toolDefinition that includes metadata and handler.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  tier: number;
  handler: (
    args: Record<string, unknown>,
    context: ToolContext,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>
  ) => Promise<CallToolResult>;
}

/**
 * Context passed to tool handlers.
 * Provides access to shared utilities and connection management.
 */
export interface ToolContext {
  ensureConnected: () => Promise<KosConnection>;
  getConnection: () => KosConnection | null;
  createProgressCallback: (extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => (msg: string) => void;
  successResponse: (prefix: string, text: string) => CallToolResult;
  errorResponse: (prefix: string, error: string) => CallToolResult;
  selectTarget: (orchestrator: ManeuverOrchestrator, mode: TargetSelectMode, checkExisting?: boolean) => Promise<string | null>;
  getDefaultLaunchAltitude: (conn: KosConnection | null) => Promise<number>;
  getOrbitInfo: (conn: KosConnection | null) => Promise<OrbitInfo | null>;
}

/**
 * Target selection modes for auto-select
 */
export type TargetSelectMode =
  | 'closest-body'      // Closest body (excluding SOI) - for hohmann_transfer
  | 'closest-vessel'    // Closest vessel - for match_planes, match_velocities
  | 'furthest-body'     // Furthest body - for interplanetary_transfer
  | 'second-closest';   // 2nd closest body (excluding SOI) - for set_target, course_correct

/**
 * Orbit info returned by getOrbitInfo
 */
export interface OrbitInfo {
  periapsis: number;
  apoapsis: number;
  altitude: number;
}

// ============================================================================
// Shared Schemas
// ============================================================================

/**
 * Common zod schema for the execute parameter
 */
export const executeSchema = z.boolean()
  .optional()
  .default(true)
  .describe('Execute the maneuver node after planning. Optional, defaults to true.');

/**
 * Parse distance string with optional units (km, m, Mm) to meters.
 * Handles LLM outputs like "50km" or "100m" and converts to meters.
 */
export function parseDistance(val: unknown): number | unknown {
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
export const distanceSchema = z.preprocess(parseDistance, z.number());

/**
 * Stock KSP celestial bodies for fuzzy matching.
 * Keys are canonical names, values are common misspellings/STT errors.
 */
const KSP_BODIES: Record<string, string[]> = {
  'Sun': ['sol', 'kerbol', 'star', 'the sun', 'son'],
  'Moho': ['mojo', 'mo ho', 'moo ho', 'mohoe', 'moho'],
  'Eve': ['eva', 'eave', 'eev', 'eve', 'eves'],
  'Gilly': ['gillie', 'ghillie', 'jilly', 'gill e', 'gily', 'gilley'],
  'Kerbin': ['kirbin', 'kerban', 'curbing', 'carbon', 'curbin', 'kerben', 'kirben', 'curb in', 'curve in'],
  'Mun': ['moon', 'munn', 'the mun', 'mune', 'mon', 'the moon'],
  'Minmus': ['minimus', 'minimum', 'mimmus', 'minmas', 'min mouse', 'min mus', 'minimums', 'min miss', 'minmis', 'minmes'],
  'Duna': ['dune', 'doona', 'donna', 'tuna', 'duner', 'do na', 'dune a', 'dunah', 'djna'],
  'Ike': ['ik', 'ica', 'iky', 'ike', 'mike', 'bike', 'like'],
  'Dres': ['dress', 'drez', 'drес', 'dressed', 'dris', 'drace'],
  'Jool': ['jule', 'joel', 'jewel', 'joule', 'jul', 'jewl', 'drool', 'juel', 'juul', 'joole'],
  'Laythe': ['lathe', 'laith', 'lath', 'late', 'lay the', 'lazy', 'lathey', 'laythee', 'laitha'],
  'Vall': ['val', 'wall', 'vaal', 'vahl', 'vol', 'ball', 'fall', 'vahl'],
  'Tylo': ['tilo', 'taylo', 'tyelow', 'tyler', 'tile', 'tile oh', 'ty lo', 'tyo', 'tallo'],
  'Bop': ['bob', 'bopp', 'pop', 'bap', 'bahp', 'baup'],
  'Pol': ['poll', 'pole', 'paul', 'pall', 'pull', 'pawl'],
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
 */
function matchTargetName(input: string): string {
  const normalized = input.toLowerCase().trim().replaceAll(/\s+/g, '');

  // Exact match on canonical names
  for (const canonical of Object.keys(KSP_BODIES)) {
    if (canonical.toLowerCase() === normalized) return canonical;
  }

  // Check aliases/misspellings
  for (const [canonical, aliases] of Object.entries(KSP_BODIES)) {
    for (const alias of aliases) {
      if (alias.toLowerCase().replaceAll(/\s+/g, '') === normalized) return canonical;
    }
  }

  // Fuzzy match using Levenshtein distance
  let bestMatch = input;
  let bestScore = Infinity;
  const maxDistance = Math.max(2, Math.floor(normalized.length * 0.4));

  for (const canonical of Object.keys(KSP_BODIES)) {
    const distance = levenshtein(normalized, canonical.toLowerCase());
    if (distance < bestScore && distance <= maxDistance) {
      bestScore = distance;
      bestMatch = canonical;
    }
  }

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
 */
export function parseTarget(val: unknown): string | unknown {
  if (typeof val !== 'string') return val;
  return matchTargetName(val);
}

/**
 * Common zod schema for the optional target parameter.
 * Preprocesses input to fuzzy-match against known KSP body names.
 */
export const targetSchema = z.preprocess(parseTarget, z.string())
  .optional()
  .describe('Target name (body or vessel). Use get_targets to list available names. If omitted, uses current target.');

/**
 * Optional target schema with auto-selection capability.
 */
export const autoTargetSchema = z.preprocess(parseTarget, z.string())
  .optional()
  .describe('Target name. Use get_targets to list available names. If omitted, auto-selects based on tool.');
