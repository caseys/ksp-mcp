/**
 * kOS Script Deployment
 *
 * Handles deploying kOS scripts from src/lib/kos/script/ to the game.
 * Scripts are read from source, versioned by content hash, and deployed
 * to both archive (0:/) and local volume (1:/) for blackout resilience.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KosConnection } from '../transport/kos-connection.js';
import { deployScript } from './kos-archive.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Path to kOS script source files
// From dist/utils/ go to project root, then src/lib/kos/script/
const SCRIPTS_DIR = join(__dirname, '..', '..', 'src', 'lib', 'kos', 'script');

// Cache for script content and versions
const scriptCache = new Map<string, { content: string; version: string }>();

/**
 * Get script content and version hash.
 * Prepends version comment to content for easy version checking.
 * Replaces __VERSION__ placeholder with computed hash (for scripts that embed version).
 * Caches result for performance.
 */
export function getScript(name: string): { content: string; version: string } {
  if (scriptCache.has(name)) {
    return scriptCache.get(name)!;
  }

  const filePath = join(SCRIPTS_DIR, name);
  const rawContent = readFileSync(filePath, 'utf-8');
  // Hash the raw content (before adding version comment or replacing placeholder)
  const version = createHash('md5').update(rawContent).digest('hex').slice(0, 8);
  // Replace __VERSION__ placeholder with computed hash (if present)
  const contentWithVersion = rawContent.replaceAll('__VERSION__', version);
  // Prepend version comment for easy checking via file read
  const content = `// version: ${version}\n${contentWithVersion}`;

  const result = { content, version };
  scriptCache.set(name, result);
  return result;
}

/**
 * Get just the version hash for a script.
 * Convenience wrapper around getScript().
 */
export function getScriptVersion(name: string): string {
  return getScript(name).version;
}

/**
 * Deploy a kOS script to the archive and optionally local volume.
 *
 * @param conn - kOS connection
 * @param scriptName - Name of script file (e.g., 'mcp-align.ks')
 * @param archivePath - Destination path in archive (e.g., '0:/mcp_align.ks')
 * @param localPath - Optional local volume path (e.g., '1:/mcp_align.ks')
 */
export async function deployKosScript(
  conn: KosConnection,
  scriptName: string,
  archivePath: string,
  localPath?: string
): Promise<{ success: boolean; version: string; error?: string }> {
  try {
    const { content, version } = getScript(scriptName);

    // Deploy to archive
    const result = await deployScript(conn, archivePath, content);
    if (!result.success) {
      return { success: false, version, error: result.error };
    }

    // Copy to local volume if specified
    if (localPath) {
      try {
        // Ensure directory exists
        const localDir = localPath.slice(0, localPath.lastIndexOf('/'));
        if (localDir && localDir !== '1:') {
          await conn.raw(`IF NOT EXISTS("${localDir}") { CREATEDIR("${localDir}"). }`, 3000);
        }
        // Copy from archive to local
        await conn.raw(`COPYPATH("${archivePath}", "${localPath}").`, 3000);

        // Verify local copy exists
        const verifyResult = await conn.queue(`PRINT EXISTS("${localPath}").`, 3000);
        if (!verifyResult.success || !verifyResult.output.includes('True')) {
          console.error(`[kos-scripts] COPYPATH to ${localPath} failed - file not found after copy`);
        } else {
          console.error(`[kos-scripts] Copied ${scriptName} to ${localPath}`);
        }
      } catch (err) {
        // Non-fatal - archive copy still works
        console.error(`[kos-scripts] Failed to copy ${scriptName} to local volume: ${err}`);
      }
    }

    return { success: true, version };
  } catch (error) {
    return {
      success: false,
      version: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// Script-specific helpers
// ============================================================================

const ALIGN_SCRIPT = 'mcp-align.ks';
const ALIGN_ARCHIVE_PATH = '0:/mcp_align.ks';
const ALIGN_LOCAL_PATH = '1:/mcp_align.ks';

/**
 * Ensure the align script is deployed and available.
 * Returns the path to use (prefers local for blackout resilience).
 */
export async function ensureAlignScript(conn: KosConnection): Promise<string> {
  // Check if local version exists
  try {
    const localCheck = await conn.queue(`PRINT EXISTS("${ALIGN_LOCAL_PATH}").`, 2000);
    if (localCheck.success && localCheck.output.includes('True')) {
      return ALIGN_LOCAL_PATH;
    }
  } catch {
    // Continue to deployment
  }

  // Deploy script
  const { version } = getScript(ALIGN_SCRIPT);
  console.error(`[kos-scripts] Deploying align script v${version}`);
  const result = await deployKosScript(conn, ALIGN_SCRIPT, ALIGN_ARCHIVE_PATH, ALIGN_LOCAL_PATH);

  if (!result.success) {
    console.error(`[kos-scripts] Failed to deploy align script: ${result.error}`);
    return ALIGN_ARCHIVE_PATH;
  }

  return ALIGN_LOCAL_PATH;
}

/**
 * Run the align script and return the result.
 *
 * @param conn - kOS connection
 * @param rcsMode - RCS mode (0-3)
 * @param useSas - Whether to try SAS MANEUVER first
 * @returns Alignment result with method used and final error angle
 */
export async function runAlignScript(
  conn: KosConnection,
  rcsMode = 0,
  useSas = true
): Promise<{ success: boolean; method: 'SAS' | 'KOS'; errorAngle: number; output: string }> {
  const scriptPath = await ensureAlignScript(conn);

  // Run the script with parameters (version checking is done via file header)
  // Uses queue() because we need to parse ALIGN_COMPLETE output
  const sasParam = useSas ? 'TRUE' : 'FALSE';
  const result = await conn.queue(
    `RUNPATH("${scriptPath}", ${rcsMode}, ${sasParam}).`,
    30_000 // 30 second timeout for alignment
  );

  // Parse result: ALIGN_COMPLETE:<method>:<error>
  const match = result.output.match(/ALIGN_COMPLETE:(\w+):([\d.]+)/);
  if (match) {
    const method = match[1] as 'SAS' | 'KOS';
    const errorAngle = parseFloat(match[2]);

    return {
      success: true,
      method,
      errorAngle,
      output: result.output,
    };
  }

  // Check for partial success (script ran but no result line)
  if (result.output.includes('ALIGN:')) {
    return {
      success: false,
      method: 'KOS',
      errorAngle: -1,
      output: result.output,
    };
  }

  // No align output at all
  console.error('[kos-scripts] No align output');
  return {
    success: false,
    method: 'KOS',
    errorAngle: -1,
    output: result.output,
  };
}
