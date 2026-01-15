/**
 * MCP Daemon Script Generator
 *
 * Generates the kOS boot script that provides autonomous blackout recovery.
 * This script IS the boot file - it runs on CPU startup, sets up WHEN triggers,
 * and stays alive to handle blackout conditions.
 *
 * When idle in blackout (no radio, no operation in progress), auto-warps to
 * the next radio contact window.
 *
 * Note: This is a boot file deployed to 0:/boot/mcp_daemon.ks
 */

import { createHash } from 'node:crypto';

// Note: Generated kOS must have NO COMMENTS - they cause syntax errors when written via LOG.

/**
 * Generate the daemon script content.
 *
 * The daemon runs in an UNTIL FALSE loop with WAIT 0 (yields every physics tick).
 * This blocks the terminal, but MCP commands use Ctrl+C to break the loop,
 * execute the command, then restart the daemon.
 *
 * Features:
 * - Heartbeat: Updates _MCP_HEARTBEAT every tick for health checks
 * - Blackout auto-warp: When idle in blackout, warps to radio contact
 * - Status tracking: _MCP_RADIO indicates current radio status
 */
function generateDaemonContent(version: string): string {
  return `@LAZYGLOBAL OFF.
WAIT UNTIL SHIP:UNPACKED.
IF DEFINED MCP_DAEMON_RUNNING AND MCP_DAEMON_RUNNING {
PRINT "[mcp-daemon] Already running.".
} ELSE {
GLOBAL MCP_DAEMON_RUNNING IS TRUE.
GLOBAL MCP_DAEMON_VERSION IS "${version}".
IF NOT (DEFINED _MCP_OP) { GLOBAL _MCP_OP IS "". }
GLOBAL _MCP_HEARTBEAT IS TIME:SECONDS.
GLOBAL _MCP_RADIO IS HOMECONNECTION:ISCONNECTED.
LOCAL lastCheck IS 0.
PRINT "[mcp-daemon] v" + MCP_DAEMON_VERSION + " active.".
UNTIL FALSE {
SET _MCP_HEARTBEAT TO TIME:SECONDS.
SET _MCP_RADIO TO HOMECONNECTION:ISCONNECTED.
IF TIME:SECONDS - lastCheck > 10 {
SET lastCheck TO TIME:SECONDS.
IF NOT _MCP_RADIO AND _MCP_OP = "" {
LOCAL sb IS SHIP:BODY.
LOCAL max_dt IS CHOOSE SHIP:ORBIT:PERIOD IF SHIP:STATUS = "ORBITING" ELSE sb:ROTATIONPERIOD.
LOCAL step IS MAX(30, max_dt / 60).
LOCAL dt IS step.
LOCAL wt IS -1.
UNTIL dt > max_dt {
LOCAL ut IS TIME:SECONDS + dt.
LOCAL fp IS POSITIONAT(SHIP, ut).
LOCAL uv IS (fp - sb:POSITION):NORMALIZED.
LOCAL kp IS POSITIONAT(BODY("Kerbin"), ut).
IF VANG(uv, kp - fp) < 72 {
SET wt TO dt.
BREAK.
}
SET dt TO dt + step.
}
IF wt > 0 {
PRINT "[mcp-daemon] Idle in blackout - warping " + ROUND(wt/60) + "m to radio...".
KUNIVERSE:TIMEWARP:WARPTO(TIME:SECONDS + wt).
WAIT UNTIL KUNIVERSE:TIMEWARP:ISSETTLED.
WAIT 2.
IF HOMECONNECTION:ISCONNECTED { PRINT "[mcp-daemon] Signal restored.". }
}
}
}
WAIT 0.
}
}`;
}

// Compute version hash from canonical content (with placeholder)
// This auto-updates when script content changes - no manual version bumps needed.
const CANONICAL_CONTENT = generateDaemonContent('__VERSION__');
export const MCP_DAEMON_VERSION = createHash('md5')
  .update(CANONICAL_CONTENT)
  .digest('hex')
  .slice(0, 8);

/**
 * Generate the daemon boot script content.
 * Deploy to: 0:/boot/mcp_daemon.ks
 */
export function generateMcpDaemon(): string {
  return generateDaemonContent(MCP_DAEMON_VERSION);
}
