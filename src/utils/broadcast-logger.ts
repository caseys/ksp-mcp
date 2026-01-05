/**
 * Broadcast Logger
 *
 * Allows multiple MCP clients to subscribe to notifications from a running operation.
 * The original client's logger is wrapped in a broadcast logger that can have
 * additional subscribers added later via the continue_operation tool.
 */

import type { McpLogger } from '../lib/tool-types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';

type LogLevel = 'info' | 'warning' | 'error' | 'debug';

interface Subscriber {
  id: string;
  sendNotification: (notification: ServerNotification) => Promise<void>;
}

/**
 * A logger that broadcasts to multiple subscribers.
 * Implements McpLogger interface so it can be used anywhere a logger is expected.
 */
export class BroadcastLogger implements McpLogger {
  private subscribers: Map<string, Subscriber> = new Map();
  private subscriberCounter = 0;

  /**
   * Add a subscriber to receive notifications.
   * Returns a subscriber ID that can be used to remove the subscriber later.
   *
   * Auto-removes on client disconnect via AbortSignal if available.
   */
  addSubscriber(
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>
  ): string {
    const id = `sub-${++this.subscriberCounter}`;

    const subscriber: Subscriber = {
      id,
      sendNotification: extra.sendNotification.bind(extra),
    };

    this.subscribers.set(id, subscriber);

    // Auto-remove on client disconnect
    if (extra.signal) {
      extra.signal.addEventListener('abort', () => {
        this.subscribers.delete(id);
      }, { once: true });
    }

    return id;
  }

  /**
   * Remove a subscriber by ID.
   */
  removeSubscriber(id: string): void {
    this.subscribers.delete(id);
  }

  /**
   * Get the number of active subscribers.
   */
  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * Broadcast a message to all subscribers.
   */
  private broadcast(level: LogLevel, message: string): void {
    for (const subscriber of this.subscribers.values()) {
      subscriber.sendNotification({
        method: 'notifications/message',
        params: { level, logger: 'ksp-mcp', data: message },
      }).catch(() => {
        // Fire and forget - subscriber may have disconnected
      });
    }
  }

  // McpLogger implementation - broadcast to all subscribers
  info(message: string): void {
    this.broadcast('info', message);
  }

  warn(message: string): void {
    this.broadcast('warning', message);
  }

  error(message: string): void {
    this.broadcast('error', message);
  }

  progress(message: string): void {
    // Progress uses info level for broadcast (progressToken is per-request)
    this.broadcast('info', message);
  }

  /**
   * Clear all subscribers.
   */
  clear(): void {
    this.subscribers.clear();
  }
}

// Singleton instance for the active operation's broadcast logger
let activeBroadcastLogger: BroadcastLogger | null = null;

/**
 * Create a new broadcast logger and set it as the active one.
 * Returns the logger instance.
 */
export function createBroadcastLogger(): BroadcastLogger {
  activeBroadcastLogger = new BroadcastLogger();
  return activeBroadcastLogger;
}

/**
 * Get the active broadcast logger, if any.
 */
export function getActiveBroadcastLogger(): BroadcastLogger | null {
  return activeBroadcastLogger;
}

/**
 * Clear the active broadcast logger and all its subscribers.
 */
export function clearBroadcastLogger(): void {
  if (activeBroadcastLogger) {
    activeBroadcastLogger.clear();
    activeBroadcastLogger = null;
  }
}

/**
 * Add a subscriber to the active broadcast logger.
 * Returns the subscriber ID, or null if no active logger.
 */
export function addBroadcastSubscriber(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): string | null {
  if (!activeBroadcastLogger) {
    return null;
  }
  return activeBroadcastLogger.addSubscriber(extra);
}
