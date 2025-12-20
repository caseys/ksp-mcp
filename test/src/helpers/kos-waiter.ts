/**
 * kOS connection waiting utilities
 *
 * Wait for kOS telnet server to be ready and accessible.
 * Uses ksp-mcp library for all kOS connections.
 */

import {
  ensureConnected,
  isKosReady as kspMcpIsKosReady,
} from 'ksp-mcp';
import { KOS_CPU_LABEL, TIMEOUTS } from '../config.js';

/**
 * Check if kOS telnet is ready
 */
export async function isKosReady(): Promise<boolean> {
  return kspMcpIsKosReady({ cpuLabel: KOS_CPU_LABEL });
}

/**
 * Wait for kOS telnet server to be accessible and ready
 *
 * @param timeoutMs Timeout in milliseconds
 * @param pollIntervalMs Polling interval
 */
export async function waitForKos(
  timeoutMs: number = TIMEOUTS.KOS_READY,
  pollIntervalMs: number = 2000
): Promise<void> {
  console.log(`  Waiting for kOS (via ksp-mcp)...`);

  const startTime = Date.now();

  await ensureConnected({
    cpuLabel: KOS_CPU_LABEL,
    retry: true,
    timeoutMs,
    pollIntervalMs,
    onProgress: (elapsedMs) => {
      const elapsed = Math.floor(elapsedMs / 1000);
      // Status update every 15 seconds
      if (elapsed % 15 === 0 && elapsed > 0) {
        console.log(`  Still waiting... (${elapsed}s elapsed)`);
      }
    },
  });

  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  console.log(`  kOS is ready (${elapsed}s)`);
}

/**
 * Wait for kOS connection to be fully ready
 *
 * Combines port check with a test command to ensure kOS is responsive.
 */
export async function waitForKosReady(
  timeoutMs: number = TIMEOUTS.KOS_READY
): Promise<void> {
  await waitForKos(timeoutMs);
  console.log('  kOS is ready');
}

/**
 * Simple delay helper
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { delay };
