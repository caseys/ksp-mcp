/**
 * Workarounds Configuration
 *
 * Controls whether heuristic workarounds for MechJeb/kOS/KSP bugs are enabled.
 * These workarounds improve real-world reliability but may interfere with testing.
 *
 * Default: enabled (true)
 *
 * @example
 * ```typescript
 * import { setWorkaroundsEnabled } from 'ksp-mcp';
 *
 * // Disable workarounds for E2E testing
 * setWorkaroundsEnabled(false);
 * ```
 */

// Global workarounds state (enabled by default)
let workaroundsEnabled = true;

/**
 * Enable or disable workarounds globally.
 *
 * When disabled:
 * - Course correction uses exact input value (no 3x multiplier)
 * - Execute node skips half-burn timing shift
 * - Crash avoidance returns immediately (no-op)
 *
 * @param enabled Whether workarounds should be enabled
 */
export function setWorkaroundsEnabled(enabled: boolean): void {
  workaroundsEnabled = enabled;
}

/**
 * Check if workarounds are currently enabled.
 *
 * @returns true if workarounds are enabled, false otherwise
 */
export function areWorkaroundsEnabled(): boolean {
  return workaroundsEnabled;
}
