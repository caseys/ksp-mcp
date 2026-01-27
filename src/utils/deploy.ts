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
import { deployScript } from './kos-archive.js';
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
    await conn.raw(`COPYPATH("${STATUS_PATH}", "${LOCAL_STATUS_PATH}").`, 3000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the version string from a deployed script's first line.
 * Returns the version hash or null if not found/readable.
 */
async function getScriptVersionFromPath(
  conn: KosConnection,
  localPath: string
): Promise<string | null> {
  try {
    const result = await conn.queue(
      `IF EXISTS("${localPath}") { LOCAL lines IS OPEN("${localPath}"):READALL. LOCAL iter IS lines:ITERATOR. IF iter:NEXT { PRINT iter:VALUE. } ELSE { PRINT "[EMPTY]". } } ELSE { PRINT "[NO_FILE]". }`,
      3000
    );
    if (!result.success) return null;
    const content = result.output.trim();
    if (content === '[NO_FILE]' || content === '[EMPTY]') return null;
    const versionMatch = content.match(/\/\/\s*version:\s*(\w+)/);
    return versionMatch?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Ensure status script is deployed and available.
 *
 * Checks version via first-line comment and redeploys if outdated.
 */
export async function ensureStatusScript(conn: KosConnection): Promise<boolean> {
  const statusVersion = getScriptVersion(STATUS_SCRIPT);
  logDeploy('info', `[deploy] Current status script version: ${statusVersion}`);

  // Check local version first (faster, works during blackout)
  const localVersion = await getScriptVersionFromPath(conn, LOCAL_STATUS_PATH);
  logDeploy('info', `[deploy] Ship volume 1 status script version: ${localVersion ?? 'not found'}`);

  if (localVersion === statusVersion) {
    logDeploy('info', `[deploy] Local version matches - no deployment needed`);
    return true;
  }

  // Check archive version
  const archiveVersion = await getScriptVersionFromPath(conn, STATUS_PATH);
  logDeploy('info', `[deploy] Archive (volume 0) status script version: ${archiveVersion ?? 'not found'}`);

  if (archiveVersion !== statusVersion) {
    // Archive missing or outdated - deploy fresh
    logDeploy('info', `[deploy] Deploying status script to archive (need: ${statusVersion})`);
    const deployResult = await deployStatusScript(conn);
    if (!deployResult.success) {
      logDeploy('error', `[deploy] Failed to deploy status script: ${deployResult.error}`);
      return false;
    }
    logDeploy('info', `[deploy] Deployed status script via ${deployResult.method}`);
  }

  // Copy to local volume for blackout resilience
  logDeploy('info', `[deploy] Copying status script from archive (volume 0) to local (volume 1)`);
  const copied = await copyStatusToLocal(conn);
  if (copied) {
    logDeploy('info', '[deploy] Copied status script to local volume 1');
  } else {
    logDeploy('warn', '[deploy] Failed to copy status script to local');
    // Not fatal - archive version still works
  }

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
