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

export interface CraftInfo {
  name: string;
  editor: 'VAB' | 'SPH';
  launchsite: 'LAUNCHPAD' | 'RUNWAY';
  mass: number;
  cost: number;
  partcount: number;
}

export interface ListShipsResult {
  success: boolean;
  ships: CraftInfo[];
  error?: string;
}

export interface LoadShipResult {
  success: boolean;
  craftName: string;
  error?: string;
}

export interface SwitchVesselResult {
  success: boolean;
  vesselName: string;
  error?: string;
}

/**
 * List available quicksaves
 */
export async function listQuicksaves(conn: KosConnection): Promise<ListSavesResult> {
  const result = await conn.queue('PRINT KUNIVERSE:QUICKSAVELIST.', 5000);

  if (!result.success) {
    return { success: false, saves: [], error: result.error };
  }

  // Parse the list output - format is like: ["value"] = "save-name"
  const saves: string[] = [];
  const matches = result.output.matchAll(/\["value"\]\s*=\s*"([^"]+)"/g);
  for (const match of matches) {
    saves.push(match[1]);
  }

  return { success: true, saves };
}

/**
 * Create a quicksave with the given name
 */
export async function quicksave(conn: KosConnection, saveName: string): Promise<QuicksaveResult> {
  try {
    await conn.raw(`KUNIVERSE:QUICKSAVETO("${saveName}").`);
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
    await conn.raw(`KUNIVERSE:QUICKLOADFROM("${saveName}").`, config.timeouts.command, { fireAndForget: true });
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
  const result = await conn.queue('PRINT KUNIVERSE:CANQUICKSAVE.', 3000);
  return result.success && result.output.includes('True');
}

/**
 * List all craft templates from KUNIVERSE:CRAFTLIST()
 * Returns craft from both VAB and SPH.
 *
 * Note: CRAFTLIST can contain null/invalid entries, so we use defensive checks.
 * We also fetch in batches to avoid kOS terminal buffer overflow.
 */
export async function listCraftTemplates(conn: KosConnection): Promise<ListShipsResult> {
  // First get the total count
  const countResult = await conn.queue('PRINT KUNIVERSE:CRAFTLIST():LENGTH.', 5000);
  if (!countResult.success) {
    return { success: false, ships: [], error: countResult.error };
  }

  const totalCount = parseInt(countResult.output.trim(), 10);
  if (isNaN(totalCount) || totalCount === 0) {
    return { success: true, ships: [] };
  }

  // Fetch in batches to avoid buffer overflow
  // Use smaller batches since JSON is verbose
  const BATCH_SIZE = 10;
  const allShips: CraftInfo[] = [];

  for (let startIdx = 0; startIdx < totalCount; startIdx += BATCH_SIZE) {
    const endIdx = Math.min(startIdx + BATCH_SIZE, totalCount);

    // Build JSON for this batch using index access
    // IMPORTANT: Check PARTCOUNT > 0 FIRST - empty entries may have null NAME
    // Use descriptive variable names to avoid kOS builtin conflicts (per CLAUDE.md)
    const kosScript = [
      'LOCAL craftList IS KUNIVERSE:CRAFTLIST().',
      'LOCAL jsonResult IS "[".',
      'LOCAL isFirst IS TRUE.',
      `FROM { LOCAL idx IS ${startIdx}. } UNTIL idx >= ${endIdx} STEP { SET idx TO idx + 1. } DO {`,
      '  LOCAL craft IS craftList[idx].',
      '  IF craft:PARTCOUNT > 0 {',  // Check partcount FIRST - empty entries have null properties
      '    LOCAL craftName IS craft:NAME.',
      '    IF craftName:LENGTH > 0 {',
      '      IF NOT isFirst { SET jsonResult TO jsonResult + ",". }',
      '      SET isFirst TO FALSE.',
      '      SET jsonResult TO jsonResult + "{" +',
      '        CHAR(34) + "name" + CHAR(34) + ":" + CHAR(34) + craftName + CHAR(34) + "," +',
      '        CHAR(34) + "editor" + CHAR(34) + ":" + CHAR(34) + craft:EDITOR + CHAR(34) + "," +',
      '        CHAR(34) + "launchsite" + CHAR(34) + ":" + CHAR(34) + craft:LAUNCHSITE + CHAR(34) + "," +',
      '        CHAR(34) + "mass" + CHAR(34) + ":" + ROUND(craft:MASS,3) + "," +',
      '        CHAR(34) + "cost" + CHAR(34) + ":" + ROUND(craft:COST,0) + "," +',
      '        CHAR(34) + "partcount" + CHAR(34) + ":" + craft:PARTCOUNT +',
      '        "}".',
      '    }',
      '  }',
      '}',
      'SET jsonResult TO jsonResult + "]".',
      'PRINT jsonResult.',
    ].join(' ');

    const result = await conn.queue(kosScript, 20_000);

    if (!result.success) {
      // If we got some ships already, return those rather than failing completely
      if (allShips.length > 0) {
        return { success: true, ships: allShips };
      }
      return { success: false, ships: [], error: result.error };
    }

    try {
      const batchShips = JSON.parse(result.output) as CraftInfo[];
      // Filter out stock craft (localization keys starting with #)
      const validShips = batchShips.filter(s =>
        s.name.length > 0 &&
        !s.name.startsWith('#autoLOC_') &&
        !s.name.startsWith('#auto')
      );
      allShips.push(...validShips);
    } catch (parseError) {
      // If we got some ships already, return those
      if (allShips.length > 0) {
        return { success: true, ships: allShips };
      }
      return {
        success: false,
        ships: [],
        error: `Failed to parse craft list: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      };
    }
  }

  return { success: true, ships: allShips };
}

/**
 * Check if a craft with the given name exists in CRAFTLIST
 */
async function craftExists(conn: KosConnection, craftName: string): Promise<boolean> {
  const safeName = craftName.replaceAll('"', '""').toLowerCase();
  // Use a quick search - stop at first match
  const kosScript = [
    'LOCAL found IS FALSE.',
    'FOR craft IN KUNIVERSE:CRAFTLIST() {',
    '  IF NOT found AND craft:PARTCOUNT > 0 {',
    `    IF craft:NAME:TOLOWER = "${safeName}" { SET found TO TRUE. }`,
    '  }',
    '}',
    'PRINT found.',
  ].join(' ');

  const result = await conn.queue(kosScript, 20_000);
  return result.success && result.output.trim() === 'True';
}

/**
 * Launch a craft at its default launch site.
 * Note: This terminates the kOS program and resets the connection.
 */
export async function launchCraft(
  conn: KosConnection,
  craftName: string
): Promise<LoadShipResult> {
  // First check if craft exists (quick validation)
  const exists = await craftExists(conn, craftName);
  if (!exists) {
    return {
      success: false,
      craftName,
      error: `Craft "${craftName}" not found. Use list_ships to see available craft.`,
    };
  }

  // Escape craft name for kOS string
  const safeCraftName = craftName.replaceAll('"', '""');

  // Build launch script - find craft and launch
  // LAUNCHCRAFT terminates the program immediately
  const kosScript = [
    'FOR craft IN KUNIVERSE:CRAFTLIST() {',
    '  IF craft:PARTCOUNT > 0 {',
    `    IF craft:NAME:TOLOWER = "${safeCraftName.toLowerCase()}" {`,
    '      KUNIVERSE:LAUNCHCRAFT(craft).',
    '    }',
    '  }',
    '}',
  ].join(' ');

  // Use raw() with fireAndForget since launch terminates the program
  await conn.raw(kosScript, config.timeouts.command, { fireAndForget: true });

  // Launch succeeded (connection will be reset)
  return {
    success: true,
    craftName,
  };
}

/**
 * Switch to another vessel using KUNIVERSE:FORCESETACTIVEVESSEL
 * Note: This terminates the kOS program and resets the connection.
 */
export async function switchVessel(
  conn: KosConnection,
  vesselName: string
): Promise<SwitchVesselResult> {
  // Escape vessel name for kOS string
  const safeVesselName = vesselName.replaceAll('"', '""');

  // First check if vessel exists using VESSEL() function
  // VESSEL() throws an error if vessel doesn't exist
  const checkScript = `IF VESSEL("${safeVesselName}"):NAME:LENGTH > 0 { PRINT "EXISTS". } ELSE { PRINT "NOTFOUND". }`;

  try {
    const checkResult = await conn.queue(checkScript, 5000);
    if (!checkResult.success || !checkResult.output.includes('EXISTS')) {
      return {
        success: false,
        vesselName,
        error: `Vessel "${vesselName}" not found.`,
      };
    }
  } catch {
    return {
      success: false,
      vesselName,
      error: `Vessel "${vesselName}" not found or not accessible.`,
    };
  }

  // Switch to the vessel - this terminates the kOS program
  const switchScript = `KUNIVERSE:FORCESETACTIVEVESSEL(VESSEL("${safeVesselName}")).`;

  // Use raw() with fireAndForget since switching terminates the program
  await conn.raw(switchScript, config.timeouts.command, { fireAndForget: true });

  return {
    success: true,
    vesselName,
  };
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

/**
 * List ships tool definition
 */
export const listShipsTool: ToolDefinition = {
  name: 'list_ships',
  description: 'List all saved craft (ships/planes) available to launch from VAB/SPH.',
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
      const result = await listCraftTemplates(conn);

      if (result.success) {
        if (result.ships.length === 0) {
          return ctx.successResponse('list_ships', 'No saved craft found.');
        }
        // Format output for readability
        const lines = result.ships.map(
          (s) => `${s.name} (${s.editor}, ${s.partcount} parts, ${Math.round(s.mass * 1000) / 1000}t)`
        );
        return ctx.successResponse('list_ships', `Available craft:\n${lines.join('\n')}`);
      } else {
        return ctx.errorResponse('list_ships', result.error ?? 'Failed to list craft');
      }
    } catch (error) {
      return ctx.errorResponse('list_ships', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Load ship tool definition
 */
export const loadShipTool: ToolDefinition = {
  name: 'load_ship',
  description:
    'Launch a saved craft from VAB/SPH. Terminates current kOS connection.',
  inputSchema: {
    craftName: z.string().describe('Name of the craft to launch (use list_ships to see available)'),
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
      const result = await launchCraft(conn, args.craftName as string);

      // Disconnect after launch since connection will be reset
      await handleDisconnect();

      if (result.success) {
        return ctx.successResponse(
          'load_ship',
          `Launched ${result.craftName}. Connection reset - reconnect to continue.`
        );
      } else {
        return ctx.errorResponse('load_ship', result.error ?? 'Failed to launch craft');
      }
    } catch (error) {
      return ctx.errorResponse('load_ship', error instanceof Error ? error.message : String(error));
    }
  },
};

/**
 * Switch vessel tool definition
 */
export const switchVesselTool: ToolDefinition = {
  name: 'switch_vessel',
  description:
    'Switch to another vessel by name. Terminates current kOS connection.',
  inputSchema: {
    vesselName: z.string().describe('Name of the vessel to switch to'),
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
      const result = await switchVessel(conn, args.vesselName as string);

      // Disconnect after switch since connection will be reset
      await handleDisconnect();

      if (result.success) {
        return ctx.successResponse(
          'switch_vessel',
          `Switched to vessel: ${result.vesselName}. Connection reset - reconnect to continue.`
        );
      } else {
        return ctx.errorResponse('switch_vessel', result.error ?? 'Failed to switch vessel');
      }
    } catch (error) {
      return ctx.errorResponse('switch_vessel', error instanceof Error ? error.message : String(error));
    }
  },
};
