/**
 * Singleton for tracking active long-running operations.
 *
 * Safety features:
 * - Auto-clear after 20 minutes (no operation should take that long)
 * - Simple clear function for use in finally blocks
 * - Getter auto-cleans stale state
 *
 * Operation types help status tool query the right MechJeb autopilot:
 * - 'ascent': Check ADDONS:MJ:ASCENT:ENABLED/STATUS
 * - 'landing': Check ADDONS:MJ:LANDING:ENABLED/STATUS
 * - 'node': Check ADDONS:MJ:NODE:ENABLED/STATE
 * - 'maneuver': Generic maneuver (check for nodes)
 */

export type OperationType = 'ascent' | 'landing' | 'node' | 'maneuver' | 'other';

export interface ActiveOperation {
  toolName: string;
  startedAt: number;
  description?: string;
  /** Type of operation - helps status query the right MechJeb module */
  operationType: OperationType;
  /** Target altitude/orbit for ascent, target body for transfers, etc. */
  target?: string;
}

const STALE_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

let activeOperation: ActiveOperation | null = null;


/**
 * Clear the active operation.
 * Call in finally blocks to ensure cleanup on completion or error.
 */
export function clearActiveOperation(): void {
  activeOperation = null;
}

/**
 * Get the currently active operation, if any.
 * Auto-clears stale operations (>20 min).
 */
export function getActiveOperation(): ActiveOperation | null {
  if (activeOperation && Date.now() - activeOperation.startedAt > STALE_TIMEOUT_MS) {
    activeOperation = null;
  }
  return activeOperation;
}

/**
 * Get a formatted status string for the active operation.
 * Returns empty string if no operation is active.
 */
export function formatActiveOperationStatus(): string {
  const op = getActiveOperation();
  if (!op) return '';

  const duration = Math.round((Date.now() - op.startedAt) / 1000);
  const lines = [
    '=== Active Operation ===',
    `Tool: ${op.toolName}`,
    `Running for: ${duration}s`,
  ];
  if (op.description) {
    lines.push(op.description);
  }
  return '\n' + lines.join('\n');
}
