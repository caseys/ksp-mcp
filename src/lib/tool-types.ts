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
import type { EnsureConnectedOptions } from '../transport/connection-tools.js';

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
  ensureConnected: (options?: EnsureConnectedOptions) => Promise<KosConnection>;
  getConnection: () => KosConnection;
  createLogger: (extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => McpLogger;
  successResponse: (prefix: string, text: string) => CallToolResult;
  errorResponse: (prefix: string, error: string) => CallToolResult;
  selectTarget: (orchestrator: ManeuverOrchestrator, mode: TargetSelectMode, checkExisting?: boolean) => Promise<string | null>;
  getBasicOrbitInfo: (conn: KosConnection | null) => Promise<OrbitInfo | null>;
  /**
   * Check if the MCP client supports notifications well.
   * Returns true if notifications are supported (e.g., web clients, Cline).
   * Returns false for Claude Code (stdio) which doesn't display notifications well.
   */
  supportsNotifications: (extra: RequestHandlerExtra<ServerRequest, ServerNotification>) => boolean;
  /**
   * Restart the mcp-daemon after tool execution.
   * Call this at the end of tool handlers to ensure daemon keeps running.
   */
  restartDaemon: () => Promise<void>;
}

/**
 * Target selection modes for auto-select
 */
export type TargetSelectMode =
  | 'closest-body'      // Closest body (excluding SOI)
  | 'closest-vessel'    // Closest vessel - for match_planes, match_velocities
  | 'furthest-body'     // Furthest body - for interplanetary_transfer
  | 'second-closest';   // 2nd closest body (excluding SOI) - for hohmann_transfer, set_target, course_correct

/**
 * Orbit info returned by getOrbitInfo
 */
export interface OrbitInfo {
  periapsis: number;
  apoapsis: number;
  altitude: number;
  eccentricity: number;
}

/**
 * MCP client info from the initialize request.
 */
export interface ClientInfo {
  name: string;
  version: string;
}

/**
 * Check if a client is Claude Code based on client info or user-agent.
 * Returns true if the client is likely Claude Code (which doesn't display notifications well).
 */
export function isClaudeClient(clientInfo?: ClientInfo, userAgent?: string): boolean {
  if (clientInfo?.name?.toLowerCase().includes('claude')) return true;
  if (userAgent?.toLowerCase().includes('claude')) return true;
  return false;
}

// ============================================================================
// MCP Logger
// ============================================================================

/**
 * Structured logger for MCP notifications.
 * Supports different log levels for proper message categorization.
 */
export interface McpLogger {
  /** Informational messages */
  info(message: string): void;
  /** Warning messages */
  warn(message: string): void;
  /** Error messages */
  error(message: string): void;
  /** Progress updates (uses progressToken if available) */
  progress(message: string): void;
}

/**
 * Null logger that discards all messages.
 * Use when no logger is provided to avoid null checks.
 */
export const nullLogger: McpLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  progress: () => {},
};

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
 * Unit multipliers to convert to meters.
 * Keys are lowercase, sorted by length descending for regex matching.
 */
const DISTANCE_UNITS: Record<string, number> = {
  'gm': 1_000_000_000,  // Gigameters
  'mm': 1_000_000,      // Megameters
  'km': 1000,          // Kilometers
  'm': 1,               // Meters
};

// Build regex pattern from unit keys, sorted by length descending to match longer units first
const unitPattern = Object.keys(DISTANCE_UNITS)
  .sort((a, b) => b.length - a.length) // eslint-disable-line unicorn/no-array-sort
  .join('|');
const DISTANCE_REGEX = new RegExp(String.raw`^([\d.]+)\s*(${unitPattern})?$`, 'i');

/**
 * Parse distance string with optional units to meters.
 * Handles LLM outputs like "50km", "50 km", "1.5Mm", "0.74 Gm" and converts to meters.
 *
 * SMART DEFAULT: For orbital measurements, bare numbers < 10000 are assumed to be km.
 * This matches how humans talk about orbits ("raise to 100" means 100km, not 100m).
 */
export function parseDistance(val: unknown): number | 'auto' | (number | 'auto')[] {
  // Pass through 'auto' sentinel unchanged for dynamic resolution
  if (val === 'auto') return 'auto';

  // Handle arrays by processing each element (for [pe, ap] style inputs)
  if (Array.isArray(val)) {
    return val.map(v => parseDistance(v)) as (number | 'auto')[];
  }

  // Handle numbers directly
  if (typeof val === 'number') {
    // Smart default: small numbers are almost certainly km for orbital work
    // Threshold 1000: "raise to 500" means 500km, but "5000" is likely 5000m
    if (val < 1000) {
      return val * 1000; // Assume km
    }
    return val; // Already in meters (large value)
  }

  if (typeof val !== 'string') {
    throw new TypeError(`Invalid distance value: ${val}`);
  }

  const trimmed = val.trim();

  // Match number with optional unit
  const match = trimmed.match(DISTANCE_REGEX);
  if (!match) {
    throw new Error(`Invalid distance format: ${val}. Use "50km", "100m", "1.5Mm", or "0.5Gm"`);
  }

  const num = Number.parseFloat(match[1]);
  const unit = match[2]?.toLowerCase();

  // If unit specified, look up multiplier
  if (unit && DISTANCE_UNITS[unit]) {
    return num * DISTANCE_UNITS[unit];
  }

  // No unit specified - smart default based on magnitude
  // For orbital work, small numbers are km (nobody says "orbit at 100 meters")
  if (num < 1000) {
    return num * 1000; // Assume km
  }
  return num; // Large number, assume already in meters
}

/**
 * Zod schema for distance values - prefers strings with units, also accepts numbers.
 * LLMs should pass strings like "50km" to preserve units.
 * Examples: "50km", "100m", "1.5Mm", "50 km", or "auto" for dynamic resolution.
 *
 * Smart default: bare numbers < 1000 are assumed to be km (e.g., "100" → 100km).
 * This applies to both string and number inputs for consistency.
 */
export const distanceSchema = z.preprocess(
  parseDistance,
  z.union([z.number(), z.literal('auto'), z.array(z.union([z.number(), z.literal('auto')]))])
);

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
  'Minmus': ['minas','mimmi','minimus', 'minimum', 'mimmus', 'minmas', 'min mouse', 'min mus', 'minimums', 'min miss', 'minmis', 'minmes'],
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
 * Passes through 'auto' unchanged for dynamic resolution.
 */
export function parseTarget(val: unknown): string | unknown {
  if (typeof val !== 'string') return val;
  if (val === 'auto') return val;  // Pass through sentinel
  return matchTargetName(val);
}

/**
 * Common zod schema for the optional target parameter.
 * Preprocesses input to fuzzy-match against known KSP body names.
 * Default 'auto' uses current target if set.
 */
export const targetSchema = z.preprocess(parseTarget, z.union([z.string(), z.literal('auto')]))
  .optional()
  .default('auto')
  .describe('Target name (body or vessel). Use get_targets to list available names. If omitted, uses current target.');

/**
 * Optional target schema with auto-selection capability.
 * Default 'auto' auto-selects based on tool context.
 */
export const autoTargetSchema = z.preprocess(parseTarget, z.union([z.string(), z.literal('auto')]))
  .optional()
  .default('auto')
  .describe('Target name. Use get_targets to list available names. If omitted, auto-selects based on tool.');
