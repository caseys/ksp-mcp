/**
 * KUNIVERSE Operations
 *
 * kOS KUNIVERSE provides "4th wall" access to KSP game functions
 * like quicksave/quickload, scene management, etc.
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { config } from '../../config/index.js';

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
    await conn.execute(`KUNIVERSE:QUICKLOADFROM("${saveName}").`, config.timeouts.command, { fireAndForget: true });
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

// ============================================================================
// Tool Definitions
// ============================================================================

import { z } from 'zod';
import type { ToolDefinition } from '../tool-types.js';
import { handleDisconnect } from '../../transport/connection-tools.js';

/**
 * Load save tool definition
 */
export const loadSaveTool: ToolDefinition = {
  name: 'load_save',
  description: 'Load a quicksave.',
  inputSchema: {
    saveName: z.string().describe('Quicksave name. Use list_saves to see available saves.'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 2,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const result = await quickload(conn, args.saveName as string);

      // Disconnect after load since connection will be reset
      await handleDisconnect();

      if (result.success) {
        return ctx.successResponse('load_save', `Loaded save: ${result.saveName}. Connection reset - reconnect to continue.`);
      } else {
        return ctx.errorResponse('load_save', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('load_save', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * List saves tool definition
 */
export const listSavesTool: ToolDefinition = {
  name: 'list_saves',
  description: 'List quicksaves.',
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 2,
  handler: async (_args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const result = await listQuicksaves(conn);

      if (result.success) {
        if (result.saves.length === 0) {
          return ctx.successResponse('list_saves', 'No quicksaves found.');
        }
        return ctx.successResponse('list_saves', `Quicksaves:\n${result.saves.join('\n')}`);
      } else {
        return ctx.errorResponse('list_saves', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('list_saves', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Quicksave tool definition
 */
export const quicksaveTool: ToolDefinition = {
  name: 'quicksave',
  description: 'Create quicksave.',
  inputSchema: {
    saveName: z.string().describe('Name for the quicksave'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 2,
  handler: async (args, ctx) => {
    try {
      const conn = await ctx.ensureConnected();
      const result = await quicksave(conn, args.saveName as string);

      if (result.success) {
        return ctx.successResponse('quicksave', `Created quicksave: ${result.saveName}`);
      } else {
        return ctx.errorResponse('quicksave', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('quicksave', error instanceof Error ? error.message : String(error));
    }
  },
};
