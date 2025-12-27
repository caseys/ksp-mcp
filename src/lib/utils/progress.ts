/**
 * Shared utilities for timing
 */

/**
 * Promise-based delay utility.
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
