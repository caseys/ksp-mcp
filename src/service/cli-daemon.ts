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
import { config } from '../config/index.js';
import { SOCKET_PATH, PID_PATH, isWindows } from './daemon-paths.js';
import { clearNodes } from '../lib/programs/nodes.js';
import { getShipTelemetry } from '../lib/telemetry.js';
import { ManeuverOrchestrator } from '../lib/programs/orchestrator.js';
import { getOrbitInfo } from '../lib/telemetry.js';
import { ManeuverProgram } from '../lib/programs/maneuver.js';
import { executeNode, getNodeProgress } from '../lib/programs/node/index.js';
import { warpTo, warpForward, type WarpTarget } from '../lib/programs/warp.js';
import { quicksave, listQuicksaves, quickload } from '../lib/kuniverse.js';
import { matchPlane } from '../lib/programs/rendezvous/index.js';
import { changeSemiMajorAxis } from '../lib/programs/basic/index.js';
import { changeEccentricity, changeLAN, changeLongitudeOfPeriapsis } from '../lib/programs/orbital/index.js';
import { returnFromMoon, interplanetaryTransfer } from '../lib/programs/transfer/index.js';
import { crashAvoidance } from '../lib/programs/manual/index.js';
import { runScript } from '../lib/script/index.js';
import { getAscentProgress, abortAscent, AscentProgram } from '../lib/programs/ascent.js';
const IDLE_TIMEOUT_MS = 30_000; // 30 seconds

interface DaemonRequest {
  type: 'execute' | 'connect' | 'disconnect' | 'status' | 'shutdown' | 'ping' | 'call';
  command?: string;
  timeout?: number;
  cpuId?: number;
  cpuLabel?: string;
  handler?: string;
  args?: Record<string, unknown>;
}

interface DaemonResponse {
  success: boolean;
  output?: string;
  error?: string;
  connected?: boolean;
  vessel?: string;
  cpuId?: number;
  cpuTag?: string;
  data?: unknown;
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
      const oldPid = Number.parseInt(fs.readFileSync(PID_PATH, 'utf8').trim(), 10);
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
        } catch (error) {
          const response: DaemonResponse = {
            success: false,
            error: `Invalid request: ${error instanceof Error ? error.message : String(error)}`,
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
      case 'ping': {
        return { success: true, output: 'pong' };
      }

      case 'connect': {
        return this.handleConnect(request);
      }

      case 'disconnect': {
        return this.handleDisconnect();
      }

      case 'execute': {
        return this.handleExecute(request);
      }

      case 'call': {
        return this.handleCall(request);
      }

      case 'status': {
        return this.handleStatus();
      }

      case 'shutdown': {
        setTimeout(() => this.shutdown(), 100);
        return { success: true, output: 'Shutting down' };
      }

      default: {
        return { success: false, error: `Unknown request type: ${request.type}` };
      }
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
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
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
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
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
    } catch (error) {
      // Clear connection on error to enable auto-reconnect
      this.connection = null;
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
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

  private async handleCall(request: DaemonRequest): Promise<DaemonResponse> {
    if (!request.handler) {
      return { success: false, error: 'No handler provided' };
    }

    // Handler registry - maps handler names to functions
    // Each handler receives (connection, args) and returns a result
    const handlers: Record<
      string,
      (conn: KosConnection, args: Record<string, unknown>) => Promise<unknown>
    > = {
      // Raw kOS command execution
      execute: async (conn, args) => {
        const command = args.command as string;
        const timeout = (args.timeout as number) ?? config.timeouts.command;
        if (!command) {
          throw new Error('No command provided');
        }
        return conn.execute(command, timeout);
      },

      // Ship telemetry
      telemetry: async (conn, args) => {
        const options = args.options as Record<string, boolean> | undefined;
        return getShipTelemetry(conn, options);
      },

      // Clear maneuver nodes
      clearNodes: async (conn) => {
        return clearNodes(conn);
      },

      // Get orbit info
      orbitInfo: async (conn) => {
        return getOrbitInfo(conn);
      },

      // Circularize orbit
      circularize: async (conn, args) => {
        const timeRef = (args.timeRef as string) ?? 'APOAPSIS';
        const execute = (args.execute as boolean) ?? true;
        const target = args.target as string | undefined;
        const orchestrator = new ManeuverOrchestrator(conn);
        return orchestrator.circularize(timeRef, { target, execute });
      },

      // Adjust periapsis
      adjustPeriapsis: async (conn, args) => {
        const altitude = args.altitude as number;
        const timeRef = (args.timeRef as string) ?? 'APOAPSIS';
        const execute = (args.execute as boolean) ?? true;
        const target = args.target as string | undefined;
        if (altitude === undefined) throw new Error('altitude required');
        const orchestrator = new ManeuverOrchestrator(conn);
        return orchestrator.adjustPeriapsis(altitude, timeRef, { target, execute });
      },

      // Adjust apoapsis
      adjustApoapsis: async (conn, args) => {
        const altitude = args.altitude as number;
        const timeRef = (args.timeRef as string) ?? 'PERIAPSIS';
        const execute = (args.execute as boolean) ?? true;
        const target = args.target as string | undefined;
        if (altitude === undefined) throw new Error('altitude required');
        const orchestrator = new ManeuverOrchestrator(conn);
        return orchestrator.adjustApoapsis(altitude, timeRef, { target, execute });
      },

      // Ellipticize orbit
      ellipticize: async (conn, args) => {
        const periapsis = args.periapsis as number;
        const apoapsis = args.apoapsis as number;
        const timeRef = (args.timeRef as string) ?? 'APOAPSIS';
        const execute = (args.execute as boolean) ?? true;
        const target = args.target as string | undefined;
        if (periapsis === undefined || apoapsis === undefined) {
          throw new Error('periapsis and apoapsis required');
        }
        const orchestrator = new ManeuverOrchestrator(conn);
        return orchestrator.ellipticize(periapsis, apoapsis, timeRef, { target, execute });
      },

      // Hohmann transfer
      hohmannTransfer: async (conn, args) => {
        const timeRef = (args.timeRef as string) ?? 'COMPUTED';
        const capture = (args.capture as boolean) ?? false;
        const execute = (args.execute as boolean) ?? true;
        const target = args.target as string | undefined;
        const orchestrator = new ManeuverOrchestrator(conn);
        return orchestrator.hohmannTransfer(timeRef, capture, { target, execute });
      },

      // Course correction
      courseCorrection: async (conn, args) => {
        const targetDistance = args.targetDistance as number;
        const execute = (args.execute as boolean) ?? true;
        const target = args.target as string | undefined;
        if (targetDistance === undefined) throw new Error('targetDistance required');
        const orchestrator = new ManeuverOrchestrator(conn);
        return orchestrator.courseCorrection(targetDistance, { target, execute });
      },

      // Change inclination
      changeInclination: async (conn, args) => {
        const newInclination = args.newInclination as number;
        const timeRef = (args.timeRef as string) ?? 'EQ_NEAREST_AD';
        const execute = (args.execute as boolean) ?? true;
        const target = args.target as string | undefined;
        if (newInclination === undefined) throw new Error('newInclination required');
        const orchestrator = new ManeuverOrchestrator(conn);
        return orchestrator.changeInclination(newInclination, timeRef, { target, execute });
      },

      // Get target info
      getTarget: async (conn) => {
        const maneuver = new ManeuverProgram(conn);
        return maneuver.getTargetInfo();
      },

      // Set target
      setTarget: async (conn, args) => {
        const name = args.name as string;
        const type = (args.type as string) ?? 'auto';
        if (!name) throw new Error('name required');
        const maneuver = new ManeuverProgram(conn);
        return maneuver.setTarget(name, type as 'auto' | 'body' | 'vessel');
      },

      // Clear target
      clearTarget: async (conn) => {
        const maneuver = new ManeuverProgram(conn);
        return maneuver.clearTarget();
      },

      // Execute maneuver node
      executeNode: async (conn, args) => {
        const timeoutMs = (args.timeoutMs as number) ?? 240_000;
        const pollIntervalMs = (args.pollIntervalMs as number) ?? 5000;
        return executeNode(conn, { timeoutMs, pollIntervalMs });
      },

      // Get node progress
      getNodeProgress: async (conn) => {
        return getNodeProgress(conn);
      },

      // Warp to target
      warpTo: async (conn, args) => {
        const target = args.target as WarpTarget;
        const leadTime = (args.leadTime as number) ?? 60;
        if (!target) throw new Error('target required');
        return warpTo(conn, target, { leadTime });
      },

      // Warp forward by seconds
      warpForward: async (conn, args) => {
        const seconds = args.seconds as number;
        if (seconds === undefined) throw new Error('seconds required');
        return warpForward(conn, seconds);
      },

      // Quicksave
      quicksave: async (conn, args) => {
        const saveName = (args.saveName as string) ?? 'quicksave';
        return quicksave(conn, saveName);
      },

      // List saves
      listSaves: async (conn) => {
        return listQuicksaves(conn);
      },

      // Load save
      loadSave: async (conn, args) => {
        const saveName = args.saveName as string;
        if (!saveName) throw new Error('saveName required');
        return quickload(conn, saveName);
      },

      // Match planes with target
      matchPlanes: async (conn, args) => {
        const timeRef = (args.timeRef as string) ?? 'REL_NEAREST_AD';
        return matchPlane(conn, timeRef);
      },

      // Match velocities with target
      matchVelocities: async (conn, args) => {
        const timeRef = (args.timeRef as string) ?? 'CLOSEST_APPROACH';
        const execute = (args.execute as boolean) ?? true;
        const target = args.target as string | undefined;
        const orchestrator = new ManeuverOrchestrator(conn);
        return orchestrator.killRelVel(timeRef, { target, execute });
      },

      // Change semi-major axis
      changeSemiMajorAxis: async (conn, args) => {
        const semiMajorAxis = args.semiMajorAxis as number;
        const timeRef = (args.timeRef as string) ?? 'APOAPSIS';
        if (semiMajorAxis === undefined) throw new Error('semiMajorAxis required');
        return changeSemiMajorAxis(conn, semiMajorAxis, timeRef);
      },

      // Change eccentricity
      changeEccentricity: async (conn, args) => {
        const eccentricity = args.eccentricity as number;
        const timeRef = (args.timeRef as string) ?? 'APOAPSIS';
        if (eccentricity === undefined) throw new Error('eccentricity required');
        return changeEccentricity(conn, eccentricity, timeRef);
      },

      // Change ascending node (LAN)
      changeAscendingNode: async (conn, args) => {
        const lan = args.lan as number;
        const timeRef = (args.timeRef as string) ?? 'APOAPSIS';
        if (lan === undefined) throw new Error('lan required');
        return changeLAN(conn, lan, timeRef);
      },

      // Change periapsis longitude
      changePeriapsisLongitude: async (conn, args) => {
        const longitude = args.longitude as number;
        const timeRef = (args.timeRef as string) ?? 'APOAPSIS';
        if (longitude === undefined) throw new Error('longitude required');
        return changeLongitudeOfPeriapsis(conn, longitude, timeRef);
      },

      // Resonant orbit
      resonantOrbit: async (conn, args) => {
        const numerator = args.numerator as number;
        const denominator = args.denominator as number;
        const timeRef = (args.timeRef as string) ?? 'APOAPSIS';
        const execute = (args.execute as boolean) ?? true;
        const target = args.target as string | undefined;
        if (numerator === undefined || denominator === undefined) {
          throw new Error('numerator and denominator required');
        }
        const orchestrator = new ManeuverOrchestrator(conn);
        return orchestrator.resonantOrbit(numerator, denominator, timeRef, { target, execute });
      },

      // Return from moon to parent body
      returnFromMoon: async (conn, args) => {
        const targetPeriapsis = (args.targetPeriapsis as number) ?? 100_000;
        return returnFromMoon(conn, targetPeriapsis);
      },

      // Interplanetary transfer
      interplanetaryTransfer: async (conn, args) => {
        const waitForPhaseAngle = (args.waitForPhaseAngle as boolean) ?? true;
        return interplanetaryTransfer(conn, waitForPhaseAngle);
      },

      // Crash avoidance emergency burn
      crashAvoidance: async (conn, args) => {
        const targetPeriapsis = (args.targetPeriapsis as number) ?? 10_000;
        const timeoutMs = (args.timeoutMs as number) ?? 300_000;
        return crashAvoidance(conn, { targetPeriapsis, timeoutMs });
      },

      // Run kOS script file
      runScript: async (conn, args) => {
        const sourcePath = args.sourcePath as string;
        const timeout = (args.timeout as number) ?? 60_000;
        const cleanup = (args.cleanup as boolean) ?? true;
        if (!sourcePath) throw new Error('sourcePath required');
        return runScript(conn, sourcePath, { timeout, cleanup });
      },

      // Get ascent progress
      getAscentProgress: async (conn) => {
        return getAscentProgress(conn);
      },

      // Abort ascent guidance
      abortAscent: async (conn) => {
        await abortAscent(conn);
        return { success: true };
      },

      // Launch to orbit (blocking - waits for completion)
      launchAscent: async (conn, args) => {
        const altitude = (args.altitude as number) ?? 100_000;
        const inclination = (args.inclination as number) ?? 0;
        const autoStage = (args.autoStage as boolean) ?? true;
        const skipCircularization = (args.skipCircularization as boolean) ?? false;
        const autoWarp = (args.autoWarp as boolean) ?? true;

        const ascent = new AscentProgram(conn);
        const handle = await ascent.launchToOrbit({
          altitude,
          inclination,
          autoStage,
          skipCircularization,
          autoWarp,
        });
        return handle.waitForCompletion();
      },
    };

    const handler = handlers[request.handler];
    if (!handler) {
      return { success: false, error: `Unknown handler: ${request.handler}` };
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
      const result = await handler(this.connection!, request.args ?? {});

      // Check if connection was lost during execution
      if (!this.connection!.isConnected()) {
        this.connection = null;
      }

      return {
        success: true,
        data: result,
      };
    } catch (error) {
      // Clear connection on error to enable auto-reconnect
      this.connection = null;
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
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
daemon.start().catch((error) => {
  console.error(`[kos-daemon] Failed to start: ${error.message}`);
  process.exit(1);
});
