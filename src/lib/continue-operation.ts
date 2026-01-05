/**
 * Continue Operation Tool
 *
 * Allows a second MCP client to subscribe to an already-running operation's
 * notifications. Returns immediately with operation status while notifications
 * continue flowing to the subscribed client.
 */

import type { ToolDefinition } from './tool-types.js';
import { getKosOperation } from '../utils/kos-operation-state.js';
import { addBroadcastSubscriber, getActiveBroadcastLogger } from '../utils/broadcast-logger.js';

/**
 * Continue operation tool - subscribe to notifications from a running operation.
 */
export const continueOperationTool: ToolDefinition = {
  name: 'continue_operation',
  description: 'Subscribe to notifications from a running operation. Returns operation status immediately while notifications continue flowing.',
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  tier: 3,
  handler: async (_args, context, extra) => {
    const conn = context.getConnection();
    if (!conn) {
      return context.successResponse('continue_operation',
        'Not connected - no operation to continue.');
    }

    const activeOp = await getKosOperation(conn);

    if (!activeOp) {
      return context.successResponse('continue_operation',
        'No operation is currently running.');
    }

    const broadcastLogger = getActiveBroadcastLogger();

    if (!broadcastLogger) {
      // Operation exists but doesn't support broadcast (shouldn't happen with new code)
      const duration = Math.round(activeOp.duration);
      return context.successResponse('continue_operation',
        `${activeOp.toolName} is running (${duration}s) but does not support broadcast notifications.\n` +
        `Use status tool to check progress, or abort_operation to cancel.`);
    }

    // Subscribe this client to the broadcast
    const subscriberId = addBroadcastSubscriber(extra);

    if (!subscriberId) {
      return context.errorResponse('continue_operation',
        'Failed to subscribe to broadcast logger.');
    }

    const duration = Math.round(activeOp.duration);
    const subscriberCount = broadcastLogger.subscriberCount;

    return context.successResponse('continue_operation',
      `Subscribed to ${activeOp.toolName} (running for ${duration}s).\n` +
      `Target: ${activeOp.target || 'N/A'}\n` +
      `Active subscribers: ${subscriberCount}\n` +
      `You will receive notification updates as they occur.`);
  },
};
