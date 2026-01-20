/**
 * MCP Logger
 *
 * Provides logging infrastructure for MCP tools. Uses a broadcast logger that
 * allows multiple MCP clients to subscribe to notifications from running operations
 * via the continue_operation tool.
 *
 * Also writes all messages to a log file in logs/ksp-mcp-*.log for debugging.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { McpLogger } from '../lib/tool-types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';

type LogLevel = 'info' | 'warning' | 'error' | 'debug';

// ============================================================================
// File Logger - writes all messages to logs/ksp-mcp-*.log
// ============================================================================

/** Singleton file logger instance */
let fileLogStream: WriteStream | null = null;
let fileLogPath: string | null = null;

/**
 * Initialize file logging. Creates logs directory and opens log file.
 * Called automatically when first logger is created.
 */
function initFileLog(): void {
  if (fileLogStream) return; // Already initialized

  const dir = process.env.KSP_MCP_LOG_DIR ?? join(process.cwd(), 'logs');
  mkdirSync(dir, { recursive: true });

  const timestamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  fileLogPath = join(dir, `ksp-mcp-${timestamp}.log`);
  fileLogStream = createWriteStream(fileLogPath, { flags: 'a' });
  fileLogStream.write(`# ksp-mcp log started ${new Date().toISOString()}\n`);
}

/**
 * Write a message to the log file.
 */
function writeToFile(level: LogLevel | 'progress', message: string): void {
  if (!fileLogStream) return;

  const timestamp = new Date().toISOString();
  const levelTag = level.toUpperCase().padEnd(8);
  fileLogStream.write(`[${timestamp}] ${levelTag} ${message}\n`);
}

/**
 * Close the file log stream.
 * @internal - reserved for future use (graceful shutdown)
 */
function closeFileLog(): void {
  if (fileLogStream) {
    fileLogStream.write(`# ksp-mcp log ended ${new Date().toISOString()}\n`);
    fileLogStream.end();
    fileLogStream = null;
  }
}

// Ensure log is closed on process exit
process.on('exit', closeFileLog);

interface Subscriber {
  id: string;
  sendNotification: (notification: ServerNotification) => Promise<void>;
}

/**
 * A logger that broadcasts to multiple subscribers.
 * Implements McpLogger interface so it can be used anywhere a logger is expected.
 *
 * Also supports progress notifications for the initial client that created the operation.
 */
export class BroadcastLogger implements McpLogger {
  private subscribers: Map<string, Subscriber> = new Map();
  private subscriberCounter = 0;
  // Track initial client for progress notifications
  private initialExtra: RequestHandlerExtra<ServerRequest, ServerNotification> | null = null;
  private progressToken: string | number | undefined;
  private progressCount = 0;

  /**
   * Set the initial client that will receive progress notifications.
   * Must be called before addSubscriber for proper progress token handling.
   */
  setInitialClient(extra: RequestHandlerExtra<ServerRequest, ServerNotification>): void {
    this.initialExtra = extra;
    // Extract progressToken from request metadata (same pattern as createLogger)
    this.progressToken = extra._meta?.progressToken as string | number | undefined;
  }

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

  // McpLogger implementation - broadcast to all subscribers AND write to file
  info(message: string): void {
    writeToFile('info', message);
    this.broadcast('info', message);
  }

  warn(message: string): void {
    writeToFile('warning', message);
    this.broadcast('warning', message);
  }

  error(message: string): void {
    writeToFile('error', message);
    this.broadcast('error', message);
  }

  progress(message: string): void {
    writeToFile('progress', message);

    // Send proper progress notification to initial client (if they support it)
    if (this.progressToken && this.initialExtra) {
      this.progressCount++;
      this.initialExtra.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken: this.progressToken,
          progress: this.progressCount,
          message,
        },
      }).catch(() => {
        // Fire and forget - client may have disconnected
      });
    }

    // Also broadcast as info to all subscribers
    this.broadcast('info', message);
  }

  debug(message: string): void {
    writeToFile('debug', message);
    // Debug messages only go to broadcast subscribers, not progress notifications
    // This keeps mission progress clean while still allowing debug visibility
    this.broadcast('debug', message);
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
function createBroadcastLogger(): BroadcastLogger {
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

/**
 * Create a structured logger from the MCP request handler extra context.
 * Uses a broadcast logger that allows multiple MCP clients to subscribe
 * to notifications from long-running operations via continue_operation.
 *
 * Also initializes file logging to logs/ksp-mcp-*.log on first call.
 *
 * @param extra The RequestHandlerExtra from the tool callback
 * @returns An McpLogger that broadcasts to all subscribers
 */
export function createLogger(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>
): McpLogger {
  // Initialize file logging on first logger creation
  initFileLog();

  // Create the broadcast logger singleton
  const broadcastLogger = createBroadcastLogger();

  // Set initial client for progress notifications (must be before addSubscriber)
  broadcastLogger.setInitialClient(extra);

  // Add the initial client as first subscriber
  broadcastLogger.addSubscriber(extra);

  return broadcastLogger;
}
