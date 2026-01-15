/**
 * MCP Daemon Script Generator
 *
 * Generates the kOS boot script that provides autonomous blackout recovery.
 * This is a self-installing boot program that:
 * 1. Runs from archive (0:/boot/) on first execution
 * 2. Copies itself to local volume (1:/boot/)
 * 3. Reboots the CPU
 * 4. Thereafter runs from local, surviving radio blackouts
 *
 * When idle in blackout (no radio, no operation in progress), auto-warps to
 * the next radio contact window.
 *
 * Deployed to: 0:/boot/mcp_daemon.ks (archive)
 * Self-installs to: 1:/boot/mcp_daemon.ks (local)
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
LOCAL lp IS "1:/boot/mcp_daemon.ks".
LOCAL ap IS "0:/boot/mcp_daemon.ks".
LOCAL needsInstall IS FALSE.
IF NOT EXISTS(lp) {
SET needsInstall TO TRUE.
PRINT "[mcp-daemon] Installing locally...".
} ELSE IF DEFINED MCP_DAEMON_VERSION AND MCP_DAEMON_VERSION <> "${version}" {
SET needsInstall TO TRUE.
PRINT "[mcp-daemon] Updating mcp_daemon: " + MCP_DAEMON_VERSION + " -> ${version}...".
} ELSE IF NOT (DEFINED MCP_DAEMON_VERSION) {
SET needsInstall TO TRUE.
PRINT "[mcp-daemon] Version unknown, reinstalling...".
}
IF needsInstall {
IF NOT EXISTS("1:/boot") { CREATEDIR("1:/boot"). }
COPYPATH(ap, lp).
PRINT "[mcp-daemon] Rebooting...".
WAIT 1.
REBOOT.
}
IF DEFINED MCP_DAEMON_RUNNING AND MCP_DAEMON_RUNNING {
PRINT "[mcp-daemon] Already running.".
} ELSE {
GLOBAL MCP_DAEMON_RUNNING IS TRUE.
GLOBAL MCP_DAEMON_VERSION IS "${version}".
IF NOT (DEFINED _MCP_OP) { GLOBAL _MCP_OP IS "". }
GLOBAL _MCP_HEARTBEAT IS TIME:SECONDS.
GLOBAL _MCP_RADIO IS HOMECONNECTION:ISCONNECTED.
LOCAL lastCheck IS 0.
LOCAL lastHdg IS V(0,0,0).
LOCAL stallCooldown IS 0.
LOCAL wasLanding IS FALSE.
PRINT "[mcp-daemon] v" + MCP_DAEMON_VERSION + " active.".
UNTIL FALSE {
SET _MCP_HEARTBEAT TO TIME:SECONDS.
SET _MCP_RADIO TO HOMECONNECTION:ISCONNECTED.
IF _MCP_OP:STARTSWITH("landing") {
SET wasLanding TO TRUE.
}
IF wasLanding AND (SHIP:STATUS = "LANDED" OR SHIP:STATUS = "SPLASHED") {
PRINT "[mcp-daemon] Touchdown - stabilizing...".
SAS ON.
WAIT 0.3.
SET SASMODE TO "RADIALOUT".
SET wasLanding TO FALSE.
SET _MCP_OP TO "".
}
IF _MCP_OP:STARTSWITH("landing") AND SHIP:STATUS <> "LANDED" AND SHIP:STATUS <> "SPLASHED" {
LOCAL rAlt IS ALT:RADAR.
LOCAL vel IS SHIP:VERTICALSPEED.
LOCAL hdg IS SHIP:FACING:FOREVECTOR.
LOCAL hdgChg IS VANG(hdg, lastHdg).
SET lastHdg TO hdg.
IF rAlt < 250 AND vel > -0.5 AND hdgChg > 8 AND TIME:SECONDS > stallCooldown {
PRINT "[mcp-daemon] Landing stall detected (alt=" + ROUND(rAlt) + "m, vel=" + ROUND(vel,1) + ", spin=" + ROUND(hdgChg) + "deg)".
SET stallCooldown TO TIME:SECONDS + 10.
SET LAND TO ADDONS:MJ:LANDING.
SET LAND:ENABLED TO FALSE.
SAS ON.
WAIT 0.5.
SET SASMODE TO "STABILITYASSIST".
PRINT "[mcp-daemon] Stabilizing, waiting for 7m/s descent...".
LOCAL waitStart IS TIME:SECONDS.
UNTIL SHIP:VERTICALSPEED < -7 OR SHIP:STATUS = "LANDED" OR SHIP:STATUS = "SPLASHED" OR TIME:SECONDS > waitStart + 15 {
WAIT 0.2.
}
IF SHIP:STATUS <> "LANDED" AND SHIP:STATUS <> "SPLASHED" {
PRINT "[mcp-daemon] Re-enabling landing (vel=" + ROUND(SHIP:VERTICALSPEED,1) + ")".
SAS OFF.
LAND:LANDUNTARGETED().
WAIT 0.5.
IF NOT LAND:ENABLED {
PRINT "[mcp-daemon] MechJeb rejected, holding radial out...".
SAS ON.
RCS ON.
WAIT 0.3.
SET SASMODE TO "RADIALOUT".
}
}
}
}
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
