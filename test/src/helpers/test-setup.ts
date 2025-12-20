/**
 * Jest test setup
 *
 * Provides shared kOS connection and MechJeb program instances for tests.
 */

// Override console.log to bypass Jest's wrapper (writes to stdout without file/line decoration)
// Keep console.error untouched so stack traces still include file references
const originalLog = console.log;
console.log = (...args: unknown[]) => {
  process.stdout.write(args.map(a => String(a)).join(' ') + '\n');
};

import { ensureConnected, setWorkaroundsEnabled } from 'ksp-mcp';
import type { KosConnection } from 'ksp-mcp/transport';
import { ManeuverOrchestrator, AscentProgram } from 'ksp-mcp/mechjeb';
import { KOS_CPU_LABEL, TIMEOUTS, SAVES, LAST_TEST_FILE, WORKAROUNDS_ENABLED } from '../config.js';

// Configure ksp-mcp workarounds based on env var (default: enabled)
setWorkaroundsEnabled(WORKAROUNDS_ENABLED);
if (!WORKAROUNDS_ENABLED) {
  console.log('  ksp-mcp workarounds DISABLED (WORKAROUNDS_ENABLED=false)');
}
import { initializeKsp, recordLastSave, isKspRunning } from './ksp-launcher.js';
import { validateEnvironment, formatValidationResult } from '../validate-environment.js';
import { writeFileSync, readFileSync, existsSync } from 'fs';

// Shared instances
let conn: KosConnection | null = null;
let maneuver: ManeuverOrchestrator | null = null;
let ascent: AscentProgram | null = null;

// Test state
let currentSave: string | null = null;

/**
 * Get the shared kOS connection (uses ksp-mcp's managed connection)
 */
export async function getTestConnection(): Promise<KosConnection> {
  // Use ksp-mcp's shared connection with our parser fixes
  conn = await ensureConnected({ cpuLabel: KOS_CPU_LABEL });
  return conn;
}

/**
 * Get the maneuver orchestrator (creates if needed)
 */
export async function getManeuverProgram(): Promise<ManeuverOrchestrator> {
  if (!maneuver) {
    const connection = await getTestConnection();
    maneuver = new ManeuverOrchestrator(connection);
  }
  return maneuver;
}

/**
 * Get the ascent program (creates if needed)
 */
export async function getAscentProgram(): Promise<AscentProgram> {
  if (!ascent) {
    const connection = await getTestConnection();
    ascent = new AscentProgram(connection);
  }
  return ascent;
}

/**
 * Record that a test completed successfully (persists to temp file for cross-worker access)
 *
 * Used for chaining logic - e.g., circularize can chain after ascent
 * because the vessel is already in orbit.
 */
export function recordTestSuccess(testName: string): void {
  writeFileSync(LAST_TEST_FILE, testName);
  console.log(`  Recorded successful test: ${testName}`);
}

/**
 * Get the last successful test name (reads from temp file)
 */
export function getLastSuccessfulTest(): string | null {
  try {
    if (existsSync(LAST_TEST_FILE)) {
      return readFileSync(LAST_TEST_FILE, 'utf-8').trim();
    }
  } catch {
    // File doesn't exist or not readable
  }
  return null;
}

/**
 * Ensure KSP is ready with the correct save
 *
 * @param saveName Save file to load
 * @param options.forceRestart Always kill KSP and do fresh launch
 * @param options.forceReload Skip same-save optimization but allow hot reload (for tests that change vessel state)
 * @param options.chainAfter Array of test names - if last successful test matches, skip reload (vessel state is already correct)
 */
export async function ensureKspReady(
  saveName: string,
  options: { forceRestart?: boolean; forceReload?: boolean; chainAfter?: string[] } = {}
): Promise<void> {
  const { chainAfter, ...initOptions } = options;

  // Check for chaining opportunity (uses file-based persistence for cross-worker access)
  const lastTest = getLastSuccessfulTest();
  if (chainAfter && lastTest && chainAfter.includes(lastTest)) {
    // Verify KSP is actually running before skipping initialization
    // (LAST_TEST_FILE persists across Jest runs, so we might see a stale value)
    if (!isKspRunning()) {
      console.log(`  chainAfter matched ${lastTest} but KSP not running - initializing...`);
    } else {
      console.log(`  Chaining after ${lastTest} - skipping save reload`);
      // Update save tracking to match the new save context
      // This allows subsequent tests to use the normal fast-path
      currentSave = saveName;
      recordLastSave(saveName);  // Update temp file so initializeKsp knows
      // Just ensure connection is ready, don't reload
      if (conn && !conn.isConnected()) {
        conn = null;
        maneuver = null;
        ascent = null;
      }
      await getTestConnection();
      return;
    }
  }

  // Initialize KSP (handles save switching and same-save optimization)
  // This establishes the connection via waitForKos()
  await initializeKsp(saveName, initOptions);
  currentSave = saveName;

  // Reset cached instances - they may hold stale connection references
  // The connection itself is managed by ksp-mcp singleton
  conn = null;
  maneuver = null;
  ascent = null;
}

/**
 * Clear ALL existing maneuver nodes
 */
export async function clearNodes(): Promise<void> {
  const connection = await getTestConnection();
  // Remove all nodes, not just NEXTNODE (Hohmann with capture creates multiple nodes)
  await connection.execute('FOR N IN ALLNODES { REMOVE N. }', 5000).catch(() => {});
}

// Jest global setup
beforeAll(async () => {
  // Run environment validation first
  const validation = await validateEnvironment();
  if (!validation.valid) {
    console.error(formatValidationResult(validation));
    console.error('\nSee Tests/E2E/README.md for setup instructions.\n');
    throw new Error('Environment validation failed');
  }

  // Show any warnings or copied assets
  if (validation.warnings.length > 0 || validation.assetsCopied.length > 0) {
    console.log(formatValidationResult(validation));
  }
}, TIMEOUTS.KSP_STARTUP);

// Jest global teardown
afterAll(async () => {
  // Disconnect
  if (conn) {
    await conn.disconnect();
    conn = null;
  }
});

// Export for test files
export {
  conn,
  maneuver,
  ascent,
  currentSave,
  SAVES,
  TIMEOUTS,
};
