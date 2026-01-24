import { Transport } from './transport.js';
import { TmuxTransport } from './tmux-transport.js';
import { SocketTransport } from './socket-transport.js';
import { config } from '../config/index.js';
import { createHash } from 'node:crypto';

export interface ConnectionState {
  connected: boolean;
  cpuId: number | null;
  vesselName: string | null;
  cpuTag: string | null;
  lastError: string | null;
}

export interface CommandResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Internal result from executeRaw() - includes raw output before cleaning
 */
interface RawExecuteResult {
  success: boolean;
  rawOutput: string;
  sentinelToken: string;
  sentinelCommand: string;
  error?: string;
}

export interface KosConnectionOptions {
  host?: string;
  port?: number;
  /**
   * CPU ID to connect to (1-based). If cpuLabel is provided, this is ignored.
   */
  cpuId?: number;
  /**
   * CPU label to connect to (e.g., 'guidance', 'flight').
   * If provided, the connection will search for a CPU with this label.
   */
  cpuLabel?: string;
  /**
   * Transport type to use. Defaults to 'socket'.
   * - 'socket': Uses Node.js net.Socket for direct TCP (recommended, no external deps)
   * - 'tmux': Uses tmux sessions with nc (allows attaching to see output)
   */
  transportType?: 'socket' | 'tmux';
  /**
   * Optional custom transport instance. If provided, overrides transportType.
   */
  transport?: Transport;
}

export interface ExecuteOptions {
  /**
   * Skip waiting for sentinel/prompt output. Useful for commands that intentionally
   * tear down the session (e.g., quickload) where no response will arrive.
   */
  fireAndForget?: boolean;
}

/**
 * High-level kOS connection manager.
 *
 * Uses a Transport abstraction for the underlying communication,
 * making it easy to swap between socket (default) or tmux implementations.
 */
export class KosConnection {
  private transport: Transport | null = null;
  private transportType: 'socket' | 'tmux';
  private providedTransport: Transport | null = null;
  private state: ConnectionState = {
    connected: false,
    cpuId: null,
    vesselName: null,
    cpuTag: null,
    lastError: null,
  };
  private commandSequence = 0;
  private lastComsTestPass = 0; // Timestamp of last successful coms test
  private options: Required<Omit<KosConnectionOptions, 'transport' | 'transportType' | 'cpuLabel'>> & { cpuLabel?: string };

  // Command serialization lock to prevent interleaved commands
  private commandLock: Promise<void> = Promise.resolve();

  constructor(options: KosConnectionOptions = {}) {
    this.options = {
      host: options.host ?? config.kos.host,
      port: options.port ?? config.kos.port,
      // Use explicit option, then config, then null (auto-select first CPU)
      cpuId: options.cpuId ?? config.kos.cpuId ?? 0, // 0 means auto-select
      cpuLabel: options.cpuLabel ?? config.kos.cpuLabel,
    };

    // Store provided transport for later use
    if (options.transport) {
      this.providedTransport = options.transport;
    }

    // Determine transport type: explicit option > config > default 'socket'
    this.transportType = options.transportType ?? config.transport.type ?? 'socket';
  }

  /**
   * Create the transport instance. Called lazily during connect().
   */
  private async createTransport(): Promise<Transport> {
    // Use provided transport if available
    if (this.providedTransport) {
      return this.providedTransport;
    }

    switch (this.transportType) {
      case 'tmux': {
        return new TmuxTransport(this.options.host, this.options.port);
      }

      case 'socket':
      default: {
        return new SocketTransport(this.options.host, this.options.port);
      }
    }
  }

  /**
   * Wait for CPU menu, using Ctrl+D to exit any session if needed.
   * Ctrl+D exits kOS session back to CPU menu, Enter wakes up idle menu.
   *
   * Event-driven: No fixed delays - waitFor() resolves immediately when pattern found.
   */
  private async waitForCpuMenu(timeoutMs: number): Promise<string> {
    if (!this.transport) {
      throw new Error('Transport not initialized');
    }

    // First try: wait for menu directly (fast path - 500ms timeout)
    try {
      return await this.transport.waitFor('Choose a CPU', 500);
    } catch {
      // Menu didn't appear - might be in a session
    }

    // Send Ctrl+D to exit any existing session back to CPU menu
    // No delay needed - event-driven waitFor will detect menu immediately
    await this.transport.sendKeys?.('C-d');

    // Second try: wait for menu after Ctrl+D
    try {
      return await this.transport.waitFor('Choose a CPU', timeoutMs);
    } catch {
      // Still no menu - try Enter as fallback
    }

    // Try Enter to wake up idle menu (no delay needed)
    await this.transport.send('\r\n');

    // Final try
    try {
      return await this.transport.waitFor('Choose a CPU', timeoutMs);
    } catch {
      throw new Error('Timeout waiting for CPU menu');
    }
  }

  /**
   * Connect to kOS terminal server and attach to a CPU.
   * @param cpuIdOrLabel - CPU ID (number) or label (string). Overrides constructor options.
   */
  async connect(cpuIdOrLabel?: number | string): Promise<ConnectionState> {
    try {
      // Create transport lazily
      if (!this.transport) {
        this.transport = await this.createTransport();
      }

      // Initialize transport (starts TCP connection)
      await this.transport.init();

      // Wait for CPU menu to appear (tries Enter key to wake up if needed)
      let menuOutput: string;
      try {
        menuOutput = await this.waitForCpuMenu(config.timeouts.cpuMenu);
      } catch {
        // No menu appeared - might already be connected to last CPU
        // Try sending REBOOT to verify connection
        await this.transport.read(); // Clear buffer
        await new Promise(r => setTimeout(r, 100)); // Brief delay for REBOOT processing

        await this.transport.send('REBOOT.');

        // If REBOOT works, we should see the menu appear after reboot
        try {
          menuOutput = await this.waitForCpuMenu(config.timeouts.reboot);
          // Menu appeared after reboot - we were connected!
          // Continue with normal flow below
        } catch {
          throw new Error('Timeout waiting for kOS - is KSP running with kOS telnet enabled?');
        }
      }

      // Determine target CPU
      let targetCpu: number | undefined;
      let targetLabel: string | undefined;

      if (typeof cpuIdOrLabel === 'string') {
        targetLabel = cpuIdOrLabel;
      } else if (typeof cpuIdOrLabel === 'number') {
        targetCpu = cpuIdOrLabel;
      } else if (this.options.cpuLabel) {
        targetLabel = this.options.cpuLabel;
      } else if (this.options.cpuId > 0) {
        // Only use cpuId if it's explicitly set (> 0)
        targetCpu = this.options.cpuId;
      }
      // If no CPU specified, auto-select first available
      if (!targetCpu && !targetLabel) {
        targetCpu = this.getFirstCpuId(menuOutput);
        if (!targetCpu) {
          throw new Error('No CPUs available in kOS menu');
        }
      }

      // If connecting by label, find the CPU ID
      if (targetLabel) {
        const found = this.findCpuByLabel(menuOutput, targetLabel);
        if (!found) {
          throw new Error(`CPU with label '${targetLabel}' not found. Available CPUs:\n${this.listCpus(menuOutput)}`);
        }
        targetCpu = found;
      }

      // Menu should already include the "> " prompt
      // Only wait if it wasn't captured in menuOutput
      if (!menuOutput.includes('> ')) {
        try {
          await this.transport.waitFor(/>\s*$/, 500);
        } catch {
          // Prompt may have been missed, continue anyway
        }
      }

      // Select CPU
      await this.transport.send(String(targetCpu!));

      // Brief settling time, then clear terminal to discard stale output
      await new Promise(r => setTimeout(r, 50));
      if (this.transport.sendKeys) {
        await this.transport.sendKeys('C-k');
      }
      await this.transport.read(); // Discard any remaining buffer

      // Parse connection info from menu output
      this.state = this.parseConnectionInfo(menuOutput, targetCpu!);

      // Verify connection with coms test (may be in radio blackout)
      const comsOk = await this.comsTest(config.timeouts.command);
      if (!comsOk) {
        this.state.lastError = 'Radio blackout - no response from kOS';
        // Still mark as connected - caller can retry when in range
      } else {
        // Print installed script versions
        await this.printInstalledVersions();
      }

      return this.state;
    } catch (error) {
      this.state.lastError = error instanceof Error ? error.message : String(error);
      this.state.connected = false;
      throw error;
    }
  }

  /**
   * Reset connection to clear any stuck state.
   * Use when an operation is orphaned (e.g., MCP client timeout, save reload).
   * This closes the transport (killing any pending I/O), clears the lock,
   * and resets state so the next command triggers a fresh reconnect.
   *
   * Unlike forceReleaseLock(), this avoids garbled output by ensuring
   * no in-flight commands can interfere with subsequent commands.
   */
  resetConnection(): void {
    // Close transport to kill any pending I/O
    if (this.transport) {
      this.transport.close().catch(() => {});
      this.transport = null;
    }

    // Clear the lock and caches
    this.commandLock = Promise.resolve();
    this.lastComsTestPass = 0;

    // Reset state - next command will trigger reconnect
    this.state = {
      connected: false,
      cpuId: this.state.cpuId, // Preserve CPU preference
      vesselName: null,
      cpuTag: this.state.cpuTag, // Preserve CPU preference
      lastError: 'Connection reset to clear stuck state',
    };
  }

  /**
   * Force-release the command lock.
   * @deprecated Use resetConnection() instead to avoid garbled output.
   */
  forceReleaseLock(): void {
    this.commandLock = Promise.resolve();
  }

  /**
   * Acquire command lock to serialize commands.
   * Returns a release function that must be called when done.
   * Includes timeout to prevent deadlocks.
   */
  private async acquireCommandLock(timeoutMs: number): Promise<() => void> {
    // Race between lock acquisition and timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Command lock timeout - previous command may be stuck')), timeoutMs + 5000);
    });

    // Wait for any pending command to complete (with timeout)
    await Promise.race([this.commandLock, timeoutPromise]);

    // Create new lock that will be released when we're done
    let release: () => void;
    let released = false;
    this.commandLock = new Promise(resolve => {
      release = () => {
        if (!released) {
          released = true;
          resolve();
        }
      };
    });

    return release!;
  }

  /**
   * Execute a kOS command (fire-and-forget pattern).
   * Sends command, discards all output. Use queue() if you need output.
   */
  async raw(command: string, timeoutMs = config.timeouts.command, _options?: ExecuteOptions): Promise<CommandResult> {
    if (!this.state.connected || !this.transport) {
      return { success: false, output: '', error: 'Not connected to kOS' };
    }

    // Serialize commands to prevent interleaving
    let releaseLock: (() => void) | null = null;
    try {
      releaseLock = await this.acquireCommandLock(timeoutMs);
    } catch (error) {
      this.resetConnection();
      return { success: false, output: '', error: error instanceof Error ? error.message : 'Lock acquisition failed' };
    }

    try {
      // Clear any pending output from transport buffer
      await this.transport.read();

      // Coms test: verify radio contact before sending real command
      const hasRadio = await this.comsTest(timeoutMs);
      if (!hasRadio) {
        // Reset connection so next call does fresh connect with boot wait
        this.resetConnection();
        const maxTimeout = config.timeouts.comsTestMax;
        const effectiveTimeout = Math.min(timeoutMs, maxTimeout);
        return {
          success: false,
          output: '',
          error: `Radio loss detected - coms test timed out after ${effectiveTimeout}ms (2 attempts)`,
        };
      }

      // Clear buffer after coms test
      await this.transport.read();

      // Send command (no sentinel, output discarded)
      // Prepend Ctrl+K to clear kOS terminal
      await this.transport.send(`\u000B${command}`);

      // Wait for echo + additional output, then drain buffer
      // This prevents leftover output from contaminating subsequent queue() calls
      // Output is logged automatically by transport.read() when KOS_DEBUG=1
      await new Promise(resolve => setTimeout(resolve, 100));
      await this.transport.read();

      return { success: true, output: '' };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.state.lastError = errorMsg;

      if (errorMsg.includes('EPIPE') || errorMsg.includes('ECONNRESET') ||
          errorMsg.includes('ECONNREFUSED') || errorMsg.includes('Connection refused') ||
          errorMsg.includes('closed') || errorMsg.includes('Socket closed')) {
        this.state.connected = false;
        this.transport = null;
      }

      return { success: false, output: '', error: errorMsg };
    } finally {
      if (releaseLock) {
        try {
          releaseLock();
        } catch {
          this.commandLock = Promise.resolve();
        }
      }
    }
  }

  /**
   * Execute command with automatic output markers.
   * Returns only the content printed between markers, cleanly separated from echo.
   *
   * This method wraps the command with unique markers and extracts the output
   * between them, bypassing the fragile cleanOutput() echo stripping entirely.
   *
   * @param command - kOS command(s) to execute (should PRINT output)
   * @param timeoutMs - Timeout for command execution
   * @returns CommandResult with extracted output between markers
   */
  async queue(command: string, timeoutMs = config.timeouts.command): Promise<CommandResult> {
    // Generate unique marker pair using hash
    const hash = createHash('sha1')
      .update(command)
      .update(String(Date.now()))
      .update(String(this.commandSequence))
      .digest('hex')
      .slice(0, 8)
      .toUpperCase();

    const startMarker = `[MCP_OUT_${hash}_START]`;
    const endMarker = `[MCP_OUT_${hash}_END]`;

    // Wrap command: print start marker, execute command, print end marker
    // Markers are concatenated ("["+"MCP_OUT_...") so they don't appear complete in the echo
    const wrappedCommand =
      `PRINT "["+"MCP_OUT_${hash}_START"+"]". ${command} PRINT "["+"MCP_OUT_${hash}_END"+"]".`;

    // Execute and get raw output
    const result = await this.executeRaw(wrappedCommand, timeoutMs);

    if (!result.success) {
      return { success: false, output: '', error: result.error };
    }

    // Extract content between markers from raw output
    const startIdx = result.rawOutput.indexOf(startMarker);
    const endIdx = result.rawOutput.indexOf(endMarker);

    if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
      // Markers not found - could be kOS error or timeout
      // Check for errors in the raw output
      const error = this.detectError(result.rawOutput);
      if (error) {
        return { success: false, output: '', error };
      }
      return { success: false, output: '', error: 'Output markers not found' };
    }

    // Extract content between markers and clean it
    let extracted = result.rawOutput.slice(startIdx + startMarker.length, endIdx);
    // Strip kOS terminal control sequences (PUA characters)
    extracted = this.stripUnicodeCommands(extracted);
    // Normalize line endings and strip control chars
    extracted = extracted
      .replaceAll('\r\n', '\n')
      .replaceAll('\r', '\n')
      // eslint-disable-next-line no-control-regex -- stripping terminal control chars
      .replaceAll(/[\u0000-\u0009\u000B-\u001F]/g, '')
      .trim();

    // Check for kOS errors in extracted content
    const error = this.detectError(extracted);
    if (error) {
      return { success: false, output: extracted, error };
    }

    return { success: true, output: extracted };
  }

  /**
   * Execute command and return raw output before cleanOutput() processing.
   * This is an internal method used by both execute() and queue().
   *
   * @param command - kOS command to execute
   * @param timeoutMs - Timeout for command execution
   * @param options - Execution options (fireAndForget not supported here)
   * @returns Raw execution result with unprocessed output
   */
  private async executeRaw(command: string, timeoutMs: number): Promise<RawExecuteResult> {
    if (!this.state.connected || !this.transport) {
      return { success: false, rawOutput: '', sentinelToken: '', sentinelCommand: '', error: 'Not connected to kOS' };
    }

    // Serialize commands to prevent interleaving
    let releaseLock: (() => void) | null = null;
    try {
      releaseLock = await this.acquireCommandLock(timeoutMs);
    } catch (error) {
      this.resetConnection();
      return {
        success: false,
        rawOutput: '',
        sentinelToken: '',
        sentinelCommand: '',
        error: error instanceof Error ? error.message : 'Lock acquisition failed',
      };
    }

    try {
      // Clear any pending output from transport buffer
      await this.transport.read();

      // Coms test: verify radio contact before sending real command
      const hasRadio = await this.comsTest(timeoutMs);
      if (!hasRadio) {
        // Reset connection so next call does fresh connect with boot wait
        this.resetConnection();
        const maxTimeout = config.timeouts.comsTestMax;
        const effectiveTimeout = Math.min(timeoutMs, maxTimeout);
        return {
          success: false,
          rawOutput: '',
          sentinelToken: '',
          sentinelCommand: '',
          error: `Radio loss detected - coms test timed out after ${effectiveTimeout}ms (2 attempts)`,
        };
      }

      // Clear buffer after coms test
      await this.transport.read();

      // Send command followed by sentinel
      const { token: sentinelToken, command: sentinelCommand } = this.createSentinel(command);
      const sentinelPattern = this.buildSentinelPattern(sentinelToken);

      // Prepend Ctrl+K to clear kOS terminal, then command + sentinel
      await this.transport.send(`\u000B${command} ${sentinelCommand}`);

      // Wait for sentinel
      let rawOutput: string;
      try {
        rawOutput = await this.transport.waitFor(sentinelPattern, timeoutMs);
      } catch {
        // Sentinel didn't appear - check if stuck at CPU menu
        const buffer = await this.transport.read();
        if (buffer.includes('Choose a CPU') || buffer.includes('kOS Terminal Server')) {
          this.resetConnection();
          throw new Error(`Connection stuck at CPU menu - reset triggered. Retry command.`);
        }
        return {
          success: false,
          rawOutput: buffer,
          sentinelToken,
          sentinelCommand,
          error: `Command timed out (no sentinel after ${timeoutMs}ms)`,
        };
      }

      return { success: true, rawOutput, sentinelToken, sentinelCommand };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.state.lastError = errorMsg;

      // Mark as disconnected on transport errors
      if (
        errorMsg.includes('EPIPE') ||
        errorMsg.includes('ECONNRESET') ||
        errorMsg.includes('ECONNREFUSED') ||
        errorMsg.includes('Connection refused') ||
        errorMsg.includes('closed') ||
        errorMsg.includes('Socket closed')
      ) {
        this.state.connected = false;
        this.transport = null;
      }

      return { success: false, rawOutput: '', sentinelToken: '', sentinelCommand: '', error: errorMsg };
    } finally {
      if (releaseLock) {
        try {
          releaseLock();
        } catch {
          this.commandLock = Promise.resolve();
        }
      }
    }
  }

  /**
   * Try to detach from CPU by sending Ctrl+D and checking for menu.
   * Returns true if we got back to CPU menu (power loss), false if stuck (crashed).
   */
  async tryDetach(timeoutMs = 2000): Promise<boolean> {
    if (!this.transport) {
      return false;
    }

    try {
      // Send Ctrl+D to try to detach
      if (this.transport.sendKeys) {
        await this.transport.sendKeys('C-d');
      } else {
        // Fallback: send raw Ctrl+D byte
        await this.transport.send('\u0004');
      }

      // Wait for menu to appear
      try {
        const response = await this.transport.waitFor(/Choose a CPU/i, timeoutMs);
        if (response.includes('Choose a CPU')) {
          return true;
        }
      } catch {
        // Menu didn't appear - try sending Enter to wake it up
      }

      // Sometimes menu needs Enter to appear
      await this.transport.read(); // Clear buffer
      await new Promise(r => setTimeout(r, 200));
      await this.transport.send('\r\n');
      await new Promise(r => setTimeout(r, 300));

      const response = await this.transport.waitFor(/Choose a CPU/i, timeoutMs);
      return response.includes('Choose a CPU');
    } catch {
      // Timeout or error - couldn't detach, vessel likely crashed
      return false;
    }
  }

  /**
   * Disconnect from kOS terminal
   */
  async disconnect(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    this.state = {
      connected: false,
      cpuId: null,
      vesselName: null,
      cpuTag: null,
      lastError: null,
    };
  }

  /**
   * Get current connection state
   */
  getState(): ConnectionState {
    return { ...this.state };
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.state.connected;
  }

  /**
   * Get the underlying transport (for debugging/advanced use)
   */
  getTransport(): Transport | null {
    return this.transport;
  }

  /**
   * Flush any stale data from the transport buffer.
   * Waits briefly for any in-flight data to arrive, then clears the buffer.
   * Use before critical multi-query operations (like status) to ensure clean state.
   */
  async flushStaleData(waitMs: number = 50): Promise<void> {
    if (!this.transport) return;

    // Check if transport has flushStaleData method (SocketTransport does)
    const socketTransport = this.transport as { flushStaleData?: (ms: number) => Promise<void> };
    if (socketTransport.flushStaleData) {
      await socketTransport.flushStaleData(waitMs);
    } else {
      // Fallback: just read and discard
      await new Promise(r => setTimeout(r, waitMs));
      await this.transport.read();
    }
  }

  /**
   * Lightweight connectivity test before real commands.
   * Sends PRINT and verifies output appears (not just echo).
   * Retries once on failure to handle transient issues.
   * @param timeoutMs - Timeout for coms test (capped at config.timeouts.comsTestMax)
   * @returns true if radio contact confirmed, false if likely radio loss
   */
  private async comsTest(timeoutMs: number): Promise<boolean> {
    if (!this.transport) return false;

    // Skip if we passed a coms test recently (within 1 second)
    // This avoids redundant tests during rapid command sequences
    const now = Date.now();
    if (now - this.lastComsTestPass < 1000) {
      return true;
    }

    // Use passed timeout, but ensure minimum of 10s and cap at comsTestMax
    // Minimum is needed because hard drive spin-up and buffered data may delay response
    const minTimeout = 10_000;
    const maxTimeout = config.timeouts.comsTestMax;
    const effectiveTimeout = Math.min(Math.max(timeoutMs, minTimeout), maxTimeout);

    for (let attempt = 1; attempt <= 2; attempt++) {
      const startTime = Date.now();
      const marker = `MCP_COMS_TEST-${startTime}`;

      // Clear buffer first
      await this.transport.read();

      // Send Ctrl+K to clear terminal, then test PRINT
      await this.transport.send(`\u000BPRINT "${marker}".`);

      // Wait for marker in output, not echo - use negative lookbehind to skip quoted echo
      const markerPattern = new RegExp(`(?<!")${marker}`);
      try {
        await this.transport.waitFor(markerPattern, effectiveTimeout);
        // Marker appeared → radio contact confirmed
        this.lastComsTestPass = Date.now();
        return true;
      } catch {
        const elapsed = Date.now() - startTime;
        console.error(`[kos-connection] TIMEOUT: comsTest attempt ${attempt} timed out after ${elapsed}ms (limit: ${effectiveTimeout}ms)`);
        // First attempt failed - wait and retry
        if (attempt === 1) {
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        // Both attempts failed
        console.error(`[kos-connection] TIMEOUT: comsTest failed after 2 attempts - radio loss likely`);
        return false;
      }
    }
    return false;
  }

  /**
   * Print installed script versions to console.
   * Called after successful connection to show what's on the vessel.
   */
  private async printInstalledVersions(): Promise<void> {
    const statusVer = await this.getInstalledVersion('1:/mcp_status.ks');
    const alignVer = await this.getInstalledVersion('1:/mcp_align.ks');
    console.error(`[kos-connection] Installed: mcp_status=${statusVer}, mcp_align=${alignVer}`);
  }

  /**
   * Get the installed version of a script by reading its first line.
   * Returns the version hash, 'none' if file doesn't exist, or 'error' on failure.
   */
  private async getInstalledVersion(path: string): Promise<string> {
    try {
      const result = await this.queue(
        `IF EXISTS("${path}") { LOCAL lines IS OPEN("${path}"):READALL. LOCAL iter IS lines:ITERATOR. IF iter:NEXT { PRINT iter:VALUE. } ELSE { PRINT "[EMPTY]". } } ELSE { PRINT "[NO_FILE]". }`,
        2000
      );
      if (result.success) {
        const output = result.output.trim();
        if (output === '[NO_FILE]') {
          return 'none';
        }
        if (output === '[EMPTY]') {
          return 'empty';
        }
        const match = output.match(/version:\s*(\w+)/);
        return match?.[1] ?? 'unknown';
      }
      return 'error';
    } catch {
      return 'error';
    }
  }

  /**
   * Parse connection info from kOS menu output
   * Example line: "[1]   no    1     stick 1 (RC-L01(guidance))"
   */
  private parseConnectionInfo(output: string, cpuId: number): ConnectionState {
    const lines = output.split('\n');
    let vesselName = 'Unknown';
    let cpuTag = 'Unknown';

    for (const line of lines) {
      // Match: [1]   no    1     vessel name (PartName(tag))
      // Capture: [id], vessel name (everything before last paren group), tag (innermost parens)
      const match = line.match(/\[\s*(\d+)\]\s+\w+\s+\d+\s+(.+?)\s+\([^(]+\(([^)]*)\)\)/);
      if (match && Number.parseInt(match[1]) === cpuId) {
        vesselName = match[2].trim();
        cpuTag = match[3] || '(unnamed)';
        break;
      }
    }

    return {
      connected: true,
      cpuId,
      vesselName,
      cpuTag,
      lastError: null,
    };
  }

  /**
   * Find CPU ID by label/tag from menu output
   * Menu format: "[1]   no    1     stick 1 (RC-L01(guidance))"
   * @returns CPU ID if found, undefined otherwise
   */
  private findCpuByLabel(output: string, label: string): number | undefined {
    const lines = output.split('\n');
    const labelLower = label.toLowerCase();

    for (const line of lines) {
      // Match: [1]   no    1     vessel name (PartName(tagname))
      // The tag is inside nested parens at the end: (tagname))
      const match = line.match(/\[\s*(\d+)\].*\(([^()]*)\)\)/);
      if (match && match[2].toLowerCase() === labelLower) {
        return Number.parseInt(match[1]);
      }
    }
    return undefined;
  }

  /**
   * Get first CPU ID from menu output (for auto-selection)
   * @returns First CPU ID found, or undefined if none
   */
  private getFirstCpuId(menuOutput: string): number | undefined {
    const match = menuOutput.match(/\[\s*(\d+)\]/);
    return match ? Number.parseInt(match[1], 10) : undefined;
  }

  /**
   * List available CPUs from menu output (for error messages)
   * Menu format: "[1]   no    1     stick 1 (RC-L01(guidance))"
   */
  private listCpus(output: string): string {
    const lines = output.split('\n');
    const cpus: string[] = [];

    for (const line of lines) {
      // Match: [id] ... (PartName(tag)) - capture full parenthetical
      const match = line.match(/\[\s*(\d+)\].*\(([^)]+\([^)]*\))\)\s*$/);
      if (match) {
        cpus.push(`  [${match[1]}] ${match[2]}`);
      } else {
        // Try simpler pattern for CPUs without nested parens: (PartName())
        const simpleMatch = line.match(/\[\s*(\d+)\].*\(([^)]+)\(\)\)\s*$/);
        if (simpleMatch) {
          cpus.push(`  [${simpleMatch[1]}] ${simpleMatch[2]} (no tag)`);
        }
      }
    }

    return cpus.length > 0 ? cpus.join('\n') : '  (no CPUs found)';
  }



  /**
   * Strip kOS UnicodeCommand sequences from output.
   *
   * kOS uses Private Use Area chars (U+E000-U+F8FF) for terminal control.
   * Some commands have trailing parameter bytes that must also be stripped:
   * - TELEPORTCURSOR (0xE006): + col byte + row byte
   * - RESIZESCREEN (0xE016): + width byte + height byte
   * - TITLEBEGIN (0xE004): + chars until TITLEEND (0xE005)
   */
  private stripUnicodeCommands(input: string): string {
    const result: string[] = [];
    let i = 0;

    while (i < input.length) {
      const code = input.charCodeAt(i);

      // Check if this is a Private Use Area character (kOS UnicodeCommand)
      if (code >= 0xE0_00 && code <= 0xF8_FF) {
        // Handle multi-byte commands
        switch (code) {
          case 0xE0_06: // TELEPORTCURSOR - skip next 2 chars (col, row)
          case 0xE0_16: { // RESIZESCREEN - skip next 2 chars (width, height)
            i += 3; // Skip command + 2 parameter bytes
            break;
          }

          case 0xE0_04: { // TITLEBEGIN - skip until TITLEEND (0xE005)
            i++; // Skip TITLEBEGIN
            while (i < input.length && input.charCodeAt(i) !== 0xE0_05) {
              i++;
            }
            if (i < input.length) i++; // Skip TITLEEND
            break;
          }

          case 0xE0_11: // STARTNEXTLINE - treat as newline
          case 0xE0_12: // LINEFEEDKEEPCOL
          case 0xE0_13: { // GOTOLEFTEDGE
            result.push('\n');
            i++;
            break;
          }

          default: {
            // Single-byte command, just skip it
            i++;
            break;
          }
        }
      } else {
        // Normal character, keep it
        result.push(input[i]);
        i++;
      }
    }

    return result.join('');
  }

  /**
   * Detect common kOS errors in output
   */
  private detectError(output: string): string | null {
    const errorPatterns = [
      { pattern: /Signal lost\.\s+Waiting to re-acquire signal/i, message: 'Radio blackout - vessel has lost signal' },
      { pattern: /Cannot find suffixed term/i, message: 'Unknown property or method' },
      { pattern: /Program aborted/i, message: 'kOS program was aborted' },
      { pattern: /Syntax error/i, message: 'kOS syntax error' },
      { pattern: /Cannot (perform|do) .* on/i, message: 'Type mismatch in operation' },
      { pattern: /No such node/i, message: 'Maneuver node does not exist' },
      { pattern: /No target/i, message: 'No target set' },
      { pattern: /Connection refused/i, message: 'Connection refused - is KSP running?' },
      { pattern: /Unable to connect/i, message: 'Unable to connect to kOS server' },
      { pattern: /File ['"].*['"] not found/i, message: 'File not found' },
    ];

    for (const { pattern, message } of errorPatterns) {
      if (pattern.test(output)) {
        return message;
      }
    }

    return null;
  }

  /**
   * Create a unique sentinel PRINT command that signals command completion.
   */
  private createSentinel(command: string): { token: string; command: string } {
    const hash = createHash('sha1')
      .update(command)
      .update(String(Date.now()))
      .update(String(this.commandSequence))
      .digest('hex')
      .slice(0, 8)
      .toUpperCase();
    const token = `[MCP.${this.commandSequence.toString(36).toUpperCase()}.${hash}]`;
    this.commandSequence = (this.commandSequence + 1) % Number.MAX_SAFE_INTEGER;
    return {
      token,
      command: `PRINT "${token}".`,
    };
  }

  /**
   * Build a regex pattern that matches the sentinel token when it appears on its own line.
   * This prevents triggering on the command echo (which also contains the token).
   */
  private buildSentinelPattern(token: string): RegExp {
    const escaped = token.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    // Match the sentinel token when it appears outside of quotes to avoid hitting the echo line.
    return new RegExp(`(?<!")${escaped}`);
  }
}
