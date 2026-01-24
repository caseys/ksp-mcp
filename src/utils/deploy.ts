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
import { getScript, getScriptVersion, deployKosScript } from './kos-scripts.js';

// Script names and paths
const STATUS_SCRIPT = 'mcp-status.ks';
const ALIGN_SCRIPT = 'mcp-align.ks';

// Cache: once scripts are verified this session, skip re-checking
let scriptsVerified = false;

// Status script paths
const STATUS_PATH = '0:/mcp_status.ks';
const LOCAL_STATUS_PATH = '1:/mcp_status.ks';

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
 * Ensure status script is deployed and available.
 *
 * Checks version via first-line comment and redeploys if outdated.
 */
export async function ensureStatusScript(conn: KosConnection): Promise<boolean> {
  const statusVersion = getScriptVersion(STATUS_SCRIPT);

  // Check local version first (faster, works during blackout)
  const localVersionOk = await checkScriptVersion(conn, LOCAL_STATUS_PATH, statusVersion);
  if (localVersionOk) {
    return true; // Local exists with correct version
  }

  // Check archive version
  const archiveVersionOk = await checkScriptVersion(conn, STATUS_PATH, statusVersion);
  if (!archiveVersionOk) {
    // Archive missing or outdated - deploy fresh
    console.error(`[deploy] Deploying status script (current: none, need: ${statusVersion})`);
    const deployResult = await deployStatusScript(conn);
    if (!deployResult.success) {
      console.error(`[deploy] Failed to deploy status script: ${deployResult.error}`);
      return false;
    }
  }

  // Copy to local volume for blackout resilience
  const copied = await copyStatusToLocal(conn);
  if (copied) {
    console.error('[deploy] Copied status script to local');
  } else {
    console.error('[deploy] Failed to copy status script to local');
    // Not fatal - archive version still works
  }

  return true;
}

// ============================================================================
// All Scripts Deployment
// ============================================================================

// Align script paths
const ALIGN_ARCHIVE_PATH = '0:/mcp_align.ks';
const ALIGN_LOCAL_PATH = '1:/mcp_align.ks';

/**
 * Check if a script exists with the correct version by reading first line.
 * Scripts have version embedded as: // version: <hash>
 *
 * Uses queue() for clean output extraction without echo interference.
 */
async function checkScriptVersion(
  conn: KosConnection,
  localPath: string,
  expectedVersion: string
): Promise<boolean> {
  try {
    // Use queue() for clean output - no manual markers needed
    // Iterator pattern: READALL gives FileContent, ITERATOR walks lines
    const result = await conn.queue(
      `IF EXISTS("${localPath}") { LOCAL lines IS OPEN("${localPath}"):READALL. LOCAL iter IS lines:ITERATOR. IF iter:NEXT { PRINT iter:VALUE. } ELSE { PRINT "[EMPTY]". } } ELSE { PRINT "[NO_FILE]". }`,
      3000
    );

    if (!result.success) {
      // Connection issue - return false to trigger deploy check
      return false;
    }

    const content = result.output.trim();
    if (content === '[NO_FILE]' || content === '[EMPTY]') {
      return false;
    }

    // Look for version comment: // version: <hash>
    const versionMatch = content.match(/\/\/\s*version:\s*(\w+)/);
    const foundVersion = versionMatch?.[1] ?? null;

    if (foundVersion !== expectedVersion) {
      console.error(
        `[deploy] Version mismatch ${localPath}: found=${foundVersion ?? 'none'}, expected=${expectedVersion}`
      );
    }

    return foundVersion === expectedVersion;
  } catch (err) {
    console.error(`[deploy] Version check error ${localPath}: ${err}`);
    return false;
  }
}

/**
 * Ensure all MCP scripts are deployed with correct versions.
 * Call this at startup/connection time to avoid deployment during operations.
 *
 * @param conn - kOS connection
 * @returns Object with deployment status for each script
 */
export async function ensureAllScripts(conn: KosConnection): Promise<{
  status: boolean;
  align: boolean;
}> {
  // Skip if already verified this session
  if (scriptsVerified) {
    return { status: true, align: true };
  }

  // Deploy status script
  const statusOk = await ensureStatusScript(conn);

  // Deploy align script with version check
  // Check BOTH local and archive paths to avoid unnecessary redeployment
  const alignVersion = getScriptVersion(ALIGN_SCRIPT);
  const alignLocalOk = await checkScriptVersion(conn, ALIGN_LOCAL_PATH, alignVersion);
  let alignOk = false;

  if (alignLocalOk) {
    // Local version is correct - nothing to do
    alignOk = true;
  } else {
    // Local missing or wrong version - check archive before redeploying
    const alignArchiveOk = await checkScriptVersion(conn, ALIGN_ARCHIVE_PATH, alignVersion);

    if (alignArchiveOk) {
      // Archive has correct version, just need to copy to local
      try {
        await conn.raw(`COPYPATH("${ALIGN_ARCHIVE_PATH}", "${ALIGN_LOCAL_PATH}").`, 3000);

        // Verify copy succeeded
        const verifyResult = await conn.queue(`PRINT EXISTS("${ALIGN_LOCAL_PATH}").`, 3000);
        if (verifyResult.success && verifyResult.output.includes('True')) {
          console.error(`[deploy] Copied align script to local`);
        } else {
          console.error(`[deploy] Failed to copy align script to local`);
        }
        alignOk = true; // Archive still works even if local copy failed
      } catch (err) {
        console.error(`[deploy] Failed to copy align script to local: ${err}`);
        alignOk = true; // Archive still works
      }
    } else {
      // Archive missing or outdated - full redeploy needed
      console.error(`[deploy] Deploying align script (need: ${alignVersion})`);
      const alignResult = await deployKosScript(conn, ALIGN_SCRIPT, ALIGN_ARCHIVE_PATH, ALIGN_LOCAL_PATH);
      alignOk = alignResult.success;
      if (!alignResult.success) {
        console.error(`[deploy] Failed to deploy align script: ${alignResult.error}`);
      }
    }
  }

  // Cache result if both scripts are OK
  if (statusOk && alignOk) {
    scriptsVerified = true;
  }

  return { status: statusOk, align: alignOk };
}

// Re-export for external use
export { getScriptVersion } from './kos-scripts.js';
export { getKspRoot, getArchivePath } from './kos-archive.js';
