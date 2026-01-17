/**
 * MCP Environment Script Generator
 *
 * Generates the kOS script that caches static data in kOS global variables.
 * This is a parameterized script that handles different update modes:
 * - "boot": Full initialization of all cached data
 * - "soi_change": Refresh vessel list for new SOI
 * - "ship": Refresh ship name/type
 *
 * Deployed to: 0:/boot/mcp_env.ks
 * Runs fresh on each boot (no persistence file - simpler and bodies never change)
 *
 * Cached Variables:
 * - _MCP_SHIPNAME: SHIP:NAME
 * - _MCP_SHIPTYPE: SHIP:TYPE
 * - _MCP_BODIES: Lexicon of body properties (atm, radius, soi, mu, parent)
 * - _MCP_MOONS: List of moon names
 * - _MCP_PLANETS: List of planet names
 * - _MCP_SOI: Current body name
 * - _MCP_VESSELS: List of vessel names in current SOI
 * - _MCP_ENV_READY: Flag indicating env is initialized
 */

import { createHash } from 'node:crypto';

// Note: Generated kOS must have NO COMMENTS - they cause syntax errors when written via LOG.

/**
 * Generate the environment script content.
 */
function generateEnvContent(version: string): string {
  return `@LAZYGLOBAL OFF.
PARAMETER mode IS "boot".
IF mode = "boot" OR NOT (DEFINED _MCP_BODIES) {
PRINT "[mcp-env] v${version} Full initialization...".
GLOBAL _MCP_SHIPNAME IS SHIP:NAME.
GLOBAL _MCP_SHIPTYPE IS SHIP:TYPE.
GLOBAL _MCP_BODIES IS LEXICON().
GLOBAL _MCP_MOONS IS LIST().
GLOBAL _MCP_PLANETS IS LIST().
LOCAL _blist IS LIST().
LIST BODIES IN _blist.
FOR b IN _blist {
IF b:NAME <> "Sun" {
SET _MCP_BODIES[b:NAME] TO LEXICON(
"atm", CHOOSE b:ATM:HEIGHT IF b:ATM:EXISTS ELSE 0,
"radius", b:RADIUS,
"soi", b:SOIRADIUS,
"mu", b:MU,
"parent", b:BODY:NAME
).
IF b:BODY:NAME = "Sun" { _MCP_PLANETS:ADD(b:NAME). }
ELSE { _MCP_MOONS:ADD(b:NAME). }
}
}
GLOBAL _MCP_ENV_READY IS TRUE.
PRINT "[mcp-env] Done. " + _MCP_BODIES:LENGTH + " bodies cached.".
}
IF mode = "boot" OR mode = "soi_change" {
PRINT "[mcp-env] Updating SOI data...".
IF DEFINED _MCP_SOI { SET _MCP_SOI TO SHIP:BODY:NAME. }
ELSE { GLOBAL _MCP_SOI IS SHIP:BODY:NAME. }
IF DEFINED _MCP_VESSELS { SET _MCP_VESSELS TO LIST(). }
ELSE { GLOBAL _MCP_VESSELS IS LIST(). }
LOCAL _tgts IS LIST().
LIST TARGETS IN _tgts.
FOR t IN _tgts {
IF t <> SHIP AND t:BODY = SHIP:BODY { _MCP_VESSELS:ADD(t:NAME). }
}
PRINT "[mcp-env] SOI: " + _MCP_SOI + ", " + _MCP_VESSELS:LENGTH + " vessels.".
}
IF mode = "ship" {
PRINT "[mcp-env] Updating ship info...".
SET _MCP_SHIPNAME TO SHIP:NAME.
SET _MCP_SHIPTYPE TO SHIP:TYPE.
}
IF mode = "boot" OR mode = "target" {
IF DEFINED _MCP_TARGET { SET _MCP_TARGET TO "". }
ELSE { GLOBAL _MCP_TARGET IS "". }
IF DEFINED _MCP_TARGETTYPE { SET _MCP_TARGETTYPE TO "". }
ELSE { GLOBAL _MCP_TARGETTYPE IS "". }
IF DEFINED _MCP_TARGETPARENT { SET _MCP_TARGETPARENT TO "". }
ELSE { GLOBAL _MCP_TARGETPARENT IS "". }
IF HASTARGET {
SET _MCP_TARGET TO TARGET:NAME.
SET _MCP_TARGETTYPE TO TARGET:TYPENAME.
IF TARGET:TYPENAME = "Body" AND _MCP_BODIES:HASKEY(TARGET:NAME) {
SET _MCP_TARGETPARENT TO _MCP_BODIES[TARGET:NAME]["parent"].
}
}
IF mode = "target" { PRINT "[mcp-env] Target: " + _MCP_TARGET. }
}`;
}

// Compute version hash from canonical content
const CANONICAL_CONTENT = generateEnvContent('__VERSION__');
export const MCP_ENV_VERSION = createHash('md5')
  .update(CANONICAL_CONTENT)
  .digest('hex')
  .slice(0, 8);

/**
 * Generate the environment script content.
 * Deploy to: 0:/boot/mcp_env.ks
 */
export function generateMcpEnv(): string {
  return generateEnvContent(MCP_ENV_VERSION);
}
