/**
 * Abort Operation Tool
 *
 * Cancels the currently running operation.
 */

import type { ToolDefinition } from './tool-types.js';
import { getKosOperation, clearKosOperation } from '../utils/kos-operation-state.js';

/**
 * Abort operation tool - cancels the currently running operation.
 */
export const abortOperationTool: ToolDefinition = {
  name: 'abort_operation',
  description: 'Cancel the currently running operation. Use if something goes wrong or you need to stop.',
  inputSchema: {},
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 4,
  handler: async (_args, context) => {
    const conn = context.getConnection();
    if (!conn.isConnected()) {
      return context.successResponse('Abort', 'Not connected - no operation to abort.');
    }

    const activeOp = await getKosOperation(conn);
    if (!activeOp) {
      return context.successResponse('Abort', 'No operation is currently running.');
    }

    const toolName = activeOp.toolName;
    const duration = Math.round(activeOp.duration);

    await clearKosOperation(conn);

    return context.successResponse('Abort',
      `Aborted ${toolName} after ${duration}s. Note: KSP may still be executing - use SAS or manual control.`
    );
  },
};
