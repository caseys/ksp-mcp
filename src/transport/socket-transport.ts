/**
 * Transport implementation using Node.js net.Socket for direct TCP connection.
 *
 * ADVANTAGES:
 * - No external binaries required (no telnet, nc, etc.)
 * - Works cross-platform (macOS, Windows, Linux)
 * - Event-driven output
 * - Pure JavaScript - no native module compilation needed
 *
 * This is now the recommended transport for most use cases.
 */

import * as net from 'node:net';
import { BaseTransport } from './transport.js';
import { config } from '../config/index.js';
import { TransportTraceLogger } from './trace-logger.js';

export class SocketTransport extends BaseTransport {
  private host: string;
  private port: number;
  private socket: net.Socket | null = null;
  private outputBuffer: string = '';
  private connectTimeout: number;
  private trace: TransportTraceLogger;

  constructor(
    host: string = config.kos.host,
    port: number = config.kos.port,
    options: { connectTimeout?: number } = {}
  ) {
    super();
    this.host = host;
    this.port = port;
    this.connectTimeout = options.connectTimeout ?? config.timeouts.connect;
    this.trace = new TransportTraceLogger(`socket-${host}-${port}`);
  }

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.socket) {
          this.socket.destroy();
          this.socket = null;
        }
        reject(new Error(`Connection timeout after ${this.connectTimeout}ms`));
      }, this.connectTimeout);

      this.socket = new net.Socket();
      this.trace.logInfo(`connecting to ${this.host}:${this.port}`);

      this.socket.on('connect', () => {
        clearTimeout(timeout);
        this._isOpen = true;
        // Enable TCP keepalive to prevent connection death during long operations
        // Send keepalive probes every 30 seconds
        this.socket!.setKeepAlive(true, 30_000);
        // Clear any stale data in buffer from previous sessions
        this.outputBuffer = '';
        // Resolve immediately - event-driven waitFor will detect when data arrives
        resolve();
      });

      this.socket.on('data', (data: Buffer) => {
        // kOS sends UTF-8 text
        this.outputBuffer += data.toString('utf-8');
        this.trace.logReceive(data);
      });

      this.socket.on('error', (err: Error) => {
        clearTimeout(timeout);
        this._isOpen = false;
        this.trace.logError(err);
        reject(new Error(`Socket error: ${err.message}`));
      });

      this.socket.on('close', () => {
        this._isOpen = false;
        this.trace.logInfo('socket closed');
      });

      this.socket.on('end', () => {
        this._isOpen = false;
        this.trace.logInfo('socket ended');
      });

      this.socket.connect(this.port, this.host);
    });
  }

  async send(data: string, clear: boolean = false): Promise<void> {
    if (!this.socket || !this._isOpen) {
      throw new Error('Transport not initialized');
    }

    // If clear requested, send Ctrl+C first and wait for daemon to stop
    if (clear) {
      await new Promise<void>((resolve, reject) => {
        this.trace.logSend('\u0003');
        this.socket!.write('\u0003', 'utf-8', (err) => {
          if (err) reject(new Error(`Send Ctrl+C error: ${err.message}`));
          else resolve();
        });
      });
      // Wait for daemon to process Ctrl+C and exit
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    return new Promise((resolve, reject) => {
      const payload = data + '\r\n';
      this.trace.logSend(payload);
      this.socket!.write(payload, 'utf-8', (err) => {
        if (err) {
          reject(new Error(`Send error: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  async sendKeys(keys: string): Promise<void> {
    if (!this.socket || !this._isOpen) {
      throw new Error('Transport not initialized');
    }

    // Convert common key names to actual bytes
    const keyMap: { [key: string]: string } = {
      'C-c': '\u0003',  // Ctrl+C
      'C-d': '\u0004',  // Ctrl+D
      'C-z': '\u001A',  // Ctrl+Z
      'Enter': '\r\n',
      'Escape': '\u001B',
    };

    const bytes = keyMap[keys] ?? keys;

    return new Promise((resolve, reject) => {
      this.trace.logSend(bytes);
      this.socket!.write(bytes, 'utf-8', (err) => {
        if (err) {
          reject(new Error(`SendKeys error: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  async readRaw(): Promise<string> {
    // Check if socket is still open - throw if connection died
    if (!this._isOpen) {
      throw new Error('Socket connection closed');
    }
    // Return accumulated output and clear buffer
    const output = this.outputBuffer;
    this.outputBuffer = '';
    return output;
  }

  /**
   * Event-driven waitFor - resolves immediately when pattern found.
   * No polling delays - listens for socket data events directly.
   */
  override async waitFor(pattern: string | RegExp, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this._isOpen) {
        reject(new Error('Socket not connected'));
        return;
      }

      const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error(`Timeout waiting for pattern: ${pattern}`));
        }
      }, timeoutMs);

      const checkBuffer = () => {
        if (resolved) return;
        if (regex.test(this.outputBuffer)) {
          resolved = true;
          cleanup();
          const output = this.outputBuffer;
          this.outputBuffer = '';
          resolve(output);
        }
      };

      const onData = () => {
        checkBuffer();
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.socket?.off('data', onData);
      };

      // Check if pattern already in buffer
      checkBuffer();

      // Listen for new data events
      if (!resolved) {
        this.socket.on('data', onData);
      }
    });
  }

  /**
   * Read all available output without clearing the buffer
   */
  peekBuffer(): string {
    return this.outputBuffer;
  }

  /**
   * Clear the output buffer
   */
  clearBuffer(): void {
    this.outputBuffer = '';
  }

  /**
   * Flush any stale data from the buffer.
   * Waits briefly for any in-flight data to arrive, then clears the buffer.
   * Use before critical queries to ensure clean state.
   */
  async flushStaleData(waitMs: number = 50): Promise<void> {
    await this.delay(waitMs);
    const staleData = this.outputBuffer;
    this.outputBuffer = '';
    if (staleData.length > 0) {
      this.trace.logInfo(`flushed ${staleData.length} bytes of stale data`);
    }
  }

  async close(): Promise<void> {
    if (this.socket) {
      // Try graceful disconnect
      try {
        this.socket.write('\u0004');  // Ctrl+D
        await this.delay(100);
      } catch {
        // Ignore errors during cleanup
      }

      this.socket.destroy();
      this.socket = null;
    }
    this._isOpen = false;
    this.outputBuffer = '';
    this.trace.logInfo('transport closed');
    this.trace.close();
  }

  /**
   * Get socket info for debugging
   */
  getSocketInfo(): { localAddress?: string; localPort?: number; remoteAddress?: string; remotePort?: number } | null {
    if (!this.socket) return null;
    return {
      localAddress: this.socket.localAddress,
      localPort: this.socket.localPort,
      remoteAddress: this.socket.remoteAddress,
      remotePort: this.socket.remotePort,
    };
  }
}
