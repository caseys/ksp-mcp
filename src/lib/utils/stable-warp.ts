/**
 * Stable-State Warp Tracker
 *
 * Monitors state stability and triggers time warp when stable.
 * Used by ascent and execute_node to enable warp during coast phases.
 */

import type { KosConnection } from '../../transport/kos-connection.js';
import type { McpLogger } from '../tool-types.js';

/**
 * Tracks state stability and triggers warp when stable.
 * If state is unchanged for N consecutive samples, enables 2x warp.
 */
export class StableWarpTracker {
  private lastState: string | null = null;
  private stableCount = 0;
  private hasWarped = false;

  constructor(
    private conn: KosConnection,
    private logger: McpLogger,
    private samplesRequired = 2,
    private context = 'Warp'
  ) {}

  /**
   * Check state and trigger warp if stable.
   * @param state Current state as string (for equality comparison)
   * @returns true if warp was triggered this call
   */
  async check(state: string): Promise<boolean> {
    if (this.hasWarped) return false;

    if (this.lastState === state) {
      this.stableCount++;
      if (this.stableCount >= this.samplesRequired) {
        try {
          await this.conn.execute('SET WARP TO 1.'); // 2x warp
          this.logger.info(`[${this.context}] Stable state - enabled 2x warp`);
        } catch {
          // Ignore warp errors - non-critical
        }
        this.hasWarped = true;
        return true;
      }
    } else {
      this.stableCount = 0;
    }
    this.lastState = state;
    return false;
  }

  /** Reset tracker (e.g., when state should change) */
  reset(): void {
    this.hasWarped = false;
    this.stableCount = 0;
    this.lastState = null;
  }
}
