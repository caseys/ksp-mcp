/**
 * KUNIVERSE Operations
 *
 * kOS KUNIVERSE provides "4th wall" access to KSP game functions
 * like quicksave/quickload, scene management, etc.
 */

import { KosConnection } from '../transport/kos-connection.js';

export interface QuicksaveResult {
  success: boolean;
  saveName: string;
  error?: string;
}

export interface QuickloadResult {
  success: boolean;
  saveName: string;
  error?: string;
}

export interface ListSavesResult {
  success: boolean;
  saves: string[];
  error?: string;
}

/**
 * List available quicksaves
 */
export async function listQuicksaves(conn: KosConnection): Promise<ListSavesResult> {
  try {
    const result = await conn.execute('PRINT KUNIVERSE:QUICKSAVELIST.');

    // Parse the list output - format is like: ["value"] = "save-name"
    const saves: string[] = [];
    const matches = result.output.matchAll(/\["value"\]\s*=\s*"([^"]+)"/g);
    for (const match of matches) {
      saves.push(match[1]);
    }

    return { success: true, saves };
  } catch (error) {
    return {
      success: false,
      saves: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Create a quicksave with the given name
 */
export async function quicksave(conn: KosConnection, saveName: string): Promise<QuicksaveResult> {
  try {
    await conn.execute(`KUNIVERSE:QUICKSAVETO("${saveName}").`);
    return { success: true, saveName };
  } catch (error) {
    return {
      success: false,
      saveName,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Load a quicksave. Note: Connection will be reset after load.
 */
export async function quickload(conn: KosConnection, saveName: string): Promise<QuickloadResult> {
  try {
    await conn.execute(`KUNIVERSE:QUICKLOADFROM("${saveName}").`);
    return { success: true, saveName };
  } catch (error) {
    return {
      success: false,
      saveName,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if quicksave is available (game must be in a valid state)
 */
export async function canQuicksave(conn: KosConnection): Promise<boolean> {
  try {
    const result = await conn.execute('PRINT KUNIVERSE:CANQUICKSAVE.');
    return result.output.includes('True');
  } catch {
    return false;
  }
}
