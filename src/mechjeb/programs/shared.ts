/**
 * Shared utilities for MechJeb maneuver operations
 */

import type { KosConnection } from '../../transport/kos-connection.js';

/**
 * Delay between sequential kOS commands (milliseconds).
 * kOS telnet needs time to process commands; without delays,
 * commands can be lost or return garbled output.
 */
export const KOS_COMMAND_DELAY_MS = 500;

export interface ManeuverResult {
  success: boolean;
  deltaV?: number;        // m/s
  timeToNode?: number;    // seconds
  error?: string;
}

/**
 * Parse a numeric value from kOS output
 * Looks for patterns like "23.80  m/s" or just bare numbers
 */
export function parseNumber(output: string): number {
  // First try to find a number with units (e.g., "23.80  m/s")
  // Note: Must start with digit, not dot (to avoid matching ".23.80" as ".23")
  const withUnits = output.match(/(\d+(?:\.\d+)?)\s*m\/s/i);
  if (withUnits) {
    return parseFloat(withUnits[1]);
  }

  // Otherwise find all numbers that start with a digit
  const allNumbers = output.match(/\d+(?:\.\d+)?(?:E[+-]?\d+)?/gi);
  if (allNumbers && allNumbers.length > 0) {
    // Take the last number which is most likely the actual value
    return parseFloat(allNumbers[allNumbers.length - 1]);
  }

  return 0;
}

/**
 * Parse time string like "31m 10s" or "5h 23m 10s" to seconds
 */
export function parseTimeString(output: string): number {
  // Try standard number first (pure seconds)
  const numMatch = output.match(/^[\s\S]*?([\d.]+)\s*$/);
  if (numMatch) {
    const val = parseFloat(numMatch[1]);
    if (!isNaN(val) && val > 0) return val;
  }

  // Parse human-readable format: Xh Ym Zs
  let seconds = 0;
  const hoursMatch = output.match(/(\d+)\s*h/i);
  const minsMatch = output.match(/(\d+)\s*m/i);
  const secsMatch = output.match(/(\d+)\s*s/i);

  if (hoursMatch) seconds += parseInt(hoursMatch[1]) * 3600;
  if (minsMatch) seconds += parseInt(minsMatch[1]) * 60;
  if (secsMatch) seconds += parseInt(secsMatch[1]);

  return seconds;
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Standard delay between kOS commands.
 * Use this between sequential kOS execute calls.
 */
export function kosDelay(): Promise<void> {
  return delay(KOS_COMMAND_DELAY_MS);
}

/**
 * Query a numeric value from MechJeb (e.g., "23.80  m/s")
 */
export async function queryNumber(conn: KosConnection, suffix: string): Promise<number> {
  const result = await conn.execute(`PRINT ${suffix}.`, 2000);
  return parseNumber(result.output);
}

/**
 * Query a numeric value with retry - useful after node creation
 * Retries until non-zero value or max attempts reached
 */
export async function queryNumberWithRetry(
  conn: KosConnection,
  suffix: string,
  maxAttempts = 5,
  retryDelayMs = 200
): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await conn.execute(`PRINT ${suffix}.`, 2000);
    const value = parseNumber(result.output);
    if (value !== 0) return value;
    if (i < maxAttempts - 1) await delay(retryDelayMs);
  }
  return 0;  // Return 0 if still not ready after all attempts
}

/**
 * Query maneuver node info using kOS native commands
 * Returns deltaV and timeToNode for the next maneuver node
 *
 * Uses kOS's NEXTNODE instead of MechJeb INFO suffixes which return "N/A"
 * Optimized: single command instead of 3 sequential queries
 */
export async function queryNodeInfo(conn: KosConnection): Promise<{ deltaV: number; timeToNode: number }> {
  // Single atomic query: check for node and get values in one command
  const result = await conn.execute(
    'IF HASNODE { PRINT "NODE|" + NEXTNODE:DELTAV:MAG + "|" + NEXTNODE:ETA. } ELSE { PRINT "NONODE". }',
    3000
  );

  // Parse "NODE|deltaV|eta" format
  // The command echo contains "NONODE" as string literal, so we must check for
  // the actual result pattern first
  const match = result.output.match(/NODE\|([\d.]+)\|([\d.]+)/);
  if (match) {
    return {
      deltaV: parseFloat(match[1]),
      timeToNode: parseFloat(match[2])
    };
  }

  // No node data found - either no node exists or output was empty/error
  return { deltaV: 0, timeToNode: 0 };
}

/**
 * Query a time value from MechJeb (e.g., "31m 10s")
 */
export async function queryTime(conn: KosConnection, suffix: string): Promise<number> {
  const result = await conn.execute(`PRINT ${suffix}.`, 2000);
  return parseTimeString(result.output);
}

/**
 * Sanitize kOS output for error messages.
 * Removes command echoes and extracts meaningful failure reasons.
 */
function sanitizeError(rawOutput: string): string {
  // If output contains command echo, give generic message
  // Check this FIRST because command echo may contain FALSE as parameter
  if (rawOutput.includes('SET ') || rawOutput.includes('PRINT ')) {
    return 'Planner did not return success';
  }

  const errorPatterns = [
    { pattern: /No target/i, message: 'No target set' },
    { pattern: /Cannot find/i, message: 'Command not found - MechJeb may not be available' },
    { pattern: /Syntax error/i, message: 'kOS syntax error' },
    { pattern: /^False$/i, message: 'Planner returned False' },  // Exact match only
  ];

  for (const { pattern, message } of errorPatterns) {
    if (pattern.test(rawOutput)) {
      return message;
    }
  }

  // Return cleaned output (limit length)
  const cleaned = rawOutput.trim().substring(0, 100);
  return cleaned || 'Unknown error';
}

/**
 * Execute a maneuver planning command and return the result with node info
 */
export async function executeManeuverCommand(
  conn: KosConnection,
  cmd: string,
  timeout = 10000
): Promise<ManeuverResult> {
  const result = await conn.execute(cmd, timeout);

  const success = result.output.includes('True');
  if (!success) {
    return { success: false, error: sanitizeError(result.output) };
  }

  // Use kOS native NEXTNODE instead of broken MechJeb INFO suffixes
  const nodeInfo = await queryNodeInfo(conn);

  return {
    success: true,
    deltaV: nodeInfo.deltaV,
    timeToNode: nodeInfo.timeToNode
  };
}
