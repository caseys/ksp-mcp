/**
 * MCP Landing Script Generator
 *
 * Generates the kOS script for landing stall detection and recovery.
 * Loaded on-demand by mcp_daemon when _MCP_OP starts with "landing".
 *
 * Deployed to: 0:/boot/mcp_landing.ks
 *
 * This script monitors the landing and:
 * - Detects stall conditions (low altitude, low velocity, spinning)
 * - Disables MechJeb landing, enables SAS
 * - Waits for descent velocity, then re-enables MechJeb
 * - Handles touchdown stabilization
 */

import { createHash } from 'node:crypto';

// Note: Generated kOS must have NO COMMENTS - they cause syntax errors when written via LOG.

/**
 * Generate the landing monitor script content.
 */
function generateLandingContent(version: string): string {
  return `@LAZYGLOBAL OFF.
LOCAL lastHdg IS V(0,0,0).
LOCAL stallCooldown IS 0.
LOCAL LAND IS ADDONS:MJ:LANDING.
PRINT "[mcp-landing] v${version} Monitoring active...".
UNTIL SHIP:STATUS = "LANDED" OR SHIP:STATUS = "SPLASHED" OR NOT _MCP_OP:STARTSWITH("landing") {
LOCAL rAlt IS ALT:RADAR.
LOCAL vel IS SHIP:VERTICALSPEED.
LOCAL hdg IS SHIP:FACING:FOREVECTOR.
LOCAL hdgChg IS VANG(hdg, lastHdg).
SET lastHdg TO hdg.
IF rAlt < 250 AND vel > -0.5 AND hdgChg > 8 AND TIME:SECONDS > stallCooldown {
PRINT "[mcp-landing] Stall detected (alt=" + ROUND(rAlt) + "m, vel=" + ROUND(vel,1) + ", spin=" + ROUND(hdgChg) + "deg)".
SET stallCooldown TO TIME:SECONDS + 10.
SET LAND:ENABLED TO FALSE.
SAS ON.
WAIT 0.5.
SET SASMODE TO "STABILITYASSIST".
PRINT "[mcp-landing] Stabilizing, waiting for 7m/s descent...".
LOCAL waitStart IS TIME:SECONDS.
UNTIL SHIP:VERTICALSPEED < -7 OR SHIP:STATUS = "LANDED" OR SHIP:STATUS = "SPLASHED" OR TIME:SECONDS > waitStart + 15 {
WAIT 0.2.
}
IF SHIP:STATUS <> "LANDED" AND SHIP:STATUS <> "SPLASHED" {
PRINT "[mcp-landing] Re-enabling landing (vel=" + ROUND(SHIP:VERTICALSPEED,1) + ")".
SAS OFF.
LAND:LANDUNTARGETED().
WAIT 0.5.
IF NOT LAND:ENABLED {
PRINT "[mcp-landing] MechJeb rejected, holding radial out...".
SAS ON.
RCS ON.
WAIT 0.3.
SET SASMODE TO "RADIALOUT".
}
}
}
WAIT 5.
}
IF SHIP:STATUS = "LANDED" OR SHIP:STATUS = "SPLASHED" {
PRINT "[mcp-landing] Touchdown - stabilizing...".
SAS ON.
WAIT 0.3.
SET SASMODE TO "RADIALOUT".
SET _MCP_OP TO "".
PRINT "[mcp-landing] Landing complete.".
}`;
}

// Compute version hash from canonical content
const CANONICAL_CONTENT = generateLandingContent('__VERSION__');
export const MCP_LANDING_VERSION = createHash('md5')
  .update(CANONICAL_CONTENT)
  .digest('hex')
  .slice(0, 8);

/**
 * Generate the landing monitor script content.
 * Deploy to: 0:/boot/mcp_landing.ks
 */
export function generateMcpLanding(): string {
  return generateLandingContent(MCP_LANDING_VERSION);
}
