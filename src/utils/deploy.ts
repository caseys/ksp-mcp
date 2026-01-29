/**
 * MCP Status Script Deployment
 *
 * Handles deploying the mcp_status.ks script to vessels.
 * This is the only kOS script needed - it's self-contained.
 *
 * Uses direct archive write when available (fast), falls back to
 * terminal transfer (slow but reliable).
 */

import type { KosConnection } from '../transport/kos-connection.js';
import { deployScript, readVersionFromArchive } from './kos-archive.js';
import { getScript, getScriptVersion } from './kos-scripts.js';
import { getActiveBroadcastLogger } from './mcp-logger.js';

/**
 * Dual logging helper - logs to both console.error (always) and MCP logger (if available).
 * This ensures CLI users see output AND MCP clients receive notifications.
 */
function logDeploy(level: 'info' | 'warn' | 'error', msg: string): void {
  console.error(msg);
  getActiveBroadcastLogger()?.progress(msg);
}

// Script name and paths
const STATUS_SCRIPT = 'mcp-status.ks';
const STATUS_PATH = '0:/mcp_status.ks';
const LOCAL_STATUS_PATH = '1:/mcp_status.ks';

// Cache: once scripts are verified this session, skip re-checking
let scriptsVerified = false;

/**
 * Reset the scripts verified cache.
 * Call this when the connection is reset to force re-verification.
 */
export function resetScriptsVerified(): void {
  scriptsVerified = false;
}


export interface DeployResult {
  success: boolean;
  method?: 'direct' | 'terminal';
  error?: string;
}

/**
 * Deploy status script to archive.
 * Uses direct archive write when available (fast), falls back to terminal.
 */
export async function deployStatusScript(conn: KosConnection): Promise<DeployResult> {
  const { content } = getScript(STATUS_SCRIPT);
  return deployScript(conn, STATUS_PATH, content);
}

/**
 * Copy status script from archive to local volume.
 * Local volume is accessible during radio blackout.
 */
export async function copyStatusToLocal(conn: KosConnection): Promise<boolean> {
  try {
    // Copy from archive to local
    await conn.raw(`COPYPATH("${STATUS_PATH}", "${LOCAL_STATUS_PATH}").`, 5000);
    return true;
  } catch {
    return false;
  }
}


/**
 * Ensure status script is deployed and available.
 *
 * Checks version via first-line comment and redeploys if outdated.
 */
export async function ensureStatusScript(conn: KosConnection): Promise<boolean> {
  if (scriptsVerified) return true;

  const statusVersion = getScriptVersion(STATUS_SCRIPT);
  logDeploy('info', `[deploy] Status script version: ${statusVersion}`);

  // 1. Check archive version FROM DISK (instant, no kOS needed)
  const archiveVersion = readVersionFromArchive('mcp_status.ks');
  logDeploy('info', `[deploy] Archive (disk): ${archiveVersion ?? 'not found'}`);

  if (archiveVersion !== statusVersion) {
    // Archive missing or outdated — deploy to disk
    logDeploy('info', `[deploy] Deploying to archive (need: ${statusVersion})`);
    const result = await deployStatusScript(conn);
    if (!result.success) {
      logDeploy('error', `[deploy] Failed to deploy: ${result.error}`);
      return false;
    }
    logDeploy('info', `[deploy] Deployed via ${result.method}`);
  }

  // 2. Copy archive → volume 1 via kOS (idempotent, needs radio)
  const copied = await copyStatusToLocal(conn);
  if (copied) {
    logDeploy('info', '[deploy] Volume 1 synced');
  } else {
    logDeploy('info', '[deploy] Volume 1 copy failed (CPU not ready or no radio)');
  }

  scriptsVerified = true;
  return true;
}

/**
 * Ensure all MCP scripts are deployed with correct versions.
 * Call this at startup/connection time to avoid deployment during operations.
 *
 * @param conn - kOS connection
 * @returns true if scripts are deployed successfully
 */
export async function ensureAllScripts(conn: KosConnection): Promise<boolean> {
  // Skip if already verified this session
  if (scriptsVerified) {
    return true;
  }

  const statusOk = await ensureStatusScript(conn);

  if (statusOk) {
    scriptsVerified = true;
  }

  return statusOk;
}

// Re-export for external use
export { getScriptVersion } from './kos-scripts.js';
export { getKspRoot, getArchivePath } from './kos-archive.js';
