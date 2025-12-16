/**
 * ksp-mcp Public API
 *
 * This module exports all public APIs for use as a library.
 *
 * @example
 * ```typescript
 * import { KosConnection, config } from 'ksp-mcp';
 *
 * const conn = new KosConnection();
 * await conn.connect();
 * const result = await conn.execute('PRINT "Hello".');
 * await conn.disconnect();
 * ```
 */

// =============================================================================
// Core Connection
// =============================================================================

export { KosConnection } from './transport/kos-connection.js';
export type {
  ConnectionState,
  CommandResult,
  KosConnectionOptions,
} from './transport/kos-connection.js';

// =============================================================================
// Transport Layer
// =============================================================================

export type { Transport } from './transport/transport.js';
export { BaseTransport } from './transport/transport.js';
export { SocketTransport } from './transport/socket-transport.js';
export { TmuxTransport } from './transport/tmux-transport.js';

// =============================================================================
// MechJeb Interface
// =============================================================================

export * from './mechjeb/index.js';

// =============================================================================
// Configuration
// =============================================================================

export { config } from './config.js';
export type { Config } from './config.js';

// =============================================================================
// MCP Server
// =============================================================================

export { createServer } from './server.js';

// =============================================================================
// Tool Handlers (for direct use without MCP)
// =============================================================================

export { handleListCpus } from './transport/list-cpus.js';
export type { CpuInfo } from './transport/list-cpus.js';

export {
  handleConnect,
  handleDisconnect,
  handleExecute,
  handleStatus,
  getConnection,
  ensureConnected,
  waitForKosReady,
  isKosReady,
} from './transport/connection-tools.js';
export type { EnsureConnectedOptions, WaitForKosOptions } from './transport/connection-tools.js';

// =============================================================================
// Monitoring
// =============================================================================

export { KosMonitor, globalKosMonitor } from './utils/kos-monitor.js';
export type { MonitorStatus, LoopDetection } from './utils/kos-monitor.js';

// =============================================================================
// KUNIVERSE (Save/Load, Game State)
// =============================================================================

export {
  listQuicksaves,
  quicksave,
  quickload,
  canQuicksave,
} from './kuniverse.js';
export type {
  QuicksaveResult,
  QuickloadResult,
  ListSavesResult,
} from './kuniverse.js';
