/**
 * MCP Daemon Deployment
 *
 * Handles deploying the mcp-daemon boot script to vessels.
 * The daemon is a boot file that auto-runs on CPU startup and provides
 * autonomous blackout recovery via WHEN triggers.
 *
 * Uses direct archive write when available (fast), falls back to
 * terminal transfer (slow but reliable).
 */

import { createHash } from 'node:crypto';
import type { KosConnection } from '../transport/kos-connection.js';
import { generateMcpDaemon, MCP_DAEMON_VERSION } from './mcp-daemon.js';
import { generateMcpEnv, MCP_ENV_VERSION } from './mcp-env.js';
import { generateMcpStatus, MCP_STATUS_VERSION } from './mcp-status.js';
import { generateMcpLanding, MCP_LANDING_VERSION } from './mcp-landing.js';
import { deployScript } from './kos-archive.js';

// Combined version: changes when ANY script changes
// This ensures the daemon reinstalls all scripts when any one is updated
export const MCP_COMBINED_VERSION = createHash('md5')
  .update(MCP_DAEMON_VERSION)
  .update(MCP_ENV_VERSION)
  .update(MCP_STATUS_VERSION)
  .update(MCP_LANDING_VERSION)
  .digest('hex')
  .slice(0, 8);

// Boot file paths - source on archive, compiled on local for blackout resilience
const DAEMON_PATH = '0:/boot/mcp_daemon.ks';
const LOCAL_DAEMON_PATH = '1:/boot/mcp_daemon.ksm';
const ENV_PATH = '0:/boot/mcp_env.ks';
const LOCAL_ENV_PATH = '1:/boot/mcp_env.ksm';
const STATUS_PATH = '0:/boot/mcp_status.ks';
const LOCAL_STATUS_PATH = '1:/boot/mcp_status.ksm';
const LANDING_PATH = '0:/boot/mcp_landing.ks';
const LOCAL_LANDING_PATH = '1:/boot/mcp_landing.ksm';

export interface DaemonStatus {
  installed: boolean;
  running: boolean;
  version: string | null;  // Hash string like "a3f2c1b9"
  needsUpdate: boolean;
  locallyInstalled: boolean;  // True if self-installed to local volume
}

export interface DeployResult {
  success: boolean;
  method?: 'direct' | 'terminal';
  error?: string;
}

/**
 * Check if daemon is installed and running.
 *
 * Queries MCP_DAEMON_VERSION global variable which is set when daemon runs.
 * Also checks if boot file is correctly configured and if locally installed.
 */
export async function checkDaemonStatus(conn: KosConnection): Promise<DaemonStatus & { bootFileSet: boolean }> {
  try {
    // Check daemon version, boot file, and local installation in one call
    const result = await conn.execute(
      `PRINT "DAEMON|" + (CHOOSE MCP_DAEMON_VERSION IF DEFINED MCP_DAEMON_VERSION ELSE "") + "|" + CORE:BOOTFILENAME + "|" + EXISTS("${LOCAL_DAEMON_PATH}").`,
      3000
    );
    const match = result.output.match(/DAEMON\|([a-f0-9]*)\|([^|]+)\|(True|False)/i);
    const version = match && match[1].length > 0 ? match[1] : null;
    const bootFile = match ? match[2].trim() : '';
    const bootFileSet = bootFile.toLowerCase().includes('mcp_daemon');
    const locallyInstalled = match ? match[3] === 'True' : false;

    return {
      installed: true, // We'll check file existence separately if needed
      running: version !== null && version.length > 0,
      version,
      needsUpdate: version !== MCP_COMBINED_VERSION,
      bootFileSet,
      locallyInstalled,
    };
  } catch {
    return { installed: false, running: false, version: null, needsUpdate: true, bootFileSet: false, locallyInstalled: false };
  }
}

/**
 * Deploy daemon boot script to vessel.
 *
 * Writes to 0:/boot/mcp_daemon.ks and sets as CPU boot file.
 * Also deploys mcp_env.ks for environment caching.
 * Uses direct archive write when available (fast), falls back to
 * terminal transfer (slow).
 */
export async function deployDaemon(conn: KosConnection): Promise<DeployResult> {
  // Pass combined version so daemon reinstalls when ANY script changes
  const daemonContent = generateMcpDaemon(MCP_COMBINED_VERSION);
  const envContent = generateMcpEnv();
  const statusContent = generateMcpStatus();
  const landingContent = generateMcpLanding();

  // Deploy daemon using fast direct write or fallback to terminal
  const result = await deployScript(conn, DAEMON_PATH, daemonContent);

  if (!result.success) {
    return {
      success: false,
      method: result.method,
      error: result.error,
    };
  }

  // Deploy helper scripts alongside daemon (non-fatal if any fail)
  const envResult = await deployScript(conn, ENV_PATH, envContent);
  if (!envResult.success) {
    console.error(`[boot-deploy] Warning: Failed to deploy mcp_env.ks: ${envResult.error}`);
  }

  const statusResult = await deployScript(conn, STATUS_PATH, statusContent);
  if (!statusResult.success) {
    console.error(`[boot-deploy] Warning: Failed to deploy mcp_status.ks: ${statusResult.error}`);
  }

  const landingResult = await deployScript(conn, LANDING_PATH, landingContent);
  if (!landingResult.success) {
    console.error(`[boot-deploy] Warning: Failed to deploy mcp_landing.ks: ${landingResult.error}`);
  }

  // Set as boot file so it auto-runs on CPU startup (no volume prefix per kOS docs)
  try {
    await conn.execute('SET CORE:BOOTFILENAME TO "boot/mcp_daemon".', 3000);
    return { success: true, method: result.method };
  } catch (error) {
    return {
      success: false,
      method: result.method,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Ensure boot file is set to daemon.
 * Call this even if daemon is already running to ensure persistence.
 */
export async function ensureBootFile(conn: KosConnection): Promise<boolean> {
  try {
    // No volume prefix per kOS docs - just the relative path
    await conn.execute('SET CORE:BOOTFILENAME TO "boot/mcp_daemon".', 3000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the daemon. Copies scripts to local, compiles, and reboots for clean start.
 * All scripts on local volume for blackout resilience (archive not accessible during blackout).
 * Uses extensionless paths so kOS falls back from .ksm to .ks if needed.
 */
export async function runDaemon(conn: KosConnection): Promise<void> {
  // Create local boot directory
  await conn.execute('IF NOT EXISTS("1:/boot") { CREATEDIR("1:/boot"). }', 3000);

  // Copy .ks sources to local first (for kOS fallback if .ksm missing)
  await conn.execute(`COPYPATH("${DAEMON_PATH}", "1:/boot/mcp_daemon.ks").`, 3000);
  await conn.execute(`COPYPATH("${ENV_PATH}", "1:/boot/mcp_env.ks").`, 3000);
  await conn.execute(`COPYPATH("${STATUS_PATH}", "1:/boot/mcp_status.ks").`, 3000);
  await conn.execute(`COPYPATH("${LANDING_PATH}", "1:/boot/mcp_landing.ks").`, 3000);

  // Compile from local .ks to local .ksm (faster execution)
  // Use fireAndForget to avoid sentinel interference with COMPILE output
  await conn.execute(`COMPILE "1:/boot/mcp_daemon.ks" TO "${LOCAL_DAEMON_PATH}".`, 5000, { fireAndForget: true });
  await new Promise(r => setTimeout(r, 500));
  await conn.execute(`COMPILE "1:/boot/mcp_env.ks" TO "${LOCAL_ENV_PATH}".`, 5000, { fireAndForget: true });
  await new Promise(r => setTimeout(r, 500));
  await conn.execute(`COMPILE "1:/boot/mcp_status.ks" TO "${LOCAL_STATUS_PATH}".`, 5000, { fireAndForget: true });
  await new Promise(r => setTimeout(r, 500));
  await conn.execute(`COMPILE "1:/boot/mcp_landing.ks" TO "${LOCAL_LANDING_PATH}".`, 5000, { fireAndForget: true });
  await new Promise(r => setTimeout(r, 500));

  // Set boot file (no volume prefix per kOS docs) and reboot
  await conn.execute('SET CORE:BOOTFILENAME TO "boot/mcp_daemon".', 2000);
  await conn.execute('REBOOT.', 1000, { fireAndForget: true });
}

export { MCP_DAEMON_VERSION } from './mcp-daemon.js';
export { MCP_ENV_VERSION } from './mcp-env.js';
export { MCP_STATUS_VERSION } from './mcp-status.js';
export { MCP_LANDING_VERSION } from './mcp-landing.js';

// Re-export archive utilities
export { getKspRoot, getArchivePath } from './kos-archive.js';
