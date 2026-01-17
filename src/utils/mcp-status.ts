/**
 * MCP Status Script Generator
 *
 * Generates the kOS script that handles status queries.
 * Uses JSON serialization for clean data transfer.
 *
 * Deployed to: 0:/boot/mcp_status.ks
 *
 * Usage:
 *   RUNPATH("0:/boot/mcp_status.ks").  // Returns JSON with all status data
 */

import { createHash } from 'node:crypto';

// Note: Generated kOS must have NO COMMENTS - they cause syntax errors when written via LOG.

/**
 * Generate the status script content.
 * Builds a lexicon with all status data, serializes to JSON, prints it.
 */
function generateStatusContent(version: string): string {
  // Build JSON manually and print to terminal (avoids disk I/O overhead)
  // Use cached target info from _MCP_TARGET* globals
  return `@LAZYGLOBAL OFF.
IF NOT (DEFINED _MCP_ENV_READY) { RUNPATH("1:/boot/mcp_env", "boot"). }
LOCAL QC IS CHAR(34).
LOCAL j IS "{".
SET j TO j + QC+"v"+QC+":"+QC+"${version}"+QC+",".
SET j TO j + QC+"soi"+QC+":"+QC+SHIP:BODY:NAME+QC+",".
SET j TO j + QC+"soiParent"+QC+":"+QC+(CHOOSE "Sun" IF SHIP:BODY:NAME = "Sun" ELSE _MCP_BODIES[SHIP:BODY:NAME]["parent"])+QC+",".
SET j TO j + QC+"apo"+QC+":"+(CHOOSE -1 IF ORBIT:ECCENTRICITY >= 1 ELSE ROUND(APOAPSIS))+",".
SET j TO j + QC+"per"+QC+":"+ROUND(PERIAPSIS)+",".
SET j TO j + QC+"period"+QC+":"+(CHOOSE -1 IF ORBIT:ECCENTRICITY >= 1 ELSE ROUND(ORBIT:PERIOD))+",".
SET j TO j + QC+"inc"+QC+":"+ROUND(ORBIT:INCLINATION,2)+",".
SET j TO j + QC+"ecc"+QC+":"+ROUND(ORBIT:ECCENTRICITY,4)+",".
SET j TO j + QC+"lan"+QC+":"+ROUND(ORBIT:LAN,2)+",".
SET j TO j + QC+"shipName"+QC+":"+QC+_MCP_SHIPNAME+QC+",".
SET j TO j + QC+"shipType"+QC+":"+QC+_MCP_SHIPTYPE+QC+",".
SET j TO j + QC+"status"+QC+":"+QC+SHIP:STATUS+QC+",".
SET j TO j + QC+"alt"+QC+":"+ROUND(ALTITUDE)+",".
SET j TO j + QC+"lat"+QC+":"+ROUND(SHIP:LATITUDE,4)+",".
SET j TO j + QC+"lng"+QC+":"+ROUND(SHIP:LONGITUDE,4)+",".
SET j TO j + QC+"deltaV"+QC+":"+ROUND(SHIP:DELTAV:CURRENT)+",".
SET j TO j + QC+"speed"+QC+":"+ROUND(SHIP:VELOCITY:ORBIT:MAG)+",".
SET j TO j + QC+"hasNode"+QC+":"+HASNODE+",".
LOCAL _ndv IS 0. LOCAL _neta IS 0. LOCAL _nenc IS ORBIT:HASNEXTPATCH.
IF HASNODE { SET _ndv TO ROUND(NEXTNODE:DELTAV:MAG,1). SET _neta TO ROUND(NEXTNODE:ETA). SET _nenc TO NEXTNODE:ORBIT:HASNEXTPATCH. }
SET j TO j + QC+"nodeDv"+QC+":"+_ndv+",".
SET j TO j + QC+"nodeEta"+QC+":"+_neta+",".
SET j TO j + QC+"nodeHasEnc"+QC+":"+_nenc+",".
SET j TO j + QC+"hasNextPatch"+QC+":"+ORBIT:HASNEXTPATCH+",".
SET j TO j + QC+"etaApo"+QC+":"+ROUND(ETA:APOAPSIS)+",".
SET j TO j + QC+"etaPer"+QC+":"+ROUND(ETA:PERIAPSIS)+",".
SET j TO j + QC+"etaTrans"+QC+":"+ROUND(ETA:TRANSITION)+",".
SET j TO j + QC+"atmHeight"+QC+":"+ROUND(_MCP_BODIES[SHIP:BODY:NAME]["atm"])+",".
SET j TO j + QC+"hasAtm"+QC+":"+SHIP:BODY:ATM:EXISTS+",".
LOCAL _tti IS ADDONS:MJ:INFO:TIMETOIMPACT.
SET j TO j + QC+"tti"+QC+":"+(CHOOSE ROUND(_tti) IF _tti:TYPENAME = "Scalar" ELSE -1)+",".
LOCAL _slope IS 0.
IF SHIP:STATUS = "LANDED" OR SHIP:STATUS = "SPLASHED" OR SHIP:STATUS = "PRELAUNCH" { SET _slope TO ROUND(ABS(90 - VANG(SHIP:UP:VECTOR, SHIP:FACING:TOPVECTOR)),1). }
SET j TO j + QC+"slope"+QC+":"+_slope+",".
SET j TO j + QC+"hasTarget"+QC+":"+HASTARGET+",".
LOCAL _encB IS "". LOCAL _encPe IS 0.
IF ORBIT:HASNEXTPATCH {
IF HASNODE AND NEXTNODE:ORBIT:HASNEXTPATCH { SET _encB TO NEXTNODE:ORBIT:NEXTPATCH:BODY:NAME. SET _encPe TO ROUND(NEXTNODE:ORBIT:NEXTPATCH:PERIAPSIS). }
ELSE { SET _encB TO ORBIT:NEXTPATCH:BODY:NAME. SET _encPe TO ROUND(ORBIT:NEXTPATCH:PERIAPSIS). }
}
SET j TO j + QC+"encBody"+QC+":"+QC+_encB+QC+",".
SET j TO j + QC+"encPe"+QC+":"+_encPe+",".
SET j TO j + QC+"tgtName"+QC+":"+QC+_MCP_TARGET+QC+",".
SET j TO j + QC+"tgtType"+QC+":"+QC+_MCP_TARGETTYPE+QC+",".
SET j TO j + QC+"tgtDist"+QC+":"+(CHOOSE ROUND(TARGET:DISTANCE) IF HASTARGET ELSE 0)+",".
SET j TO j + QC+"tgtParent"+QC+":"+QC+_MCP_TARGETPARENT+QC.
IF HASTARGET AND ADDONS:MJ:HASSUFFIX("TGT") {
SET j TO j + ","+QC+"caTime"+QC+":"+ADDONS:MJ:TGT:CLOSESTAPPROACHTIME.
SET j TO j + ","+QC+"caDist"+QC+":"+ADDONS:MJ:TGT:CLOSESTAPPROACHDISTANCE.
SET j TO j + ","+QC+"anTime"+QC+":"+ADDONS:MJ:TGT:TIMETOAN.
SET j TO j + ","+QC+"dnTime"+QC+":"+ADDONS:MJ:TGT:TIMETODN.
SET j TO j + ","+QC+"anEx"+QC+":"+ADDONS:MJ:TGT:ANEXISTS.
SET j TO j + ","+QC+"dnEx"+QC+":"+ADDONS:MJ:TGT:DNEXISTS.
SET j TO j + ","+QC+"relInc"+QC+":"+ADDONS:MJ:TGT:RELATIVEINCLINATION.
}
SET j TO j + "}".
PRINT "STATUS_JSON:" + j.
SET j TO "".
WAIT 0.`;
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
