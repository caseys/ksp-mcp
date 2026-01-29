/**
 * kOS Operation State Persistence
 *
 * Stores operation state in a JSON file on kOS volume 1.
 * This persists across Ctrl+C and script restarts.
 *
 * Uses direct WRITEJSON/DELETEPATH commands (fast) instead of
 * running the full status script (which collects all telemetry).
 * Reading operation state goes through getStatusData() cache.
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

/**
 * Set the operation state on the vessel.
 * Writes directly to the op file via WRITEJSON — no need to run the full status script.
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
  const opValue = `${opType}:${toolName}:${target}`;
  await conn.raw(
    `WRITEJSON(LEXICON("op", "${opValue}", "ts", TIME:SECONDS), "1:/mcp_op.json").`
  );
}

/**
 * Clear the operation state on the vessel.
 */
export async function clearKosOperation(conn: KosConnection): Promise<void> {
  await conn.raw('IF EXISTS("1:/mcp_op.json") { DELETEPATH("1:/mcp_op.json"). }');
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
