/**
 * kOS Daemon - Persistent connection management
 *
 * Usage:
 *   import * as daemon from './daemon/index.js';
 *
 *   // Execute command (auto-connects if needed)
 *   const result = await daemon.execute('PRINT ALTITUDE.');
 *
 *   // Check status
 *   const status = await daemon.status();
 *
 *   // Shutdown daemon
 *   await daemon.shutdown();
 */

export {
  execute,
  connect,
  disconnect,
  status,
  shutdown,
  ping,
  call,
  isDaemonRunning,
  sendRequest,
  type DaemonRequest,
  type DaemonResponse,
} from './daemon-client.js';
