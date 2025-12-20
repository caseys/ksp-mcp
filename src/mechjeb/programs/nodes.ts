/**
 * Maneuver Node Operations
 *
 * Library functions for managing maneuver nodes.
 */

import type { KosConnection } from '../../transport/kos-connection.js';

export interface ClearNodesResult {
  success: boolean;
  nodesCleared: number;
  error?: string;
}

/**
 * Clear all maneuver nodes.
 *
 * @param conn kOS connection
 * @returns Result with count of nodes cleared
 */
export async function clearNodes(conn: KosConnection): Promise<ClearNodesResult> {
  try {
    const result = await conn.execute(
      'SET _N TO ALLNODES:LENGTH. UNTIL NOT HASNODE { REMOVE NEXTNODE. } PRINT "CLEARED|" + _N.',
      5000
    );

    const match = result.output.match(/CLEARED\|(\d+)/);
    const nodesCleared = match ? parseInt(match[1], 10) : 0;

    return { success: true, nodesCleared };
  } catch (error) {
    return {
      success: false,
      nodesCleared: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
