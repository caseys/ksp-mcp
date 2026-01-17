/**
 * MCP Status Script Generator
 *
 * Generates the kOS script that builds status data.
 * Called by mcp_status() function defined in daemon.
 *
 * Deployed to: 0:/boot/mcp_status.ks
 *
 * Usage:
 *   mcp_status().  // Function checks cache, calls RUNPATH if needed
 */

import { createHash } from 'node:crypto';

// Note: Generated kOS must have NO COMMENTS - they cause syntax errors when written via LOG.

/**
 * Generate the status script content.
 * Builds status data as a lexicon, serializes to JSON, and prints to terminal.
 * Caching is handled TypeScript-side in telemetry.ts (kOS GLOBAL vars don't persist across Ctrl+C).
 */
function generateStatusContent(version: string): string {
  return `@LAZYGLOBAL OFF.
IF NOT (DEFINED _MCP_ENV_READY) { RUNPATH("1:/boot/mcp_env", "boot"). }
LOCAL s IS LEXICON().
SET s["v"] TO "${version}".
SET s["soi"] TO SHIP:BODY:NAME.
SET s["soiParent"] TO CHOOSE "Sun" IF SHIP:BODY:NAME = "Sun" ELSE _MCP_BODIES[SHIP:BODY:NAME]["parent"].
SET s["apo"] TO CHOOSE -1 IF ORBIT:ECCENTRICITY >= 1 ELSE ROUND(APOAPSIS).
SET s["per"] TO ROUND(PERIAPSIS).
SET s["period"] TO CHOOSE -1 IF ORBIT:ECCENTRICITY >= 1 ELSE ROUND(ORBIT:PERIOD).
SET s["inc"] TO ROUND(ORBIT:INCLINATION,2).
SET s["ecc"] TO ROUND(ORBIT:ECCENTRICITY,4).
SET s["lan"] TO ROUND(ORBIT:LAN,2).
SET s["shipName"] TO _MCP_SHIPNAME.
SET s["shipType"] TO _MCP_SHIPTYPE.
SET s["status"] TO SHIP:STATUS.
SET s["alt"] TO ROUND(ALTITUDE).
SET s["lat"] TO ROUND(SHIP:LATITUDE,4).
SET s["lng"] TO ROUND(SHIP:LONGITUDE,4).
SET s["deltaV"] TO ROUND(SHIP:DELTAV:CURRENT).
SET s["speed"] TO ROUND(SHIP:VELOCITY:ORBIT:MAG).
SET s["hasNode"] TO HASNODE.
LOCAL _ndv IS 0. LOCAL _neta IS 0. LOCAL _nenc IS ORBIT:HASNEXTPATCH.
IF HASNODE { SET _ndv TO ROUND(NEXTNODE:DELTAV:MAG,1). SET _neta TO ROUND(NEXTNODE:ETA). SET _nenc TO NEXTNODE:ORBIT:HASNEXTPATCH. }
SET s["nodeDv"] TO _ndv.
SET s["nodeEta"] TO _neta.
SET s["nodeHasEnc"] TO _nenc.
SET s["hasNextPatch"] TO ORBIT:HASNEXTPATCH.
SET s["etaApo"] TO ROUND(ETA:APOAPSIS).
SET s["etaPer"] TO ROUND(ETA:PERIAPSIS).
SET s["etaTrans"] TO ROUND(ETA:TRANSITION).
SET s["atmHeight"] TO ROUND(_MCP_BODIES[SHIP:BODY:NAME]["atm"]).
SET s["hasAtm"] TO SHIP:BODY:ATM:EXISTS.
LOCAL _tti IS ADDONS:MJ:INFO:TIMETOIMPACT.
SET s["tti"] TO CHOOSE ROUND(_tti) IF _tti:TYPENAME = "Scalar" ELSE -1.
LOCAL _slope IS 0.
IF SHIP:STATUS = "LANDED" OR SHIP:STATUS = "SPLASHED" OR SHIP:STATUS = "PRELAUNCH" { SET _slope TO ROUND(ABS(90 - VANG(SHIP:UP:VECTOR, SHIP:FACING:TOPVECTOR)),1). }
SET s["slope"] TO _slope.
SET s["hasTarget"] TO HASTARGET.
LOCAL _encB IS "". LOCAL _encPe IS 0.
IF ORBIT:HASNEXTPATCH {
IF HASNODE AND NEXTNODE:ORBIT:HASNEXTPATCH { SET _encB TO NEXTNODE:ORBIT:NEXTPATCH:BODY:NAME. SET _encPe TO ROUND(NEXTNODE:ORBIT:NEXTPATCH:PERIAPSIS). }
ELSE { SET _encB TO ORBIT:NEXTPATCH:BODY:NAME. SET _encPe TO ROUND(ORBIT:NEXTPATCH:PERIAPSIS). }
}
SET s["encBody"] TO _encB.
SET s["encPe"] TO _encPe.
SET s["tgtName"] TO _MCP_TARGET.
SET s["tgtType"] TO _MCP_TARGETTYPE.
SET s["tgtDist"] TO CHOOSE ROUND(TARGET:DISTANCE) IF HASTARGET ELSE 0.
SET s["tgtParent"] TO _MCP_TARGETPARENT.
IF HASTARGET AND ADDONS:MJ:HASSUFFIX("TGT") {
SET s["caTime"] TO ADDONS:MJ:TGT:CLOSESTAPPROACHTIME.
SET s["caDist"] TO ADDONS:MJ:TGT:CLOSESTAPPROACHDISTANCE.
SET s["anTime"] TO ADDONS:MJ:TGT:TIMETOAN.
SET s["dnTime"] TO ADDONS:MJ:TGT:TIMETODN.
SET s["anEx"] TO ADDONS:MJ:TGT:ANEXISTS.
SET s["dnEx"] TO ADDONS:MJ:TGT:DNEXISTS.
SET s["relInc"] TO ADDONS:MJ:TGT:RELATIVEINCLINATION.
}
LOCAL QC IS CHAR(34).
LOCAL j IS "{".
FOR k IN s:KEYS {
IF s[k]:TYPENAME = "String" { SET j TO j+QC+k+QC+":"+QC+s[k]+QC+",". }
ELSE { SET j TO j+QC+k+QC+":"+s[k]+",". }
}
SET j TO j:SUBSTRING(0,j:LENGTH-1)+"}".
PRINT "STATUS_COMPACT:"+j.`;
}

// Compute version hash from canonical content
const CANONICAL_CONTENT = generateStatusContent('__VERSION__');
export const MCP_STATUS_VERSION = createHash('md5')
  .update(CANONICAL_CONTENT)
  .digest('hex')
  .slice(0, 8);

/**
 * Generate the status script content.
 * Deploy to: 0:/boot/mcp_status.ks
 */
export function generateMcpStatus(): string {
  return generateStatusContent(MCP_STATUS_VERSION);
}

/**
 * TypeScript interface for the status JSON data
 */
export interface StatusData {
  v: string;
  soi: string;
  soiParent: string;
  apo: number;
  per: number;
  period: number;
  inc: number;
  ecc: number;
  lan: number;
  shipName: string;
  shipType: string;
  status: string;
  alt: number;
  lat: number;
  lng: number;
  deltaV: number;
  speed: number;
  hasNode: boolean;
  nodeDv: number;
  nodeEta: number;
  nodeHasEnc: boolean;
  hasNextPatch: boolean;
  etaApo: number;
  etaPer: number;
  etaTrans: number;
  atmHeight: number;
  hasAtm: boolean;
  tti: number;
  slope: number;
  hasTarget: boolean;
  encBody: string;
  encPe: number;
  tgtName?: string;
  tgtType?: string;
  tgtDist?: number;
  tgtParent?: string;
  caTime?: number;
  caDist?: number;
  anTime?: number;
  dnTime?: number;
  anEx?: boolean;
  dnEx?: boolean;
  relInc?: number;
}
