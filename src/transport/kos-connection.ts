import { Transport } from './transport.js';
import { TmuxTransport } from './tmux-transport.js';
import { SocketTransport } from './socket-transport.js';
import { config } from '../config.js';
import { globalKosMonitor } from '../monitoring/kos-monitor.js';

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
  private options: Required<Omit<KosConnectionOptions, 'transport' | 'transportType' | 'cpuLabel'>> & { cpuLabel?: string };

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
      case 'tmux':
        return new TmuxTransport(this.options.host, this.options.port);

      case 'socket':
      default:
        return new SocketTransport(this.options.host, this.options.port);
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

      // Wait for CPU menu to appear
      let menuOutput: string;
      try {
        menuOutput = await this.transport.waitFor('Choose a CPU', config.timeouts.cpuMenu);
      } catch {
        // No menu appeared - might already be connected to last CPU
        // Try sending REBOOT to verify connection
        await this.transport.read(); // Clear buffer
        await new Promise(r => setTimeout(r, 500));

        await this.transport.send('REBOOT.');

        // If REBOOT works, we should see the menu appear after reboot
        try {
          menuOutput = await this.transport.waitFor('Choose a CPU', config.timeouts.reboot);
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
      // - Reconnection to existing session shows scrollback (no Proceed)
      try {
        await this.transport.waitFor(/Proceed/, config.timeouts.proceed);
      } catch {
        // Might be reconnecting to existing session with scrollback
        // Clear the buffer and verify connection by sending a test command
        await this.transport.read();

        // Small delay to ensure CPU is selected
        await new Promise(r => setTimeout(r, 500));
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
   * Execute a kOS command and return the result
   */
  async execute(command: string, timeoutMs = config.timeouts.command): Promise<CommandResult> {
    if (!this.state.connected || !this.transport) {
      return { success: false, output: '', error: 'Not connected to kOS' };
    }

    try {
      // Clear any pending output and wait briefly for socket buffer to drain
      await this.transport.read();
      await new Promise(r => setTimeout(r, 10));
      await this.transport.read();  // Second read to catch any stragglers

      // Send command
      await this.transport.send(command);

      // Wait for ETB (End Transmission Block, \u0017) which kOS sends after command output
      // kOS uses control characters, not a '>' prompt:
      // - \u0015 (NAK) before command echo
      // - \u0016 (SYN) between echo and result
      // - \u0017 (ETB) at end of output
      let output: string;
      try {
        output = await this.transport.waitFor(/\u0017$/, timeoutMs);
      } catch {
        // Timeout - read whatever we have
        output = await this.transport.read();
      }

      // Clean up output (remove the command echo and prompt)
      const cleanOutput = this.cleanOutput(command, output);

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
      if (match && parseInt(match[1]) === cpuId) {
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
        return parseInt(match[1]);
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
    return match ? parseInt(match[1], 10) : undefined;
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
   * Clean up command output (remove echo, prompts, etc.)
   */
  private cleanOutput(command: string, output: string): string {
    // Remove kOS terminal control characters:
    // - C0 control codes (U+0000-U+001F): NULL, NAK, SYN, ETB, etc.
    // - Private Use Area (U+E000-U+F8FF): kOS visual formatting
    const sanitized = output.replace(/[\u0000-\u001F\uE000-\uF8FF]/g, '');

    const lines = sanitized.split('\n');

    // Process lines:
    // - Strip command echo prefix (kOS outputs "COMMAND result" on same line)
    // - Filter out prompts and empty lines
    return lines
      .map(line => {
        const trimmed = line.trim();
        // Strip command echo from start of line if present
        if (trimmed.startsWith(command)) {
          return trimmed.slice(command.length).trim();
        }
        return trimmed;
      })
      .filter(line => {
        if (line === '>') return false;
        if (line === '') return false;
        return true;
      })
      .join('\n')
      .trim();
  }

  /**
   * Detect common kOS errors in output
   */
  private detectError(output: string): string | null {
    const errorPatterns = [
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
}
