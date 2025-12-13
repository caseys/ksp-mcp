/**
 * Execute Maneuver Node - Library implementation
 *
 * Executes the next maneuver node using MechJeb's node executor autopilot.
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { delay, parseNumber, queryNumber, queryTime } from '../shared.js';

export interface ExecuteNodeResult {
  success: boolean;
  nodesExecuted: number;
  error?: string;
}

export interface ExecuteNodeProgress {
  nodesRemaining: number;
  etaToNode: number;
  throttle: number;
  executing: boolean;
}

/**
 * Execute the next maneuver node using MechJeb autopilot.
 *
 * @param conn kOS connection
 * @param timeoutMs Maximum time to wait for node execution (default: 4 minutes)
 * @param pollIntervalMs How often to check progress (default: 2 seconds)
 * @returns ExecuteNodeResult with success status
 */
export async function executeNode(
  conn: KosConnection,
  timeoutMs = 240000,
  pollIntervalMs = 2000
): Promise<ExecuteNodeResult> {
  // Check if a node exists
  const nodeCheck = await conn.execute('PRINT HASNODE.', 2000);
  if (!nodeCheck.output.includes('True')) {
    return { success: false, nodesExecuted: 0, error: 'No maneuver node found' };
  }

  // Get initial node count
  await delay(500);
  const initialCountResult = await conn.execute('PRINT ALLNODES:LENGTH.', 2000);
  const initialNodeCount = parseInt(initialCountResult.output.match(/\d+/)?.[0] || '1');

  // Enable MechJeb node executor
  await delay(500);
  await conn.execute('SET ADDONS:MJ:NODEEXECUTOR:ENABLED TO TRUE.', 5000);

  // Wait for execution with timeout
  const maxIterations = Math.ceil(timeoutMs / pollIntervalMs);
  let lastNodeCount = initialNodeCount;

  for (let i = 0; i < maxIterations; i++) {
    await delay(pollIntervalMs);

    const countResult = await conn.execute('PRINT ALLNODES:LENGTH.', 2000);
    const currentNodes = parseInt(countResult.output.match(/\d+/)?.[0] || '0');

    if (currentNodes === 0) {
      // All nodes executed
      return {
        success: true,
        nodesExecuted: initialNodeCount
      };
    }

    lastNodeCount = currentNodes;
  }

  // Timeout - disable executor
  await conn.execute('SET ADDONS:MJ:NODEEXECUTOR:ENABLED TO FALSE.', 2000);

  return {
    success: false,
    nodesExecuted: initialNodeCount - lastNodeCount,
    error: `Execution timeout after ${timeoutMs / 1000} seconds. ${lastNodeCount} node(s) remaining.`
  };
}

/**
 * Get current node execution progress.
 *
 * @param conn kOS connection
 * @returns ExecuteNodeProgress with current status
 */
export async function getNodeProgress(conn: KosConnection): Promise<ExecuteNodeProgress> {
  const countResult = await conn.execute('PRINT ALLNODES:LENGTH.', 2000);
  const nodesRemaining = parseInt(countResult.output.match(/\d+/)?.[0] || '0');

  if (nodesRemaining === 0) {
    return {
      nodesRemaining: 0,
      etaToNode: 0,
      throttle: 0,
      executing: false
    };
  }

  // Get ETA and throttle
  await delay(500);
  const statusResult = await conn.execute(
    'PRINT "ETA:" + ROUND(NEXTNODE:ETA) + " THR:" + ROUND(THROTTLE * 100).',
    2000
  );

  const etaMatch = statusResult.output.match(/ETA:(\d+)/);
  const thrMatch = statusResult.output.match(/THR:(\d+)/);

  return {
    nodesRemaining,
    etaToNode: etaMatch ? parseInt(etaMatch[1]) : 0,
    throttle: thrMatch ? parseInt(thrMatch[1]) : 0,
    executing: true
  };
}

/**
 * Check if MechJeb node executor is currently enabled.
 *
 * @param conn kOS connection
 * @returns true if executor is enabled
 */
export async function isNodeExecutorEnabled(conn: KosConnection): Promise<boolean> {
  const result = await conn.execute('PRINT ADDONS:MJ:NODEEXECUTOR:ENABLED.', 2000);
  return result.output.includes('True');
}

/**
 * Disable the MechJeb node executor.
 *
 * @param conn kOS connection
 */
export async function disableNodeExecutor(conn: KosConnection): Promise<void> {
  await conn.execute('SET ADDONS:MJ:NODEEXECUTOR:ENABLED TO FALSE.', 2000);
}
