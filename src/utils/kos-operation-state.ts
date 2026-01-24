/**
 * kOS Operation State Persistence
 *
 * Stores operation state in a file on kOS volume 1.
 * This persists across Ctrl+C and script restarts.
 *
 * The status script handles reading/writing the operation file.
 * We just run the status script with an operation parameter to set it.
 */

import type { KosConnection } from '../transport/kos-connection.js';

export type KosOperationType = 'ascent' | 'landing' | 'node' | 'maneuver' | '';

export interface KosOperationState {
  opType: KosOperationType;
  toolName: string;
  target: string;
  startUT: number;
  /** Duration in seconds (game time) */
  duration: number;
}

// Status script paths - try local first (blackout resilient), fall back to archive
const LOCAL_STATUS = '1:/mcp_status.ks';
const ARCHIVE_STATUS = '0:/mcp_status.ks';

/**
 * Run status script with optional parameter, trying local then archive.
 * Single command with EXISTS check to avoid extra round-trip.
 */
async function runStatusScript(conn: KosConnection, param?: string): Promise<string> {
  const paramStr = param !== undefined ? `, "${param}"` : '';
  // Single command: check EXISTS and run appropriate path
  // Uses queue() because we need to capture script output
  const result = await conn.queue(
    `IF EXISTS("${LOCAL_STATUS}") { RUNPATH("${LOCAL_STATUS}"${paramStr}). } ELSE { RUNPATH("${ARCHIVE_STATUS}"${paramStr}). }`,
    5000
  );

  return result.output;
}

/**
 * Set the operation state on the vessel.
 * Runs the status script with the operation parameter.
 *
 * @param conn kOS connection
 * @param opType Operation type (ascent, landing, node, maneuver)
 * @param toolName Name of the tool that started the operation
 * @param target Target info (altitude for ascent, coords for landing, etc.)
 */
export async function setKosOperation(
  conn: KosConnection,
  opType: KosOperationType,
  toolName: string,
  target: string = ''
): Promise<void> {
  // Format: opType:toolName:target (using : since | might conflict with kOS)
  const opValue = `${opType}:${toolName}:${target}`;
  await runStatusScript(conn, opValue);
}

/**
 * Clear the operation state on the vessel.
 */
export async function clearKosOperation(conn: KosConnection): Promise<void> {
  // Empty string clears the operation
  await runStatusScript(conn, '');
}

/**
 * Query the current operation state from the vessel.
 * Returns null if no operation is set or the variable is empty.
 */
export async function getKosOperation(conn: KosConnection): Promise<KosOperationState | null> {
  try {
    // Use getStatusData to parse the JSON output properly
    const { getStatusData } = await import('../lib/mechjeb/telemetry.js');
    const status = await getStatusData(conn);

    const opValue = status.op;
    if (!opValue) {
      return null;
    }

    // Parse opType:toolName:target
    const parts = opValue.split(':');
    const opType = (parts[0] || '') as KosOperationType;
    const toolName = parts[1] || '';
    const target = parts[2] || '';

    if (!opType) {
      return null;
    }

    // Note: We don't have duration info in file-based approach
    // Operations that need duration should track their own start time
    return {
      opType,
      toolName,
      target,
      startUT: 0,
      duration: 0,
    };
  } catch {
    return null;
  }
}
