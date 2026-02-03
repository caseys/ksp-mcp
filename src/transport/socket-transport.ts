/**
 * Transport implementation using telnet-client for kOS telnet server.
 *
 * Uses telnet-client to handle telnet protocol negotiation (IAC, NAWS)
 * automatically. This ensures the kOS server knows our terminal dimensions
 * (200×60), preventing JSON scroll-off (24-row default) and line-wrapping
 * (80-col default).
 *
 * ADVANTAGES:
 * - Proper telnet NAWS negotiation (terminal size)
 * - Works cross-platform (macOS, Windows, Linux)
 * - Event-driven output
 *
 * NOTE: The library's 'data' event emits raw bytes (including IAC sequences)
 * when negotiationMandatory=false. We strip IAC bytes ourselves before
 * converting to UTF-8 to prevent garbled characters in JSON output.
 */

import { Telnet } from 'telnet-client';
import type { Socket } from 'node:net';
import { appendFileSync, writeFileSync } from 'node:fs';
import { BaseTransport } from './transport.js';
import { config } from '../config/index.js';
import { TransportTraceLogger } from './trace-logger.js';

// Track if we've cleared the debug log this session
let debugLogCleared = false;

export class SocketTransport extends BaseTransport {
  private host: string;
  private port: number;
  private conn: Telnet | null = null;
  private socket: Socket | null = null;
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

  /**
   * Strip telnet IAC (Interpret As Command) sequences from raw socket data.
   * The telnet-client library emits raw bytes on its 'data' event when
   * negotiationMandatory=false. IAC bytes (0xFF) are invalid UTF-8 and
   * corrupt JSON output if not stripped before string conversion.
   *
   * IAC protocol:
   * - IAC IAC (FF FF) → literal 0xFF byte
   * - IAC WILL/WONT/DO/DONT + option (FF FB/FC/FD/FE xx) → 3 bytes, skip
   * - IAC SB ... IAC SE (FF FA ... FF F0) → subnegotiation block, skip
   * - IAC + other command (FF xx) → 2 bytes, skip
   */
  private stripIAC(data: Buffer): Buffer {
    const result: number[] = [];
    let i = 0;

    while (i < data.length) {
      if (data[i] === 0xFF) {
        // IAC byte found
        if (i + 1 >= data.length) {
          // Trailing IAC with no following byte — skip it
          break;
        }

        const cmd = data[i + 1];

        switch (cmd) {
        case 0xFF: {
          // IAC IAC → literal 0xFF
          result.push(0xFF);
          i += 2;
        
        break;
        }
        case 0xFB: 
        case 0xFC: 
        case 0xFD: 
        case 0xFE: {
          // WILL / WONT / DO / DONT + option byte → skip 3 bytes
          i += 3;
        
        break;
        }
        case 0xFA: {
          // SB (subnegotiation begin) — skip until IAC SE (FF F0)
          i += 2;
          while (i < data.length) {
            if (data[i] === 0xFF && i + 1 < data.length && data[i + 1] === 0xF0) {
              i += 2; // skip IAC SE
              break;
            }
            i++;
          }
        
        break;
        }
        default: {
          // Other IAC command → skip 2 bytes
          i += 2;
        }
        }
      } else {
        result.push(data[i]);
        i++;
      }
    }

    return Buffer.from(result);
  }

  /**
   * Simple debug logging to /tmp/kos-terminal.log when KOS_DEBUG=1
   * Use: tail -f /tmp/kos-terminal.log to monitor in real-time
   * Enable via KOS_DEBUG=1 in environment or .env file
   */
  private logDebug(dir: 'TX' | 'RX', data: string): void {
    if (!config.debug.terminalLog) return;

    // Clear log on first write this session
    if (!debugLogCleared) {
      writeFileSync(config.debug.terminalLogPath, `# kOS Terminal Debug Log - ${new Date().toISOString()}\n`);
      debugLogCleared = true;
    }

    const timestamp = new Date().toISOString();
    const escaped = data.replaceAll('\n', String.raw`\n`).replaceAll('\r', String.raw`\r`);
    appendFileSync(config.debug.terminalLogPath, `[${timestamp}] ${dir}: ${escaped}\n`);
  }

  async init(): Promise<void> {
    this.conn = new Telnet();
    this.trace.logInfo(`connecting to ${this.host}:${this.port}`);

    // telnet-client handles NAWS negotiation — sends our terminal size to server.
    // This prevents JSON scroll-off (height) and line-wrapping (width).
    await this.conn.connect({
      host: this.host,
      port: this.port,
      terminalWidth: 200,
      terminalHeight: 60,
      negotiationMandatory: false, // kOS server may not negotiate all options
      shellPrompt: false,          // no prompt detection — we handle that ourselves
      timeout: this.connectTimeout,
      execTimeout: 0,              // no exec timeout — kOS can stall during physics
      irs: '\n',
      ors: '\r\n',
    });

    // Get the underlying socket for raw writes and event listening
    this.socket = this.conn.getSocket();
    if (!this.socket) {
      throw new Error('telnet-client connected but no socket available');
    }

    this._isOpen = true;

    // Disable Nagle's algorithm so each write() flushes immediately.
    // Prevents negotiate responses from merging with CPU selection in same TCP segment.
    this.socket.setNoDelay(true);

    // Enable TCP keepalive to prevent connection death during long operations
    this.socket.setKeepAlive(true, 30_000);

    // Clear any stale data in buffer
    this.outputBuffer = '';

    // Listen for data on the Telnet instance. Strip IAC bytes before
    // converting to UTF-8 — the library emits raw data including IAC
    // sequences when negotiationMandatory=false.
    this.conn.on('data', (data: Buffer | string) => {
      const raw = typeof data === 'string' ? Buffer.from(data) : data;
      const cleaned = this.stripIAC(raw);
      if (cleaned.length > 0) {
        const str = cleaned.toString('utf-8');
        this.outputBuffer += str;
        this.trace.logReceive(cleaned);
        this.logDebug('RX', str);
      }
    });

    // Patch telnet-client's negotiate() to handle SB subnegotiations and
    // prevent negotiation loops. The library always responds to every IAC
    // command without tracking state, causing WILL/DO loops with kOS.
    //
    // Strategy:
    // 1. Let origNegotiate handle the FIRST packet (initial NAWS/TTYPE exchange)
    // 2. Handle SB TERMINAL-TYPE SEND ourselves (library can't parse SB)
    // 3. After initial exchange, just strip IAC and return data (no more responses)
    const origNegotiate = this.conn.negotiate.bind(this.conn);
    const SB_TTYPE_SEND = Buffer.from([0xFF, 0xFA, 0x18, 0x01, 0xFF, 0xF0]);
    let initialNegDone = false;
    // @ts-expect-error -- monkey-patching telnet-client internal to fix SB subnegotiation
    this.conn.negotiate = (chunk: Buffer) => {
      // Always handle SB TERMINAL-TYPE SEND ourselves
      if (chunk.includes(SB_TTYPE_SEND) && this.socket?.writable) {
        // Respond: IAC SB TERMINAL-TYPE IS "xterm" IAC SE
        const response = Buffer.concat([
          Buffer.from([0xFF, 0xFA, 0x18, 0x00]),
          Buffer.from('xterm', 'ascii'),
          Buffer.from([0xFF, 0xF0]),
        ]);
        this.socket!.write(response);
        this.logDebug('TX', '[TTYPE: xterm]');

        // Strip SB TTYPE SEND from chunk
        const idx = chunk.indexOf(SB_TTYPE_SEND);
        const before = chunk.subarray(0, idx);
        const after = chunk.subarray(idx + SB_TTYPE_SEND.length);
        chunk = Buffer.concat([before, after]);
        if (chunk.length === 0) return null;
      }

      // First packet: let origNegotiate handle initial WILL/DO exchange
      if (!initialNegDone) {
        initialNegDone = true;
        if (chunk.length > 0 && chunk[0] === 0xFF) {
          return origNegotiate(chunk);
        }
        return chunk.length > 0 ? chunk : null;
      }

      // After initial exchange: strip IAC commands without responding
      // (kOS sends confirmations that would loop if we respond)
      return this.stripIAC(chunk).length > 0 ? this.stripIAC(chunk) : null;
    };

    this.conn.on('error', (err: Error | string) => {
      this._isOpen = false;
      const error = err instanceof Error ? err : new Error(String(err));
      this.trace.logError(error);
    });

    this.conn.on('close', () => {
      this._isOpen = false;
      this.trace.logInfo('connection closed');
    });

    this.conn.on('end', () => {
      this._isOpen = false;
      this.trace.logInfo('connection ended');
    });
  }

  async send(data: string): Promise<void> {
    if (!this.socket || !this._isOpen) {
      throw new Error('Transport not initialized');
    }

    return new Promise((resolve, reject) => {
      const payload = data + '\r\n';
      this.trace.logSend(payload);
      this.logDebug('TX', data);
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
      'C-k': '\u000B',  // Ctrl+K (clear terminal)
      'C-z': '\u001A',  // Ctrl+Z
      'Enter': '\r\n',
      'Escape': '\u001B',
    };

    const bytes = keyMap[keys] ?? keys;

    return new Promise((resolve, reject) => {
      this.trace.logSend(bytes);
      this.logDebug('TX', `[keys:${keys}]`);
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

      // Register listener on the raw socket for data arrival notifications.
      // Our buffer is filled by the Telnet 'data' event, but we need to know
      // when new data arrives to check the pattern.
      this.socket.on('data', onData);
      checkBuffer();
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
    if (this.conn) {
      try {
        // Try graceful disconnect — send Ctrl+D then end
        if (this.socket?.writable) {
          this.socket.write('\u0004');  // Ctrl+D
          await this.delay(100);
        }
        await this.conn.end();
      } catch {
        // Ignore errors during cleanup
      }

      try {
        await this.conn.destroy();
      } catch {
        // Ignore errors during cleanup
      }

      this.conn = null;
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
