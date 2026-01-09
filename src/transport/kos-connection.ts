import { Transport } from './transport.js';
import { TmuxTransport } from './tmux-transport.js';
import { SocketTransport } from './socket-transport.js';
import { config } from '../config/index.js';
import { globalKosMonitor } from '../utils/kos-monitor.js';
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
  /**
   * If false, skip prepending Ctrl+C to clear stray input. Default is true.
   * Set to false for health checks that need pristine command parsing.
   */
  clear?: boolean;
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
    await this.transport.send('\r\n', false);

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

      // Select CPU
      await this.transport.send(String(targetCpu!));

      // Wait for kOS to be ready
      // - Fresh connection shows "Proceed."
      // - Reconnection to existing session shows prompt ">" with scrollback
      // Wait for either pattern with short timeout (both appear quickly if they're coming)
      try {
        await this.transport.waitFor(/Proceed|>\s*$/, 500);
      } catch {
        // Neither appeared - might be slow or have scrollback without prompt
        // Clear buffer and continue - health check will verify
        await this.transport.read();
      }

      // Parse connection info from menu output
      this.state = this.parseConnectionInfo(menuOutput, targetCpu!);

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

    // Clear the lock
    this.commandLock = Promise.resolve();

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
   * Execute a kOS command and return the result.
   * Commands are serialized to prevent interleaving.
   */
  async execute(command: string, timeoutMs = config.timeouts.command, options?: ExecuteOptions): Promise<CommandResult> {
    if (!this.state.connected || !this.transport) {
      return { success: false, output: '', error: 'Not connected to kOS' };
    }

    // Serialize commands to prevent interleaving
    let releaseLock: (() => void) | null = null;
    try {
      releaseLock = await this.acquireCommandLock(timeoutMs);
    } catch (error) {
      // Lock acquisition failed (timeout) - reset connection to clear stuck state
      // This closes the transport, killing any pending I/O, so subsequent
      // commands will trigger a fresh reconnect without garbled output.
      this.resetConnection();
      return { success: false, output: '', error: error instanceof Error ? error.message : 'Lock acquisition failed' };
    }

    try {
      // Clear any pending output
      await this.transport.read();

      // Determine if we should clear stray input
      // Default: true for regular commands, false for health checks (which set clear: false explicitly)
      const clearInput = options?.clear !== false;

      if (options?.fireAndForget) {
        await this.transport.send(command, clearInput);
        return { success: true, output: '' };
      }

      // Send command followed by sentinel
      const { token: sentinelToken, command: sentinelCommand } = this.createSentinel(command);
      const sentinelPattern = this.buildSentinelPattern(sentinelToken);
      await this.transport.send(command, clearInput);
      await this.transport.send(sentinelCommand, false);  // Sentinel doesn't need clear

      // Wait for sentinel (primary) or prompt (fallback) to ensure completion
      let output: string;
      try {
        output = await this.transport.waitFor(sentinelPattern, timeoutMs);
      } catch {
        try {
          // Fallback to classic prompt-based wait
          output = await this.transport.waitFor(/>\s*$/, timeoutMs);
        } catch {
          // As a last resort, grab whatever is buffered
          output = await this.transport.read();
        }
      }

      // Clean up output (remove the command echo, sentinel, and prompt)
      const cleanOutput = this.cleanOutput([command, sentinelCommand], output, sentinelToken);

      // Track output in global monitor for kos://terminal/recent resource
      if (cleanOutput) {
        globalKosMonitor.trackLines(cleanOutput.split('\n'));
      }

      // Check for errors in output
      const error = this.detectError(cleanOutput);
      if (error) {
        return { success: false, output: cleanOutput, error };
      }

      return { success: true, output: cleanOutput };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.state.lastError = errorMsg;

      // Mark as disconnected on transport errors to enable auto-reconnect
      if (errorMsg.includes('EPIPE') || errorMsg.includes('ECONNRESET') ||
          errorMsg.includes('ECONNREFUSED') || errorMsg.includes('Connection refused') ||
          errorMsg.includes('closed') || errorMsg.includes('Socket closed')) {
        this.state.connected = false;
        this.transport = null;
      }

      return { success: false, output: '', error: errorMsg };
    } finally {
      // Always release lock, even if something unexpected happened
      if (releaseLock) {
        try {
          releaseLock();
        } catch {
          // Release failed - reset lock to prevent permanent deadlock
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
   * Clean up command output (remove echo, prompts, kOS terminal control chars)
   *
   * kOS uses Unicode Private Use Area (U+E000-U+F8FF) for terminal control.
   * See /docs/kos-protocol-analysis.md for full protocol documentation.
   *
   * Key UnicodeCommand values:
   * - TELEPORTCURSOR (0xE006): followed by 2 bytes (col, row)
   * - RESIZESCREEN (0xE016): followed by 2 bytes (width, height)
   * - TITLEBEGIN (0xE004): followed by chars until TITLEEND (0xE005)
   * - All others: single character commands
   */
  private cleanOutput(commands: string[], output: string, sentinelToken?: string): string {
    // Step 1: Strip kOS UnicodeCommand sequences (PUA characters + their parameters)
    // These are terminal control commands, not actual output data
    const stripped = this.stripUnicodeCommands(output);

    // Step 2: Normalize line endings and strip remaining control chars
    // Keep \r\n and \n for line structure, strip other C0 control codes
    const normalized = stripped
      .replaceAll('\r\n', '\n')           // Normalize CRLF to LF
      .replaceAll('\r', '\n')             // Normalize lone CR to LF
      // eslint-disable-next-line no-control-regex -- intentionally stripping terminal control chars
      .replaceAll(/[\u0000-\u0009\u000B-\u001F]/g, ''); // Strip other control chars (keep \n)

    // Step 3: Process lines
    const lines = normalized.split('\n');

    // Normalize commands for comparison (kOS normalizes whitespace in echo)
    const normalizedCommands = commands
      .filter(cmd => !!cmd && cmd.trim().length > 0)
      .map(cmd => ({
        raw: cmd,
        normalized: cmd.replaceAll(/\s+/g, ' ').trim(),
      }));

    const noisePatterns = [
      /^\{.*detaching.*\}$/i,
      /^detaching from/i,
      /^connecting to cpu/i,
      /^choose a cpu/i,
      /^selecting cpu/i,
    ];

    const cleaned = lines
      .map(line => {
        let trimmed = line.trim();
        if (!trimmed) {
          return '';
        }

        let normalizedLine = trimmed.replaceAll(/\s+/g, ' ');

        // Remove command echoes, handling cases where multiple commands are concatenated
        let strippedCommand = true;
        while (strippedCommand && trimmed.length > 0) {
          strippedCommand = false;
          for (const cmd of normalizedCommands) {
            if (normalizedLine.startsWith(cmd.normalized)) {
              const remainder = normalizedLine.slice(cmd.normalized.length).trim();
              trimmed = remainder;
              normalizedLine = remainder.replaceAll(/\s+/g, ' ');
              strippedCommand = true;
              break;
            }
            if (trimmed.startsWith(cmd.raw)) {
              const remainder = trimmed.slice(cmd.raw.length).trim();
              trimmed = remainder;
              normalizedLine = remainder.replaceAll(/\s+/g, ' ');
              strippedCommand = true;
              break;
            }
          }
        }

        if (sentinelToken && trimmed.includes(sentinelToken)) {
          trimmed = trimmed.split(sentinelToken).join('').trim();
        }

        return trimmed;
      })
      .filter(line => {
        if (!line) return false;
        if (line === '>') return false;  // kOS prompt
        if (noisePatterns.some(pattern => pattern.test(line))) return false;
        return true;
      })
      .join('\n')
      .trim();

    if (sentinelToken && cleaned.includes(sentinelToken)) {
      return cleaned.split(sentinelToken).join('').trim();
    }

    return cleaned;
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
