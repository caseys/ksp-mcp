/**
 * kOS Operation State Persistence
 *
 * Stores operation state in a kOS variable on the vessel.
 * This persists across service restarts as long as KSP is running.
 *
 * Variable format: `<opType>|<toolName>|<target>|<startUT>`
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
 * Set the operation state on the vessel via kOS.
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
  // Format: opType|toolName|target|startUT
  const cmd = `SET _MCP_OP TO "${opType}|${toolName}|${target}|" + TIME:SECONDS.`;
  await conn.execute(cmd, 3000);
}

/**
 * Clear the operation state on the vessel.
 */
export async function clearKosOperation(conn: KosConnection): Promise<void> {
  await conn.execute('SET _MCP_OP TO "".', 3000);
}

/**
 * Query the current operation state from the vessel.
 * Returns null if no operation is set or the variable is empty.
 */
export async function getKosOperation(conn: KosConnection): Promise<KosOperationState | null> {
  try {
    // Query operation state and current time for duration calc
    // Use CHOOSE to handle undefined variable (daemon may not have run yet)
    const result = await conn.execute(
      'PRINT "MCPOP:" + (CHOOSE _MCP_OP IF DEFINED _MCP_OP ELSE "") + "|" + TIME:SECONDS.',
      3000
    );

    // Parse "MCPOP:opType|toolName|target|startUT|currentUT"
    const match = result.output.match(/MCPOP:([^|]*)\|([^|]*)\|([^|]*)\|([\d.]*)\|([\d.]+)/);
    if (!match) {
      return null;
    }

    const opType = match[1] as KosOperationType;
    const toolName = match[2];
    const target = match[3];
    const startUT = parseFloat(match[4]) || 0;
    const currentUT = parseFloat(match[5]) || 0;

    // Empty opType means no operation
    if (!opType) {
      return null;
    }

    return {
      opType,
      toolName,
      target,
      startUT,
      duration: startUT > 0 ? currentUT - startUT : 0,
    };
  } catch {
    // Variable might not exist yet (before safety monitor initializes it)
    return null;
  }
}

