/**
 * Time warp library functions
 */

import { KosConnection } from '../../transport/kos-connection.js';

export type WarpTarget = 'node' | 'soi' | 'periapsis' | 'apoapsis';

export interface WarpOptions {
  /** Lead time in seconds before target (default: 60) */
  leadTime?: number;
  /** Timeout for warp completion in ms (default: 120000) */
  timeout?: number;
}

export interface WarpResult {
  success: boolean;
  error?: string;
  body?: string;
  altitude?: number;
}

/**
 * Warp to a specific target (node, soi, periapsis, apoapsis)
 */
export async function warpTo(
  conn: KosConnection,
  target: WarpTarget,
  options: WarpOptions = {}
): Promise<WarpResult> {
  const leadTime = options.leadTime ?? 60;
  const timeout = options.timeout ?? 120000;

  let warpCmd = '';

  switch (target) {
    case 'node':
      // Check if node exists first
      const nodeCheck = await conn.execute('PRINT HASNODE.');
      if (!nodeCheck.output.toLowerCase().includes('true')) {
        return { success: false, error: 'No maneuver node found' };
      }

      warpCmd = `
        SET targetUT TO NEXTNODE:TIME - ${leadTime}.
        IF targetUT > TIME:SECONDS {
          WARPTO(targetUT).
        }
      `;
      break;

    case 'soi':
      const soiCheck = await conn.execute('PRINT SHIP:ORBIT:HASNEXTPATCH.');
      if (!soiCheck.output.toLowerCase().includes('true')) {
        return { success: false, error: 'No SOI transition in current trajectory' };
      }

      warpCmd = `
        SET targetUT TO TIME:SECONDS + SHIP:ORBIT:NEXTPATCHETA - ${leadTime}.
        IF targetUT > TIME:SECONDS {
          WARPTO(targetUT).
        }
      `;
      break;

    case 'periapsis':
      warpCmd = `
        SET targetUT TO TIME:SECONDS + ETA:PERIAPSIS - ${leadTime}.
        IF targetUT > TIME:SECONDS {
          WARPTO(targetUT).
        }
      `;
      break;

    case 'apoapsis':
      warpCmd = `
        SET targetUT TO TIME:SECONDS + ETA:APOAPSIS - ${leadTime}.
        IF targetUT > TIME:SECONDS {
          WARPTO(targetUT).
        }
      `;
      break;
  }

  // Execute warp command
  await conn.execute(warpCmd, 5000);

  // Wait for warp to complete
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const warpStatus = await conn.execute('PRINT WARP.');
    if (warpStatus.output.includes('0')) {
      // Warp complete - get final status
      const statusResult = await conn.execute('PRINT SHIP:BODY:NAME + "," + ROUND(ALTITUDE).');
      const parts = statusResult.output.split(',');
      return {
        success: true,
        body: parts[0]?.trim(),
        altitude: parseInt(parts[1]?.trim() || '0'),
      };
    }
  }

  return { success: false, error: 'Warp timeout' };
}

/**
 * Warp forward by a specific number of seconds
 */
export async function warpForward(
  conn: KosConnection,
  seconds: number,
  timeout: number = 120000
): Promise<WarpResult> {
  await conn.execute(`WARPTO(TIME:SECONDS + ${seconds}).`, 5000);

  // Wait for warp to complete
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const warpStatus = await conn.execute('PRINT WARP.');
    if (warpStatus.output.includes('0')) {
      const statusResult = await conn.execute('PRINT SHIP:BODY:NAME + "," + ROUND(ALTITUDE).');
      const parts = statusResult.output.split(',');
      return {
        success: true,
        body: parts[0]?.trim(),
        altitude: parseInt(parts[1]?.trim() || '0'),
      };
    }
  }

  return { success: false, error: 'Warp timeout' };
}

/**
 * Stop any active time warp
 */
export async function stopWarp(conn: KosConnection): Promise<void> {
  await conn.execute('SET WARP TO 0.');
}
