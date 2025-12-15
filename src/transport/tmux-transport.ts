import { exec } from 'child_process';
import { promisify } from 'util';
import { BaseTransport } from './transport.js';
import { config } from '../config.js';
import { TransportTraceLogger } from './trace-logger.js';

const execAsync = promisify(exec);

/**
 * Transport implementation using tmux for terminal management.
 *
 * Uses tmux to:
 * - Create a persistent session for the nc (netcat) connection
 * - Send commands via send-keys
 * - Capture output via capture-pane
 *
 * Requires: tmux, nc (netcat - pre-installed on macOS and most Linux)
 * This handles VT100 terminal emulation implicitly through tmux.
 */
export interface TmuxTransportOptions {
  sendDelayMs?: number;  // Delay after each send to prevent command garbling (default: 100)
}

export class TmuxTransport extends BaseTransport {
  private sessionName: string;
  private paneId: string | null = null;
  private host: string;
  private port: number;
  private lastCaptureLength: number = 0;
  private sendDelayMs: number;
  private trace: TransportTraceLogger;

  constructor(
    host: string = config.kos.host,
    port: number = config.kos.port,
    sessionName: string = config.transport.tmuxSession,
    options?: TmuxTransportOptions
  ) {
    super();
    this.host = host;
    this.port = port;
    this.sessionName = sessionName;
    this.sendDelayMs = options?.sendDelayMs ?? 100;
    this.trace = new TransportTraceLogger(`tmux-${sessionName}`);
  }

  async init(): Promise<void> {
    // Kill any existing session first for a clean start
    await this.killExistingSession();

    // Create new tmux session
    await execAsync(`tmux new-session -d -s ${this.sessionName}`);

    // Get the pane ID
    const { stdout: paneInfo } = await execAsync(
      `tmux list-panes -t ${this.sessionName} -F "#{pane_id}"`
    );
    this.paneId = paneInfo.trim().split('\n')[0];

    // Start TCP connection using nc (netcat)
    await this.send(`nc ${this.host} ${this.port}`);
    this.trace.logInfo(`tmux session ${this.sessionName} connecting to ${this.host}:${this.port}`);

    this._isOpen = true;
  }

  async send(data: string): Promise<void> {
    if (!this.paneId) {
      throw new Error('Transport not initialized');
    }

    // Escape for shell
    const escaped = data.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await execAsync(`tmux send-keys -t ${this.paneId} "${escaped}" Enter`);
    this.trace.logSend(data + '\n');

    // Wait after send to prevent command garbling
    if (this.sendDelayMs > 0) {
      await this.delay(this.sendDelayMs);
    }
  }

  async sendKeys(keys: string): Promise<void> {
    if (!this.paneId) {
      throw new Error('Transport not initialized');
    }

    await execAsync(`tmux send-keys -t ${this.paneId} ${keys}`);
    this.trace.logSend(`[keys] ${keys}`);
  }

  async readRaw(): Promise<string> {
    if (!this.paneId) {
      return '';
    }

    try {
      const { stdout } = await execAsync(
        `tmux capture-pane -t ${this.paneId} -p -S -500`
      );

      // Only return new content since last read
      if (stdout.length > this.lastCaptureLength) {
        const newContent = stdout.slice(this.lastCaptureLength);
        this.lastCaptureLength = stdout.length;
        this.trace.logReceive(newContent);
        return newContent;
      }

      return '';
    } catch {
      return '';
    }
  }

  /**
   * Get full pane content (for debugging or initial state)
   */
  async captureAll(lines: number = 100): Promise<string> {
    if (!this.paneId) {
      return '';
    }

    const { stdout } = await execAsync(
      `tmux capture-pane -t ${this.paneId} -p -S -${lines}`
    );
    return stdout;
  }

  async close(): Promise<void> {
    if (this._isOpen) {
      // Try to cleanly disconnect
      try {
        await this.sendKeys('C-d'); // Ctrl+D to detach from CPU
        await this.delay(300);
      } catch {
        // Ignore errors
      }

      await this.killExistingSession();
    }

    this.paneId = null;
    this._isOpen = false;
    this.lastCaptureLength = 0;
    this.trace.logInfo('tmux transport closed');
    this.trace.close();
  }

  private async killExistingSession(): Promise<void> {
    try {
      await execAsync(`tmux kill-session -t ${this.sessionName} 2>/dev/null`);
    } catch {
      // Session might not exist, ignore
    }
  }

  /**
   * Get session info for debugging
   */
  getSessionInfo(): { sessionName: string; paneId: string | null } {
    return {
      sessionName: this.sessionName,
      paneId: this.paneId,
    };
  }
}
