/**
 * Platform-aware paths for the kOS daemon
 *
 * On Unix (macOS/Linux): Uses Unix domain sockets at os.tmpdir()
 * On Windows: Uses named pipes at \\.\pipe\
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isWindows = process.platform === 'win32';

/**
 * Socket/pipe path for daemon communication
 * - Unix: /tmp/kos-daemon.sock (or os.tmpdir())
 * - Windows: \\.\pipe\kos-daemon
 */
export const SOCKET_PATH = isWindows
  ? '\\\\.\\pipe\\kos-daemon'
  : join(tmpdir(), 'kos-daemon.sock');

/**
 * PID file path for daemon process tracking
 * - Unix: /tmp/kos-daemon.pid (or os.tmpdir())
 * - Windows: %TEMP%\kos-daemon.pid
 */
export const PID_PATH = join(tmpdir(), 'kos-daemon.pid');

/**
 * Check if running on Windows
 */
export { isWindows };
