/**
 * Shared utilities for progress reporting and timing
 */

/**
 * Helper to send progress notifications.
 * Only sends MCP notification if callback is provided.
 */
export function logProgress(message: string, onProgress?: (msg: string) => void): void {
  onProgress?.(message);
}

/**
 * Promise-based delay utility.
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
