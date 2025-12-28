/**
 * Type definitions for target management operations
 */

/**
 * Result from setTarget operation with confirmation details.
 */
export interface SetTargetResult {
  success: boolean;
  /** Confirmed target name from kOS (may differ from requested name) */
  name?: string;
  /** Target type: "Body" or "Vessel" */
  type?: string;
  /** Error message if success is false */
  error?: string;
}

/**
 * Detailed information about the current target.
 */
export interface GetTargetInfo {
  hasTarget: boolean;
  name?: string;
  type?: string;
  /** Distance to target in meters */
  distance?: number;
  /** Full formatted details string */
  details?: string;
}

/**
 * Result from clearTarget operation.
 */
export interface ClearTargetResult {
  /** Whether the command was sent successfully */
  success: boolean;
  /** Whether HASTARGET reports false after the command */
  cleared: boolean;
  /** Warning message if target may not have been cleared */
  warning?: string;
}

/**
 * Result from listTargets operation.
 */
export interface ListTargetsResult {
  /** Moons of the parent planet (sorted by distance) */
  moons: Array<{ name: string; distance: number }>;
  /** All planets (sorted by distance) */
  planets: Array<{ name: string; distance: number }>;
  /** All vessels in current SOI sorted by distance */
  vessels: Array<{ name: string; distance: number }>;
  /** Formatted output string */
  formatted: string;
}
