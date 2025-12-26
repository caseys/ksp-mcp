/**
 * kOS Script Execution
 *
 * Copies and runs kOS scripts from local filesystem.
 * Scripts are copied to KSP's Ships/Script folder (Archive volume 0:/)
 * and executed via RUNPATH command.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { KosConnection } from '../../transport/kos-connection.js';
import { config } from '../../config/index.js';
import { delay } from '../mechjeb/shared.js';
import { globalKosMonitor } from '../../utils/kos-monitor.js';

/**
 * Helper to log and send progress notifications.
 */
function logProgress(message: string, onProgress?: (msg: string) => void): void {
  console.error(message);
  onProgress?.(message);
}

export interface RunScriptResult {
  success: boolean;
  output: string[];
  error?: string;
  executionTime?: number;
  scriptName: string;
}

interface RunScriptOptions {
  timeout?: number;        // Default: 60000 (60 seconds)
  pollInterval?: number;   // Default: 500ms
  cleanup?: boolean;       // Default: true - delete script after execution
  onProgress?: (message: string) => void;  // Progress callback for MCP notifications
}

// Defaults
const DEFAULT_TIMEOUT_MS = 60_000;     // 60 seconds
const DEFAULT_POLL_MS = 500;          // 500ms
const COMPLETION_MARKER = '__MCP_SCRIPT_COMPLETE__';
const COMPLETION_FLAG = '__MCP_SCRIPT_DONE__';

/**
 * Generate a unique script name to avoid collisions
 */
function generateScriptName(): string {
  const id = Math.random().toString(36).slice(2, 10);
  return `_mcp_run_${id}.ks`;
}

/**
 * Get the full path to KSP's Scripts folder
 */
function getScriptsPath(): string {
  return path.join(config.ksp.path, config.ksp.scriptsFolder);
}

/**
 * Inject completion markers into script content
 */
function injectCompletionMarkers(content: string): string {
  const markers = `
// MCP completion markers (auto-injected)
SET ${COMPLETION_FLAG} TO TRUE.
PRINT "${COMPLETION_MARKER}".
`;
  return content + markers;
}

/**
 * Copy a script to KSP's Archive folder
 */
async function copyScriptToArchive(
  sourcePath: string,
  destName: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Validate source file
    if (!fs.existsSync(sourcePath)) {
      return { success: false, error: `Source file not found: ${sourcePath}` };
    }

    const ext = path.extname(sourcePath).toLowerCase();
    if (ext !== '.ks') {
      return { success: false, error: `Invalid file extension: ${ext} (expected .ks)` };
    }

    // Read source content
    const content = fs.readFileSync(sourcePath, 'utf8');

    // Inject completion markers
    const modifiedContent = injectCompletionMarkers(content);

    // Write to KSP Scripts folder (lowercase filename)
    const scriptsPath = getScriptsPath();
    const destPath = path.join(scriptsPath, destName.toLowerCase());

    // Ensure scripts folder exists
    if (!fs.existsSync(scriptsPath)) {
      return { success: false, error: `KSP Scripts folder not found: ${scriptsPath}. Set KSP_PATH env var.` };
    }

    fs.writeFileSync(destPath, modifiedContent, 'utf-8');

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: `Failed to copy script: ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

/**
 * Delete a script from KSP's Archive folder
 */
function deleteScriptFromArchive(scriptName: string): void {
  try {
    const destPath = path.join(getScriptsPath(), scriptName.toLowerCase());
    if (fs.existsSync(destPath)) {
      fs.unlinkSync(destPath);
    }
  } catch {
    // Best effort cleanup - ignore errors
  }
}

/**
 * Run a kOS script file.
 *
 * Copies the script to KSP's Archive folder, executes it via RUNPATH,
 * and waits for completion while capturing output.
 *
 * @param conn kOS connection
 * @param sourcePath Absolute path to the .ks script file
 * @param options Execution options
 * @returns Result with success status, output, and execution time
 */
export async function runScript(
  conn: KosConnection,
  sourcePath: string,
  options: RunScriptOptions = {}
): Promise<RunScriptResult> {
  const {
    timeout = DEFAULT_TIMEOUT_MS,
    pollInterval = DEFAULT_POLL_MS,
    cleanup = true,
    onProgress,
  } = options;

  const log = (msg: string) => logProgress(msg, onProgress);
  const scriptName = generateScriptName();
  const startTime = Date.now();

  log(`[Script] Running ${path.basename(sourcePath)}...`);

  // Step 1: Copy script to Archive
  const copyResult = await copyScriptToArchive(sourcePath, scriptName);
  if (!copyResult.success) {
    return {
      success: false,
      output: [],
      error: copyResult.error,
      scriptName,
    };
  }

  try {
    // Step 2: Clear monitor and initialize completion flag
    globalKosMonitor.clear();
    await conn.execute(`SET ${COMPLETION_FLAG} TO FALSE.`, 2000);

    // Step 3: Run the script
    const runCmd = `RUNPATH("0:/${scriptName.toLowerCase()}").`;
    const runResult = await conn.execute(runCmd, 5000);

    // Check for immediate syntax errors
    if (runResult.output.includes('Syntax error') || runResult.output.includes('Cannot find')) {
      return {
        success: false,
        output: [runResult.output],
        error: `Script error: ${runResult.output}`,
        scriptName,
        executionTime: Date.now() - startTime,
      };
    }

    // Track the RUNPATH output
    globalKosMonitor.trackLine(runResult.output);

    // Step 4: Poll for completion
    let elapsed = 0;
    let lastLogTime = 0;
    while (elapsed < timeout) {
      await delay(pollInterval);
      elapsed = Date.now() - startTime;

      // Check completion flag
      const checkResult = await conn.execute(`PRINT ${COMPLETION_FLAG}.`, 2000);
      globalKosMonitor.trackLine(checkResult.output);

      if (checkResult.output.includes('True')) {
        // Script completed successfully
        const executionTime = Date.now() - startTime;
        log(`[Script] Completed in ${(executionTime / 1000).toFixed(1)}s`);
        return {
          success: true,
          output: globalKosMonitor.getRecentLines(100),
          scriptName,
          executionTime,
        };
      }

      // Log progress every 5 seconds
      if (elapsed - lastLogTime >= 5000) {
        log(`[Script] Running... (${(elapsed / 1000).toFixed(0)}s elapsed)`);
        lastLogTime = elapsed;
      }

      // Check for errors in monitor
      const status = globalKosMonitor.getStatus();
      if (status.hasErrors && status.lastError && // Check if it's a fatal error (not just a warning)
        (status.lastError.includes('Error:') ||
            status.lastError.includes('Exception') ||
            status.lastError.includes('Program aborted'))) {
          return {
            success: false,
            output: globalKosMonitor.getRecentLines(100),
            error: status.lastError,
            scriptName,
            executionTime: Date.now() - startTime,
          };
        }

      // Check for error loop
      if (status.isLooping) {
        return {
          success: false,
          output: globalKosMonitor.getRecentLines(100),
          error: `Error loop detected: ${status.errorPattern}`,
          scriptName,
          executionTime: Date.now() - startTime,
        };
      }
    }

    // Timeout
    return {
      success: false,
      output: globalKosMonitor.getRecentLines(100),
      error: `Script timeout after ${timeout}ms. Script may still be running or waiting for input.`,
      scriptName,
      executionTime: timeout,
    };

  } finally {
    // Cleanup: delete temp script and clear flag
    if (cleanup) {
      deleteScriptFromArchive(scriptName);
    }

    // Best effort cleanup of completion flag
    try {
      await conn.execute(`UNSET ${COMPLETION_FLAG}.`, 1000);
    } catch {
      // Ignore cleanup errors
    }
  }
}
