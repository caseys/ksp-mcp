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
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { KosConnection } from '../transport/kos-connection.js';
import { getActiveBroadcastLogger } from './mcp-logger.js';

/**
 * Dual logging helper - logs to both console.error (always) and MCP logger (if available).
 */
function logArchive(level: 'info' | 'warn' | 'error', msg: string): void {
  console.error(msg);
  getActiveBroadcastLogger()?.progress(msg);
}

// Cached paths — only cache non-null results so we retry on failure
let cachedKspRoot: string | null = null;
let cachedArchivePath: string | null = null;

/**
 * Get the KSP installation root path.
 *
 * Priority:
 * 1. KSP_ROOT environment variable (reliable, user-configured)
 * 2. ADDONS:MJ:KSPROOT from kOS (requires dev kOS.MechJeb2.Addon)
 *
 * Returns null if unavailable. Caller decides what to do (fallback to terminal).
 */
export async function getKspRoot(conn: KosConnection): Promise<string | null> {
  if (cachedKspRoot) return cachedKspRoot;

  // Priority 1: Environment variable (most reliable)
  // Check both KSP_PATH (used by rest of codebase) and KSP_ROOT (legacy)
  const envRoot = process.env.KSP_PATH || process.env.KSP_ROOT;
  if (envRoot) {
    if (existsSync(envRoot)) {
      cachedKspRoot = envRoot;
      logArchive('info', `[kos-archive] KSPROOT: ${cachedKspRoot} (source: env var)`);
      return cachedKspRoot;
    }
    // Env var set but path doesn't exist - warn once
    logArchive('warn', `[kos-archive] KSP path "${envRoot}" does not exist`);
  }

  // Priority 2: Query from kOS.MechJeb2.Addon (dev builds only)
  try {
    const result = await conn.queue('PRINT ADDONS:MJ:KSPROOT.', 5000);
    if (result.success) {
      const root = result.output.trim();
      if (root && existsSync(root)) {
        cachedKspRoot = root;
        logArchive('info', `[kos-archive] KSPROOT: ${cachedKspRoot} (source: ADDONS:MJ:KSPROOT)`);
        return cachedKspRoot;
      }
    }
  } catch {
    // Silently ignore - addon may not be installed
  }

  // Neither method worked — don't cache null so we retry next time
  // (CPU may have been busy on first attempt)
  if (!envRoot) {
    logArchive('info',
      '[kos-archive] Direct archive write unavailable. ' +
      'Set KSP_PATH env var for faster script deployment. ' +
      'Using terminal fallback (slower but works).'
    );
  }

  return null;
}

/**
 * Get the kOS archive directory path.
 * Returns null if KSP root is unavailable.
 * Result is cached after first successful lookup.
 */
export async function getArchivePath(conn: KosConnection): Promise<string | null> {
  if (cachedArchivePath) return cachedArchivePath;

  const kspRoot = await getKspRoot(conn);
  if (!kspRoot) return null;

  const archivePath = join(kspRoot, 'Ships', 'Script');

  // Validate archive directory exists — only cache if found
  if (existsSync(archivePath)) {
    cachedArchivePath = archivePath;
  }

  return cachedArchivePath;
}

/**
 * Resolve archive path from env var synchronously (no kOS connection needed).
 * Used for disk-based version checks that don't require kOS terminal.
 */
function resolveArchivePathSync(): string | null {
  const envRoot = process.env.KSP_PATH || process.env.KSP_ROOT;
  if (!envRoot || !existsSync(envRoot)) return null;
  const archivePath = join(envRoot, 'Ships', 'Script');
  if (!existsSync(archivePath)) return null;
  cachedKspRoot = envRoot;
  cachedArchivePath = archivePath;
  return archivePath;
}

/**
 * Read a script's version hash directly from the archive on disk.
 * No kOS connection needed — reads the first line of the file.
 * Returns the version hash or null if not found/readable.
 */
export function readVersionFromArchive(scriptName: string): string | null {
  const archivePath = cachedArchivePath ?? resolveArchivePathSync();
  if (!archivePath) return null;
  const fullPath = join(archivePath, scriptName);
  if (!existsSync(fullPath)) return null;
  try {
    const firstLine = readFileSync(fullPath, 'utf-8').split('\n')[0];
    const match = firstLine.match(/\/\/\s*version:\s*(\w+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Write a file directly to the kOS archive.
 *
 * @param conn - kOS connection (for discovering KSP root)
 * @param kosPath - kOS path like "mcp_status.ks" (no 0:/ prefix)
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
    // kosPath should be like "boot/mcp_status.ks"
    const fullPath = join(archivePath, kosPath);

    // Ensure parent directory exists
    const parentDir = dirname(fullPath);
    if (!existsSync(parentDir)) {
      await mkdir(parentDir, { recursive: true });
    }

    // Write file directly
    logArchive('info', `[kos-archive] Writing to archive: ${fullPath}`);
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
 * @param kosPath - Destination path in kOS (e.g., "0:/mcp_status.ks")
 * @param content - Script content
 * @returns DeployResult with success/error
 */
export async function deployScript(
  conn: KosConnection,
  kosPath: string,
  content: string
): Promise<{ success: boolean; method: 'direct' | 'terminal'; error?: string }> {
  // Direct write only works for archive paths (0:/)
  // Local volume (1:/) requires terminal transfer
  const isArchivePath = kosPath.startsWith('0:/');

  if (isArchivePath) {
    // Strip 0:/ prefix for archive path
    const archiveRelPath = kosPath.replace(/^0:\//, '');

    // Try direct write to disk (bypasses kOS terminal entirely)
    const directSuccess = await writeToArchive(conn, archiveRelPath, content);

    if (directSuccess) {
      logArchive('info', `[kos-archive] Direct write to ${kosPath} succeeded`);
      return { success: true, method: 'direct' };
    } else {
      logArchive('info', `[kos-archive] Direct write to ${kosPath} failed, falling back to terminal`);
    }
  }

  // Fall back to terminal transfer (slow but reliable)
  // Works for both archive (0:/) and local (1:/) paths
  logArchive('info', `[kos-archive] Deploying ${kosPath} via terminal transfer (line-by-line)`);
  try {
    // Ensure parent directory exists
    const parentPath = kosPath.slice(0, Math.max(0, kosPath.lastIndexOf('/')));
    if (parentPath && parentPath !== '0:') {
      await conn.raw(`IF NOT EXISTS("${parentPath}") { CREATEDIR("${parentPath}"). }`, 5000);
    }

    // Clear existing file
    await conn.raw(`IF EXISTS("${kosPath}") { DELETEPATH("${kosPath}"). }`, 3000);

    // Write line by line
    const lines = content.split('\n');
    for (const line of lines) {
      const escaped = line.replaceAll('\\', '\\\\').replaceAll('"', '""');
      await conn.raw(`LOG "${escaped}" TO "${kosPath}".`, 2000);
    }

    logArchive('info', `[kos-archive] Terminal write to ${kosPath} succeeded (${lines.length} lines)`);
    return { success: true, method: 'terminal' };
  } catch (error) {
    return {
      success: false,
      method: 'terminal',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

