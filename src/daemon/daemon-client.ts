/**
 * Daemon Client
 *
 * Client library for CLI tools to communicate with kos-daemon.
 * Auto-spawns daemon if not running.
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { SOCKET_PATH, PID_PATH, isWindows } from './daemon-paths.js';
const CONNECT_TIMEOUT_MS = 5000;
const SPAWN_RETRY_DELAY_MS = 200;
const MAX_SPAWN_RETRIES = 15; // 3 seconds total

export interface DaemonRequest {
  type: 'execute' | 'connect' | 'disconnect' | 'status' | 'shutdown' | 'ping';
  command?: string;
  timeout?: number;
  cpuId?: number;
  cpuLabel?: string;
}

export interface DaemonResponse {
  success: boolean;
  output?: string;
  error?: string;
  connected?: boolean;
  vessel?: string;
  cpuId?: number;
  cpuTag?: string;
}

/**
 * Check if daemon is running
 *
 * On Unix: Check socket file exists and PID is alive
 * On Windows: Named pipes don't create filesystem entries, so check PID file only
 */
export function isDaemonRunning(): boolean {
  // On Unix, must have socket file
  if (!isWindows && !fs.existsSync(SOCKET_PATH)) {
    return false;
  }

  // Check PID file to verify the process is alive
  if (fs.existsSync(PID_PATH)) {
    try {
      const pid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim(), 10);
      if (!isNaN(pid)) {
        // Check if process is alive (signal 0 doesn't kill, just checks)
        process.kill(pid, 0);
        return true;
      }
    } catch {
      // Process not running - clean up stale files
      try {
        // Only try to unlink socket on Unix (Windows pipes auto-cleanup)
        if (!isWindows) {
          fs.unlinkSync(SOCKET_PATH);
        }
        fs.unlinkSync(PID_PATH);
      } catch {
        // Ignore cleanup errors
      }
      return false;
    }
  }

  // On Unix: Socket exists but no PID file - might be stale, assume running
  // On Windows: No PID file means not running (can't check pipe existence)
  return !isWindows && fs.existsSync(SOCKET_PATH);
}

/**
 * Spawn the daemon process
 */
async function spawnDaemon(): Promise<void> {
  // Get the daemon script path
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const daemonScript = path.join(__dirname, 'kos-daemon.js');

  // Check if compiled JS exists, otherwise use ts-node/tsx
  const useCompiledJs = fs.existsSync(daemonScript);

  if (useCompiledJs) {
    // Spawn using node
    spawn('node', [daemonScript], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  } else {
    // Spawn using tsx for development
    const tsScript = path.join(__dirname, 'kos-daemon.ts');
    spawn('npx', ['tsx', tsScript], {
      detached: true,
      stdio: 'ignore',
      cwd: path.resolve(__dirname, '../..'),
    }).unref();
  }

  // Wait for daemon to start
  for (let i = 0; i < MAX_SPAWN_RETRIES; i++) {
    await new Promise((r) => setTimeout(r, SPAWN_RETRY_DELAY_MS));
    if (isDaemonRunning()) {
      return;
    }
  }

  throw new Error('Failed to start daemon');
}

/**
 * Connect to daemon, spawning it if necessary
 */
async function connectToDaemon(): Promise<net.Socket> {
  // Spawn daemon if not running
  if (!isDaemonRunning()) {
    await spawnDaemon();
  }

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('Connection to daemon timed out'));
    }, CONNECT_TIMEOUT_MS);

    socket.on('connect', () => {
      clearTimeout(timeout);
      resolve(socket);
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Send a request to the daemon and get response
 */
export async function sendRequest(request: DaemonRequest): Promise<DaemonResponse> {
  const socket = await connectToDaemon();

  return new Promise((resolve, reject) => {
    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();

      // Check for complete message (newline-delimited)
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const message = buffer.slice(0, newlineIndex);
        socket.end();

        try {
          resolve(JSON.parse(message));
        } catch (err) {
          reject(new Error(`Invalid response from daemon: ${message}`));
        }
      }
    });

    socket.on('error', (err) => {
      reject(err);
    });

    socket.on('close', () => {
      if (!buffer.includes('\n')) {
        reject(new Error('Connection closed before receiving response'));
      }
    });

    // Send request
    socket.write(JSON.stringify(request) + '\n');
  });
}

/**
 * Execute a kOS command via daemon
 */
export async function execute(
  command: string,
  options: { timeout?: number; cpuId?: number; cpuLabel?: string } = {}
): Promise<DaemonResponse> {
  return sendRequest({
    type: 'execute',
    command,
    timeout: options.timeout,
    cpuId: options.cpuId,
    cpuLabel: options.cpuLabel,
  });
}

/**
 * Connect to kOS via daemon
 */
export async function connect(
  options: { cpuId?: number; cpuLabel?: string } = {}
): Promise<DaemonResponse> {
  return sendRequest({
    type: 'connect',
    cpuId: options.cpuId,
    cpuLabel: options.cpuLabel,
  });
}

/**
 * Disconnect from kOS via daemon
 */
export async function disconnect(): Promise<DaemonResponse> {
  return sendRequest({ type: 'disconnect' });
}

/**
 * Get daemon status
 */
export async function status(): Promise<DaemonResponse> {
  return sendRequest({ type: 'status' });
}

/**
 * Shutdown daemon
 */
export async function shutdown(): Promise<DaemonResponse> {
  if (!isDaemonRunning()) {
    return { success: true, output: 'Daemon not running' };
  }
  return sendRequest({ type: 'shutdown' });
}

/**
 * Ping daemon (for health checks)
 */
export async function ping(): Promise<DaemonResponse> {
  return sendRequest({ type: 'ping' });
}
