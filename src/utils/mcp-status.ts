/**
 * MCP Status Types
 *
 * TypeScript interfaces for the status JSON data returned by mcp_status.ks.
 *
 * The actual kOS script is now in src/lib/kos/script/mcp-status.ks
 * and is deployed via kos-scripts.ts.
 */

/**
 * Target entry in the targets list
 */
export interface TargetEntry {
  type: 'moon' | 'planet' | 'vessel';
  name: string;
  distance: number;
}

/**
 * TypeScript interface for the status JSON data
 */
export interface StatusData {
  v: string;
  op: string;
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
  encDist: number;
  encAtmH: number;
  encPeTime: number;
  tgtName: string;
  tgtType: string;
  tgtDist: number;
  tgtParent: string;
  caTime?: number;
  caDist?: number;
  anTime?: number;
  dnTime?: number;
  anEx?: boolean;
  dnEx?: boolean;
  relInc?: number;
  /** Available targets (moons, planets, vessels) sorted by distance */
  targets: TargetEntry[];
}
