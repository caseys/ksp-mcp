/**
 * Transport interface for kOS communication.
 *
 * Implementations:
 * - SocketTransport: Uses Node.js net.Socket for direct TCP (default, recommended)
 * - TmuxTransport: Uses tmux sessions with nc for debugging
 */
export interface Transport {
  /**
   * Initialize the transport (create session, open connection, etc.)
   */
  init(): Promise<void>;

  /**
   * Send a command/line to the remote end
   */
  send(data: string): Promise<void>;

  /**
   * Send raw keystrokes (for special keys like Ctrl+D)
   */
  sendKeys?(keys: string): Promise<void>;

  /**
   * Read available output (non-blocking, returns what's buffered)
   */
  read(): Promise<string>;

  /**
   * Wait for specific pattern to appear in output
   */
  waitFor(pattern: string | RegExp, timeoutMs: number): Promise<string>;

  /**
   * Close the transport
   */
  close(): Promise<void>;

  /**
   * Check if transport is open/active
   */
  isOpen(): boolean;
}

/**
 * Base class with common helper methods
 */
export abstract class BaseTransport implements Transport {
  protected buffer: string = '';
  protected _isOpen: boolean = false;

  abstract init(): Promise<void>;
  abstract send(data: string): Promise<void>;
  abstract readRaw(): Promise<string>;
  abstract close(): Promise<void>;

  sendKeys?(keys: string): Promise<void>;

  async read(): Promise<string> {
    // Append any new data to buffer
    const newData = await this.readRaw();
    this.buffer += newData;

    // Return and clear buffer
    const output = this.buffer;
    this.buffer = '';
    return output;
  }

  async waitFor(pattern: string | RegExp, timeoutMs: number): Promise<string> {
    const start = Date.now();
    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;

    while (Date.now() - start < timeoutMs) {
      // Read new data into buffer
      const newData = await this.readRaw();
      this.buffer += newData;

      // Check if pattern matches
      if (regex.test(this.buffer)) {
        const output = this.buffer;
        this.buffer = '';
        return output;
      }

      await this.delay(100);
    }

    throw new Error(`Timeout waiting for pattern: ${pattern}`);
  }

  isOpen(): boolean {
    return this._isOpen;
  }

  protected delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
