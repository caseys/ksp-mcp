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
import { config } from '../config.js';
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
        this.socket!.setKeepAlive(true, 30000);
        // Small delay to let kOS send initial data
        setTimeout(() => resolve(), config.timeouts.connectDelay);
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

  async send(data: string): Promise<void> {
    if (!this.socket || !this._isOpen) {
      throw new Error('Transport not initialized');
    }

    return new Promise((resolve, reject) => {
      // Send with newline (kOS expects \r\n or \n)
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
      'C-c': '\x03',  // Ctrl+C
      'C-d': '\x04',  // Ctrl+D
      'C-z': '\x1a',  // Ctrl+Z
      'Enter': '\r\n',
      'Escape': '\x1b',
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

  async close(): Promise<void> {
    if (this.socket) {
      // Try graceful disconnect
      try {
        this.socket.write('\x04');  // Ctrl+D
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
