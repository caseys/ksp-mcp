/**
 * Central configuration for ksp-mcp
 *
 * Loads environment variables from .env file (if present) and provides
 * typed defaults for all configurable values.
 *
 * Usage:
 *   import { config } from './config.js';
 *   const conn = new KosConnection({
 *     host: config.kos.host,
 *     port: config.kos.port,
 *   });
 */
import { config as loadDotenv } from 'dotenv';

// Load .env file (no-op if doesn't exist, quiet suppresses promotional message)
loadDotenv({ quiet: true });

export const config = Object.freeze({
  // kOS connection defaults
  kos: {
    host: process.env.KOS_HOST ?? '127.0.0.1',
    port: parseInt(process.env.KOS_PORT ?? '5410', 10),
    /**
     * CPU ID to connect to.
     * - null: Auto-select first available CPU from menu
     * - number: Connect to specific CPU by ID
     */
    cpuId: process.env.KOS_CPU_ID ? parseInt(process.env.KOS_CPU_ID, 10) : null,
    /**
     * CPU label to connect to (e.g., 'guidance', 'flight').
     * If set, takes precedence over cpuId.
     */
    cpuLabel: process.env.KOS_CPU_LABEL || undefined,
  },

  // Transport configuration
  transport: {
    /**
     * Transport type:
     * - 'socket': Node.js net.Socket (default, recommended - no external deps)
     * - 'tmux': tmux session with nc (requires tmux + nc)
     */
    type: (process.env.KOS_TRANSPORT ?? 'socket') as 'socket' | 'tmux',
    /** Tmux session name when using tmux transport */
    tmuxSession: process.env.KOS_TMUX_SESSION ?? 'ksp-mcp-kos',
  },

  // Timeout defaults (milliseconds)
  timeouts: {
    /** Timeout for initial socket connection */
    connect: parseInt(process.env.KOS_TIMEOUT_CONNECT ?? '10000', 10),
    /** Timeout waiting for CPU menu to appear */
    cpuMenu: parseInt(process.env.KOS_TIMEOUT_CPU_MENU ?? '5000', 10),
    /** Timeout waiting for REBOOT response */
    reboot: parseInt(process.env.KOS_TIMEOUT_REBOOT ?? '8000', 10),
    /** Timeout waiting for "Proceed" message */
    proceed: parseInt(process.env.KOS_TIMEOUT_PROCEED ?? '3000', 10),
    /** Default timeout for command execution */
    command: parseInt(process.env.KOS_TIMEOUT_COMMAND ?? '30000', 10),
    /** Delay after telnet connection */
    connectDelay: parseInt(process.env.KOS_DELAY_CONNECT ?? '500', 10),
    /** Delay after disconnect */
    disconnectDelay: parseInt(process.env.KOS_DELAY_DISCONNECT ?? '200', 10),
  },
});

export type Config = typeof config;
