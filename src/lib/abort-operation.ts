/**
 * Abort Operation Tool
 *
 * Cancels the currently running operation.
 */

import type { ToolDefinition } from './tool-types.js';
import { getActiveOperation, clearActiveOperation } from '../utils/operation-state.js';

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
  tier: 3,
  handler: async (_args, context) => {
    const activeOp = getActiveOperation();
    if (!activeOp) {
      return context.successResponse('Abort', 'No operation is currently running.');
    }

    const toolName = activeOp.toolName;
    const duration = Math.round((Date.now() - activeOp.startedAt) / 1000);

    clearActiveOperation();

    return context.successResponse('Abort',
      `Aborted ${toolName} after ${duration}s. Note: KSP may still be executing - use SAS or manual control.`
    );
  },
};
