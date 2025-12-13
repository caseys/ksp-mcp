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
 */
export async function queryNodeInfo(conn: KosConnection): Promise<{ deltaV: number; timeToNode: number }> {
  // Check if node exists first
  const hasNodeResult = await conn.execute('PRINT HASNODE.', 2000);
  if (!hasNodeResult.output.includes('True')) {
    return { deltaV: 0, timeToNode: 0 };
  }

  // Query deltaV using kOS native NEXTNODE
  await delay(500);
  const deltaVResult = await conn.execute('PRINT NEXTNODE:DELTAV:MAG.', 2000);
  const deltaV = parseNumber(deltaVResult.output);

  // Query time to node (ETA is in seconds)
  await delay(500);
  const etaResult = await conn.execute('PRINT NEXTNODE:ETA.', 2000);
  const timeToNode = parseNumber(etaResult.output);

  return { deltaV, timeToNode };
}

/**
 * Query a time value from MechJeb (e.g., "31m 10s")
 */
export async function queryTime(conn: KosConnection, suffix: string): Promise<number> {
  const result = await conn.execute(`PRINT ${suffix}.`, 2000);
  return parseTimeString(result.output);
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
    return { success: false, error: result.output };
  }

  // Use kOS native NEXTNODE instead of broken MechJeb INFO suffixes
  const nodeInfo = await queryNodeInfo(conn);

  return {
    success: true,
    deltaV: nodeInfo.deltaV,
    timeToNode: nodeInfo.timeToNode
  };
}
