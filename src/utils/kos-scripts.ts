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


// Note: Script-specific helpers removed - alignment is now done inline from TypeScript
// See src/lib/mechjeb/execute-node.ts runAlignScript()
