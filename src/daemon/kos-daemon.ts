/**
 * kOS Connection Daemon
 *
 * Maintains a persistent connection to kOS that CLI commands can reuse.
 * Auto-exits after 30 seconds of inactivity.
 *
 * Communication via Unix socket (macOS/Linux) or named pipe (Windows)
 *
 * Protocol (JSON over newline-delimited messages):
 *
 * Request:
 *   { "type": "execute", "command": "PRINT 1." }
 *   { "type": "status" }
 *   { "type": "shutdown" }
 *
 * Response:
 *   { "success": true, "output": "1", "connected": true, "vessel": "stick 1" }
 *   { "success": false, "error": "Not connected" }
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import { KosConnection } from '../transport/kos-connection.js';
import { config } from '../config.js';
import { SOCKET_PATH, PID_PATH, isWindows } from './daemon-paths.js';
const IDLE_TIMEOUT_MS = 30000; // 30 seconds

interface DaemonRequest {
  type: 'execute' | 'connect' | 'disconnect' | 'status' | 'shutdown' | 'ping';
  command?: string;
  timeout?: number;
  cpuId?: number;
  cpuLabel?: string;
}

interface DaemonResponse {
  success: boolean;
  output?: string;
  error?: string;
  connected?: boolean;
  vessel?: string;
  cpuId?: number;
  cpuTag?: string;
}

class KosDaemon {
  private connection: KosConnection | null = null;
  private server: net.Server | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private activeClients = 0;

  /**
   * Check if an existing daemon is alive by trying to connect and ping it
   */
  private checkExistingDaemon(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.createConnection(SOCKET_PATH);
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 1000);

      socket.on('connect', () => {
        // Send ping request
        socket.write(JSON.stringify({ type: 'ping' }) + '\n');
      });

      socket.on('data', (data) => {
        clearTimeout(timeout);
        socket.destroy();
        // If we got any response, daemon is alive
        try {
          const response = JSON.parse(data.toString().split('\n')[0]);
          resolve(response.success === true);
        } catch {
          resolve(false);
        }
      });

      socket.on('error', () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  }

  async start(): Promise<void> {
    // Check if another daemon is already running
    // Note: On Windows, named pipes don't create filesystem entries, so existsSync returns false
    if (!isWindows && fs.existsSync(SOCKET_PATH)) {
      const isAlive = await this.checkExistingDaemon();
      if (isAlive) {
        console.error('[kos-daemon] Another daemon is already running');
        process.exit(1);
      }
      // Stale socket file - remove it (Unix only, Windows pipes auto-cleanup)
      fs.unlinkSync(SOCKET_PATH);
    }

    // Check for stale PID file
    if (fs.existsSync(PID_PATH)) {
      const oldPid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim(), 10);
      if (!isNaN(oldPid)) {
        try {
          // Check if process exists (signal 0 doesn't kill, just checks)
          process.kill(oldPid, 0);
          // Process exists - another daemon is running without socket
          console.error(`[kos-daemon] Another daemon (PID ${oldPid}) appears to be running`);
          process.exit(1);
        } catch {
          // Process doesn't exist - stale PID file
          fs.unlinkSync(PID_PATH);
        }
      }
    }

    // Write our PID file
    fs.writeFileSync(PID_PATH, process.pid.toString());

    this.server = net.createServer((socket) => this.handleClient(socket));

    this.server.listen(SOCKET_PATH, () => {
      // Make socket accessible (Unix only, Windows pipes handle permissions differently)
      if (!isWindows) {
        fs.chmodSync(SOCKET_PATH, 0o666);
      }
      console.log(`[kos-daemon] Listening on ${SOCKET_PATH}`);
      this.resetIdleTimer();
    });

    this.server.on('error', (err) => {
      console.error(`[kos-daemon] Server error: ${err.message}`);
      process.exit(1);
    });

    // Handle graceful shutdown
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());
  }

  private handleClient(socket: net.Socket): void {
    this.activeClients++;
    this.clearIdleTimer();

    let buffer = '';

    socket.on('data', async (data) => {
      buffer += data.toString();

      // Process complete messages (newline-delimited)
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const request: DaemonRequest = JSON.parse(line);
          const response = await this.handleRequest(request);
          socket.write(JSON.stringify(response) + '\n');
        } catch (err) {
          const response: DaemonResponse = {
            success: false,
            error: `Invalid request: ${err instanceof Error ? err.message : String(err)}`,
          };
          socket.write(JSON.stringify(response) + '\n');
        }
      }
    });

    socket.on('close', () => {
      this.activeClients--;
      if (this.activeClients === 0) {
        this.resetIdleTimer();
      }
    });

    socket.on('error', (err) => {
      console.error(`[kos-daemon] Client error: ${err.message}`);
    });
  }

  private async handleRequest(request: DaemonRequest): Promise<DaemonResponse> {
    // Don't reset idle timer here - it's managed by activeClients
    // This prevents premature shutdown during long-running commands

    switch (request.type) {
      case 'ping':
        return { success: true, output: 'pong' };

      case 'connect':
        return this.handleConnect(request);

      case 'disconnect':
        return this.handleDisconnect();

      case 'execute':
        return this.handleExecute(request);

      case 'status':
        return this.handleStatus();

      case 'shutdown':
        setTimeout(() => this.shutdown(), 100);
        return { success: true, output: 'Shutting down' };

      default:
        return { success: false, error: `Unknown request type: ${request.type}` };
    }
  }

  private async handleConnect(request: DaemonRequest): Promise<DaemonResponse> {
    try {
      // Disconnect existing connection if any
      if (this.connection?.isConnected()) {
        await this.connection.disconnect();
      }

      this.connection = new KosConnection({
        cpuId: request.cpuId,
        cpuLabel: request.cpuLabel,
      });

      const state = await this.connection.connect();

      return {
        success: true,
        connected: state.connected,
        vessel: state.vesselName || undefined,
        cpuId: state.cpuId || undefined,
        cpuTag: state.cpuTag || undefined,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        connected: false,
      };
    }
  }

  private async handleDisconnect(): Promise<DaemonResponse> {
    try {
      if (this.connection) {
        await this.connection.disconnect();
        this.connection = null;
      }
      return { success: true, connected: false };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private async handleExecute(request: DaemonRequest): Promise<DaemonResponse> {
    if (!request.command) {
      return { success: false, error: 'No command provided' };
    }

    // Auto-connect if not connected
    if (!this.connection?.isConnected()) {
      const connectResult = await this.handleConnect({
        type: 'connect',
        cpuId: request.cpuId,
        cpuLabel: request.cpuLabel,
      });

      if (!connectResult.success) {
        return connectResult;
      }
    }

    try {
      const result = await this.connection!.execute(
        request.command,
        request.timeout ?? config.timeouts.command
      );

      // Check if connection was lost during execute (transport error)
      // This enables auto-reconnect on next request
      if (!this.connection!.isConnected()) {
        this.connection = null;
      }

      const state = this.connection?.getState();

      return {
        success: result.success,
        output: result.output,
        error: result.error,
        connected: state?.connected ?? false,
        vessel: state?.vesselName || undefined,
        cpuId: state?.cpuId || undefined,
        cpuTag: state?.cpuTag || undefined,
      };
    } catch (err) {
      // Clear connection on error to enable auto-reconnect
      this.connection = null;
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private handleStatus(): DaemonResponse {
    if (!this.connection) {
      return { success: true, connected: false };
    }

    const state = this.connection.getState();
    return {
      success: true,
      connected: state.connected,
      vessel: state.vesselName || undefined,
      cpuId: state.cpuId || undefined,
      cpuTag: state.cpuTag || undefined,
    };
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer();

    this.idleTimer = setTimeout(() => {
      console.log('[kos-daemon] Idle timeout, shutting down');
      this.shutdown();
    }, IDLE_TIMEOUT_MS);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private async shutdown(): Promise<void> {
    console.log('[kos-daemon] Shutting down...');

    this.clearIdleTimer();

    // Close kOS connection
    if (this.connection) {
      try {
        await this.connection.disconnect();
      } catch {
        // Ignore errors during shutdown
      }
    }

    // Close server
    if (this.server) {
      this.server.close();
    }

    // Remove socket file (Unix only, Windows pipes auto-cleanup)
    if (!isWindows && fs.existsSync(SOCKET_PATH)) {
      fs.unlinkSync(SOCKET_PATH);
    }

    // Remove PID file
    if (fs.existsSync(PID_PATH)) {
      fs.unlinkSync(PID_PATH);
    }

    process.exit(0);
  }
}

// Start daemon
const daemon = new KosDaemon();
daemon.start().catch((err) => {
  console.error(`[kos-daemon] Failed to start: ${err.message}`);
  process.exit(1);
});
