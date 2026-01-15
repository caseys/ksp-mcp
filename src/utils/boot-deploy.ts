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

import type { KosConnection } from '../transport/kos-connection.js';
import { generateMcpDaemon, MCP_DAEMON_VERSION } from './mcp-daemon.js';
import { deployScript } from './kos-archive.js';

// Boot file paths
const DAEMON_PATH = '0:/boot/mcp_daemon.ks';       // Archive (deployment target)
const LOCAL_DAEMON_PATH = '1:/boot/mcp_daemon.ks'; // Local volume (self-installed)

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
      needsUpdate: version !== MCP_DAEMON_VERSION,
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
 * Uses direct archive write when available (fast), falls back to
 * terminal transfer (slow).
 */
export async function deployDaemon(conn: KosConnection): Promise<DeployResult> {
  const daemonContent = generateMcpDaemon();

  // Deploy using fast direct write or fallback to terminal
  const result = await deployScript(conn, DAEMON_PATH, daemonContent);

  if (!result.success) {
    return {
      success: false,
      method: result.method,
      error: result.error,
    };
  }

  // Set as boot file so it auto-runs on CPU startup
  try {
    await conn.execute(`SET CORE:BOOTFILENAME TO "${DAEMON_PATH}".`, 3000);
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
    await conn.execute(`SET CORE:BOOTFILENAME TO "${DAEMON_PATH}".`, 3000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run the daemon. Clears MCP_DAEMON_RUNNING first to ensure fresh start.
 */
export async function runDaemon(conn: KosConnection): Promise<void> {
  // Clear the running flag first - the old daemon loop is dead (we Ctrl+C'd it)
  // Without this, boot file sees "Already running" and doesn't start a new loop
  await conn.execute('SET MCP_DAEMON_RUNNING TO FALSE.', 2000, { clear: false });
  await conn.execute(`RUNPATH("${DAEMON_PATH}").`, 5000, { fireAndForget: true, clear: false });
}

export { MCP_DAEMON_VERSION } from './mcp-daemon.js';

// Re-export archive utilities
export { getKspRoot, getArchivePath } from './kos-archive.js';
