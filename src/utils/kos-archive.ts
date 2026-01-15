/**
 * kOS Archive Direct Access
 *
 * Provides fast file deployment by writing directly to the kOS archive directory
 * on disk, bypassing the slow line-by-line terminal transfer.
 *
 * Uses ADDONS:MJ:KSPROOT to locate the KSP installation, then writes to
 * Ships/Script/ which is the kOS archive (volume 0:/).
 *
 * Falls back to terminal transfer if direct access is unavailable.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { KosConnection } from '../transport/kos-connection.js';

// Cached KSP root path (discovered once per session)
let cachedKspRoot: string | null = null;
let kspRootChecked = false;

/**
 * Get the KSP installation root path.
 * Queries ADDONS:MJ:KSPROOT from kOS and caches the result.
 * Returns null if unavailable (addon not installed or error).
 */
export async function getKspRoot(conn: KosConnection): Promise<string | null> {
  if (kspRootChecked) {
    return cachedKspRoot;
  }

  try {
    const result = await conn.execute('PRINT "KSPROOT|" + ADDONS:MJ:KSPROOT.', 5000);
    const match = result.output.match(/KSPROOT\|(.+)/);
    if (match) {
      const root = match[1].trim();
      // Validate path exists
      if (existsSync(root)) {
        cachedKspRoot = root;
      }
    }
  } catch {
    // ADDONS:MJ:KSPROOT not available
  }

  kspRootChecked = true;
  return cachedKspRoot;
}

/**
 * Get the kOS archive directory path.
 * Returns null if KSP root is unavailable.
 */
export async function getArchivePath(conn: KosConnection): Promise<string | null> {
  const kspRoot = await getKspRoot(conn);
  if (!kspRoot) return null;

  const archivePath = join(kspRoot, 'Ships', 'Script');

  // Validate archive directory exists
  if (!existsSync(archivePath)) {
    return null;
  }

  return archivePath;
}

/**
 * Write a file directly to the kOS archive.
 *
 * @param conn - kOS connection (for discovering KSP root)
 * @param kosPath - kOS path like "boot/mcp_blackout_warp.ks" or "mcp_daemon.ks" (no 0:/ prefix)
 * @param content - File content to write
 * @returns true if direct write succeeded, false if fallback needed
 */
export async function writeToArchive(
  conn: KosConnection,
  kosPath: string,
  content: string
): Promise<boolean> {
  try {
    const archivePath = await getArchivePath(conn);
    if (!archivePath) {
      return false;
    }

    // Build full filesystem path
    // kosPath should be like "boot/mcp_blackout_warp.ks" or "mcp_daemon.ks"
    const fullPath = join(archivePath, kosPath);

    // Ensure parent directory exists
    const parentDir = dirname(fullPath);
    if (!existsSync(parentDir)) {
      await mkdir(parentDir, { recursive: true });
    }

    // Write file directly
    await writeFile(fullPath, content, 'utf-8');

    return true;
  } catch {
    return false;
  }
}

/**
 * Deploy a script to the kOS archive and optionally copy to vessel.
 *
 * Fast path: Write directly to disk, then use COPYPATH in kOS.
 * Slow path: Fall back to line-by-line LOG if direct write fails.
 *
 * @param conn - kOS connection
 * @param kosPath - Destination path in kOS (e.g., "0:/boot/mcp_blackout_warp.ks")
 * @param content - Script content
 * @returns DeployResult with success/error
 */
export async function deployScript(
  conn: KosConnection,
  kosPath: string,
  content: string
): Promise<{ success: boolean; method: 'direct' | 'terminal'; error?: string }> {
  // Strip 0:/ prefix for archive path
  const archiveRelPath = kosPath.replace(/^0:\//, '');

  // Try direct write first
  // IMPORTANT: Delete existing file in kOS first to invalidate cache
  // kOS caches file content, so writing to disk doesn't update kOS's view
  try {
    await conn.execute(`IF EXISTS("${kosPath}") { DELETEPATH("${kosPath}"). }`, 3000);
  } catch {
    // Ignore delete errors - file may not exist yet
  }

  const directSuccess = await writeToArchive(conn, archiveRelPath, content);

  if (directSuccess) {
    // File is now in archive - verify kOS can see it (should re-read from disk after delete)
    try {
      const checkResult = await conn.execute(`PRINT EXISTS("${kosPath}").`, 3000);
      if (checkResult.output.includes('True')) {
        return { success: true, method: 'direct' };
      }
      // File written but kOS can't see it - fall through to terminal method
    } catch {
      // Fall through to terminal method
    }
  }

  // Fall back to terminal transfer (slow but reliable)
  try {
    // Ensure parent directory exists
    const parentPath = kosPath.slice(0, Math.max(0, kosPath.lastIndexOf('/')));
    if (parentPath && parentPath !== '0:') {
      await conn.execute(`IF NOT EXISTS("${parentPath}") { CREATEDIR("${parentPath}"). }`, 5000);
    }

    // Clear existing file
    await conn.execute(`IF EXISTS("${kosPath}") { DELETEPATH("${kosPath}"). }`, 3000);

    // Write line by line
    const lines = content.split('\n');
    for (const line of lines) {
      const escaped = line.replaceAll('\\', '\\\\').replaceAll('"', '""');
      await conn.execute(`LOG "${escaped}" TO "${kosPath}".`, 2000);
    }

    return { success: true, method: 'terminal' };
  } catch (error) {
    return {
      success: false,
      method: 'terminal',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

