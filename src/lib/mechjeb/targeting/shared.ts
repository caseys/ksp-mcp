/**
 * Shared utilities for MechJeb targeting operations
 *
 * These provide access to MechJeb's target controller for:
 * - Position targeting (lat/lng for landing)
 * - Rendezvous calculations (phase angle, closest approach)
 * - Target orbital info
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { formatTime, formatOrbit, fmtVel } from '../../utils/format.js';

function formatDistance(meters: number): string {
  if (meters < 1000) return `${meters.toFixed(0)} m`;
  if (meters < 1_000_000) return `${(meters / 1000).toFixed(1)} km`;
  return `${(meters / 1_000_000).toFixed(2)} Mm`;
}

function formatPeriod(s: number): string {
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${(s / 86_400).toFixed(2)} days`;
}

// ============================================================================
// Types
// ============================================================================

/**
 * Result of setting a position target
 */
export interface SetPositionTargetResult {
  success: boolean;
  latitude?: number;
  longitude?: number;
  body?: string;
  error?: string;
}

/**
 * Rendezvous calculation info from MechJeb target controller
 */
export interface RendezvousInfo {
  targetName: string;
  targetType: 'body' | 'vessel';
  phaseAngle: number;            // degrees
  relativeInclination: number;   // degrees
  closestApproachTime: number;   // seconds from now
  closestApproachDistance: number; // meters
  timeToAN: number | null;       // seconds (null if no AN exists)
  timeToDN: number | null;       // seconds (null if no DN exists)
  anExists: boolean;
  dnExists: boolean;
  formatted: string;             // Human-readable summary
}

/**
 * Target orbital elements from MechJeb
 */
export interface TargetOrbitInfo {
  name: string;
  apoapsis: number;      // meters
  periapsis: number;     // meters
  inclination: number;   // degrees
  eccentricity: number;
  period: number;        // seconds
  sma: number;           // meters (semi-major axis)
  lan: number;           // degrees (longitude of ascending node)
  formatted: string;
}

/**
 * Target relative position and velocity
 */
export interface TargetPositionInfo {
  name: string;
  distance: number;       // meters
  relVelocity: { x: number; y: number; z: number }; // m/s vector
  relVelocityMag: number; // m/s magnitude
  relPosition: { x: number; y: number; z: number }; // meters vector
  canAlign: boolean;      // true if docking alignment supported
  dockingAxis?: { x: number; y: number; z: number }; // direction for docking
  formatted: string;
}

/**
 * Basic target info
 */
export interface MjTargetBasicInfo {
  name: string;
  type: 'body' | 'vessel' | 'position' | 'none';
  body?: string;  // For position targets, the body it's on
}

// ============================================================================
// Target Existence Checks
// ============================================================================

/**
 * Check if MechJeb has any target set (normal body/vessel or position)
 */
export async function hasMjTarget(conn: KosConnection): Promise<{
  hasNormal: boolean;
  hasPosition: boolean;
}> {
  const result = await conn.queue(
    'SET TGT TO ADDONS:MJ:TARGET. PRINT TGT:NORMALTARGETEXISTS + "|" + TGT:POSITIONTARGETEXISTS.',
    3000
  );

  const match = result.success ? result.output.match(/(True|False)\|(True|False)/i) : null;
  if (!match) {
    return { hasNormal: false, hasPosition: false };
  }

  return {
    hasNormal: match[1].toLowerCase() === 'true',
    hasPosition: match[2].toLowerCase() === 'true',
  };
}

/**
 * Get basic info about the current MechJeb target
 */
export async function getMjTargetBasicInfo(conn: KosConnection): Promise<MjTargetBasicInfo | null> {
  const { hasNormal, hasPosition } = await hasMjTarget(conn);

  if (!hasNormal && !hasPosition) {
    return null;
  }

  if (hasPosition) {
    // Position target - get lat/lng and body
    const result = await conn.queue(
      'SET TGT TO ADDONS:MJ:TARGET. PRINT "POS|" + TGT:TARGETLATITUDE + "|" + TGT:TARGETLONGITUDE + "|" + TGT:TARGETBODY.',
      3000
    );
    const match = result.success ? result.output.match(/POS\|([^|]+)\|([^|]+)\|(.+)/) : null;
    if (match) {
      const lat = Number.parseFloat(match[1]);
      const lng = Number.parseFloat(match[2]);
      const body = match[3].trim();
      return {
        name: `${lat.toFixed(2)}°, ${lng.toFixed(2)}°`,
        type: 'position',
        body,
      };
    }
  }

  if (hasNormal) {
    // Normal target (body or vessel)
    const result = await conn.queue(
      'PRINT TARGET:NAME + "|" + TARGET:TYPENAME.',
      3000
    );
    const match = result.success ? result.output.match(/([^|]+)\|(\w+)/) : null;
    if (match) {
      const name = match[1].trim();
      const typeName = match[2].toLowerCase();
      return {
        name,
        type: typeName === 'body' ? 'body' : 'vessel',
      };
    }
  }

  return null;
}

// ============================================================================
// Position Target Operations
// ============================================================================

/**
 * Set a position target at specific coordinates on the current body
 */
export async function setPositionTarget(
  conn: KosConnection,
  latitude: number,
  longitude: number
): Promise<SetPositionTargetResult> {
  // Validate inputs
  if (latitude < -90 || latitude > 90) {
    return { success: false, error: 'Latitude must be between -90 and 90 degrees' };
  }
  if (longitude < -180 || longitude > 180) {
    return { success: false, error: 'Longitude must be between -180 and 180 degrees' };
  }

  const result = await conn.queue(
    `SET TGT TO ADDONS:MJ:TARGET. PRINT TGT:SETTARGET(${latitude}, ${longitude}).`,
    5000
  );

  const success = result.success && result.output.includes('True');
  if (!success) {
    return {
      success: false,
      error: 'Failed to set position target. Make sure vessel has MechJeb.',
    };
  }

  // Get the body the target is on
  const bodyResult = await conn.queue(
    'SET TGT TO ADDONS:MJ:TARGET. PRINT TGT:TARGETBODY.',
    3000
  );
  const body = bodyResult.success ? (bodyResult.output.split('\n').pop() || 'Unknown') : 'Unknown';

  return {
    success: true,
    latitude,
    longitude,
    body,
  };
}

/**
 * Set position target to KSC runway
 */
export async function setPositionTargetKSC(conn: KosConnection): Promise<SetPositionTargetResult> {
  const result = await conn.queue(
    'SET TGT TO ADDONS:MJ:TARGET. PRINT TGT:SETTARGETKSC().',
    5000
  );

  const success = result.success && result.output.includes('True');
  if (!success) {
    return {
      success: false,
      error: 'Failed to set KSC target. Make sure vessel has MechJeb.',
    };
  }

  return {
    success: true,
    latitude: -0.0972,
    longitude: -74.5577,
    body: 'Kerbin',
  };
}

/**
 * Check if a position target is currently set (internal use)
 */
async function hasPositionTarget(conn: KosConnection): Promise<boolean> {
  const { hasPosition } = await hasMjTarget(conn);
  return hasPosition;
}

/**
 * Clear the current MechJeb target (both position and normal) (internal use)
 */
async function unsetMjTarget(conn: KosConnection): Promise<boolean> {
  const result = await conn.queue(
    'SET TGT TO ADDONS:MJ:TARGET. PRINT TGT:UNSET().',
    3000
  );
  return result.success && result.output.includes('True');
}

// Silence unused warnings for internal functions
void hasPositionTarget;
void unsetMjTarget;

// ============================================================================
// Rendezvous Info
// ============================================================================

/**
 * Query rendezvous information from MechJeb target controller.
 * Requires a normal target (body or vessel) to be set.
 */
export async function getRendezvousInfo(conn: KosConnection): Promise<RendezvousInfo | null> {
  // First check if we have a target
  const targetInfo = await getMjTargetBasicInfo(conn);
  if (!targetInfo || targetInfo.type === 'position' || targetInfo.type === 'none') {
    return null;
  }

  // Query rendezvous calculations from MechJeb target controller
  // All values in single query for efficiency
  const result = await conn.queue(
    'SET TGT TO ADDONS:MJ:TARGET. ' +
    'PRINT "RDV|" + TGT:PHASEANGLE + "|" + TGT:RELATIVEINCLINATION + "|" + ' +
    'TGT:CLOSESTAPPROACHTIME + "|" + TGT:CLOSESTAPPROACHDISTANCE + "|" + ' +
    'TGT:TIMETOAN + "|" + TGT:TIMETODN + "|" + TGT:ANEXISTS + "|" + TGT:DNEXISTS.',
    5000
  );

  const match = result.success ? result.output.match(
    /RDV\|([-\d.]+)\|([-\d.]+)\|([-\d.]+)\|([-\d.]+)\|([-\d.]+)\|([-\d.]+)\|(True|False)\|(True|False)/i
  ) : null;

  if (!match) {
    // Try to get partial info
    console.log('[getRendezvousInfo] Failed to parse full result:', result.output);
    return null;
  }

  const phaseAngle = Number.parseFloat(match[1]);
  const relativeInclination = Number.parseFloat(match[2]);
  const closestApproachTime = Number.parseFloat(match[3]);
  const closestApproachDistance = Number.parseFloat(match[4]);
  const timeToAN = Number.parseFloat(match[5]);
  const timeToDN = Number.parseFloat(match[6]);
  const anExists = match[7].toLowerCase() === 'true';
  const dnExists = match[8].toLowerCase() === 'true';

  // Build formatted summary
  let formatted = `Target: ${targetInfo.name}\n`;
  formatted += `Phase angle: ${phaseAngle.toFixed(1)}°\n`;
  formatted += `Relative inclination: ${relativeInclination.toFixed(2)}°\n`;
  formatted += `Closest approach: ${formatDistance(closestApproachDistance)} in ${formatTime(closestApproachTime)}\n`;
  if (anExists) {
    formatted += `Time to AN: ${formatTime(timeToAN)}\n`;
  }
  if (dnExists) {
    formatted += `Time to DN: ${formatTime(timeToDN)}`;
  }

  return {
    targetName: targetInfo.name,
    targetType: targetInfo.type as 'body' | 'vessel',
    phaseAngle,
    relativeInclination,
    closestApproachTime,
    closestApproachDistance,
    timeToAN: anExists ? timeToAN : null,
    timeToDN: dnExists ? timeToDN : null,
    anExists,
    dnExists,
    formatted,
  };
}

// ============================================================================
// Target Orbital Info
// ============================================================================

/**
 * Query target orbital elements from MechJeb.
 * Requires a normal target (body or vessel) to be set.
 */
export async function getTargetOrbitInfo(conn: KosConnection): Promise<TargetOrbitInfo | null> {
  const targetInfo = await getMjTargetBasicInfo(conn);
  if (!targetInfo || targetInfo.type === 'position' || targetInfo.type === 'none') {
    return null;
  }

  const result = await conn.queue(
    'SET TGT TO ADDONS:MJ:TARGET. ' +
    'PRINT "ORB|" + TGT:TARGETAPOAPSIS + "|" + TGT:TARGETPERIAPSIS + "|" + ' +
    'TGT:TARGETINCLINATION + "|" + TGT:TARGETECCENTRICITY + "|" + ' +
    'TGT:TARGETPERIOD + "|" + TGT:TARGETSMA + "|" + TGT:TARGETLAN.',
    5000
  );

  const match = result.success ? result.output.match(
    /ORB\|([-\d.E+]+)\|([-\d.E+]+)\|([-\d.]+)\|([-\d.]+)\|([-\d.E+]+)\|([-\d.E+]+)\|([-\d.]+)/i
  ) : null;

  if (!match) {
    console.log('[getTargetOrbitInfo] Failed to parse result:', result.output);
    return null;
  }

  const apoapsis = Number.parseFloat(match[1]);
  const periapsis = Number.parseFloat(match[2]);
  const inclination = Number.parseFloat(match[3]);
  const eccentricity = Number.parseFloat(match[4]);
  const period = Number.parseFloat(match[5]);
  const sma = Number.parseFloat(match[6]);
  const lan = Number.parseFloat(match[7]);

  let formatted = `Target: ${targetInfo.name}\n`;
  formatted += `Orbit: ${formatOrbit(apoapsis, periapsis)}\n`;
  formatted += `Inclination: ${inclination.toFixed(2)}°\n`;
  formatted += `Eccentricity: ${eccentricity.toFixed(4)}\n`;
  formatted += `Period: ${formatPeriod(period)}\n`;
  formatted += `LAN: ${lan.toFixed(2)}°`;

  return {
    name: targetInfo.name,
    apoapsis,
    periapsis,
    inclination,
    eccentricity,
    period,
    sma,
    lan,
    formatted,
  };
}

// ============================================================================
// Target Position Info
// ============================================================================

/**
 * Query relative position and velocity to target.
 * Useful for docking approaches.
 */
export async function getTargetPositionInfo(conn: KosConnection): Promise<TargetPositionInfo | null> {
  const targetInfo = await getMjTargetBasicInfo(conn);
  if (!targetInfo || targetInfo.type === 'position' || targetInfo.type === 'none') {
    return null;
  }

  const result = await conn.queue(
    'SET TGT TO ADDONS:MJ:TARGET. ' +
    'PRINT "POS|" + TGT:DISTANCE + "|" + TGT:CANALIGN + "|" + ' +
    'TGT:RELVELOCITY:X + "|" + TGT:RELVELOCITY:Y + "|" + TGT:RELVELOCITY:Z + "|" + ' +
    'TGT:RELPOSITION:X + "|" + TGT:RELPOSITION:Y + "|" + TGT:RELPOSITION:Z.',
    5000
  );

  const match = result.success ? result.output.match(
    /POS\|([-\d.E+]+)\|(True|False)\|([-\d.E+]+)\|([-\d.E+]+)\|([-\d.E+]+)\|([-\d.E+]+)\|([-\d.E+]+)\|([-\d.E+]+)/i
  ) : null;

  if (!match) {
    console.log('[getTargetPositionInfo] Failed to parse result:', result.output);
    return null;
  }

  const distance = Number.parseFloat(match[1]);
  const canAlign = match[2].toLowerCase() === 'true';
  const relVelocity = {
    x: Number.parseFloat(match[3]),
    y: Number.parseFloat(match[4]),
    z: Number.parseFloat(match[5]),
  };
  const relPosition = {
    x: Number.parseFloat(match[6]),
    y: Number.parseFloat(match[7]),
    z: Number.parseFloat(match[8]),
  };
  const relVelocityMag = Math.hypot(
    relVelocity.x, relVelocity.y, relVelocity.z
  );

  let formatted = `Target: ${targetInfo.name}\n`;
  formatted += `Distance: ${formatDistance(distance)}\n`;
  formatted += `Relative velocity: ${fmtVel(relVelocityMag)}\n`;
  if (canAlign) {
    formatted += `Docking alignment: available`;
  }

  // Try to get docking axis if alignment is available
  let dockingAxis: { x: number; y: number; z: number } | undefined;
  if (canAlign) {
    const axisResult = await conn.queue(
      'SET TGT TO ADDONS:MJ:TARGET. PRINT "AXIS|" + TGT:DOCKINGAXIS:X + "|" + TGT:DOCKINGAXIS:Y + "|" + TGT:DOCKINGAXIS:Z.',
      3000
    );
    const axisMatch = axisResult.success ? axisResult.output.match(/AXIS\|([-\d.E+]+)\|([-\d.E+]+)\|([-\d.E+]+)/i) : null;
    if (axisMatch) {
      dockingAxis = {
        x: Number.parseFloat(axisMatch[1]),
        y: Number.parseFloat(axisMatch[2]),
        z: Number.parseFloat(axisMatch[3]),
      };
    }
  }

  return {
    name: targetInfo.name,
    distance,
    relVelocity,
    relVelocityMag,
    relPosition,
    canAlign,
    dockingAxis,
    formatted,
  };
}

// ============================================================================
// Unified Target Info
// ============================================================================

/**
 * Comprehensive target information combining orbit, position, and rendezvous data
 */
export interface UnifiedTargetInfo {
  hasTarget: boolean;
  name?: string;
  type?: 'body' | 'vessel';
  // Orbit
  apoapsis?: number;
  periapsis?: number;
  inclination?: number;
  eccentricity?: number;
  period?: number;
  sma?: number;
  lan?: number;
  // Position/velocity
  distance?: number;
  relVelocityMag?: number;
  canAlign?: boolean;
  // Rendezvous
  phaseAngle?: number;
  relativeInclination?: number;
  closestApproachTime?: number;
  closestApproachDistance?: number;
  timeToAN?: number | null;
  timeToDN?: number | null;
  formatted: string;
}

/**
 * Query all target information in a single efficient call.
 * Combines orbit, position, velocity, and rendezvous data.
 */
export async function getUnifiedTargetInfo(conn: KosConnection): Promise<UnifiedTargetInfo> {
  // First check if we have a target
  const targetInfo = await getMjTargetBasicInfo(conn);
  if (!targetInfo || targetInfo.type === 'position' || targetInfo.type === 'none') {
    return {
      hasTarget: false,
      formatted: targetInfo?.type === 'position'
        ? 'Target is a position (lat/lng), not a body or vessel.'
        : 'No target set. Use set_target to select a body or vessel.',
    };
  }

  // Single query combining all target data for efficiency
  const result = await conn.queue(
    'SET TGT TO ADDONS:MJ:TARGET. ' +
    'PRINT "UTGT|" + TGT:TARGETAPOAPSIS + "|" + TGT:TARGETPERIAPSIS + "|" + ' +
    'TGT:TARGETINCLINATION + "|" + TGT:TARGETECCENTRICITY + "|" + ' +
    'TGT:TARGETPERIOD + "|" + TGT:TARGETSMA + "|" + TGT:TARGETLAN + "|" + ' +
    'TGT:DISTANCE + "|" + TGT:RELVELOCITY:MAG + "|" + TGT:CANALIGN + "|" + ' +
    'TGT:PHASEANGLE + "|" + TGT:RELATIVEINCLINATION + "|" + ' +
    'TGT:CLOSESTAPPROACHTIME + "|" + TGT:CLOSESTAPPROACHDISTANCE + "|" + ' +
    'TGT:TIMETOAN + "|" + TGT:TIMETODN + "|" + TGT:ANEXISTS + "|" + TGT:DNEXISTS.',
    5000
  );

  // Parse: ap|pe|inc|ecc|period|sma|lan|dist|relvel|canAlign|phase|relInc|caTime|caDist|toAN|toDN|anEx|dnEx
  const match = result.success ? result.output.match(
    /UTGT\|([-\d.E+]+)\|([-\d.E+]+)\|([-\d.]+)\|([-\d.]+)\|([-\d.E+]+)\|([-\d.E+]+)\|([-\d.]+)\|([-\d.E+]+)\|([-\d.E+]+)\|(True|False)\|([-\d.]+)\|([-\d.]+)\|([-\d.E+]+)\|([-\d.E+]+)\|([-\d.E+]+)\|([-\d.E+]+)\|(True|False)\|(True|False)/i
  ) : null;

  if (!match) {
    console.log('[getUnifiedTargetInfo] Failed to parse result:', result.output);
    return {
      hasTarget: true,
      name: targetInfo.name,
      type: targetInfo.type as 'body' | 'vessel',
      formatted: `Target: ${targetInfo.name}\n(Failed to query detailed info)`,
    };
  }

  // Parse all values
  const apoapsis = Number.parseFloat(match[1]);
  const periapsis = Number.parseFloat(match[2]);
  const inclination = Number.parseFloat(match[3]);
  const eccentricity = Number.parseFloat(match[4]);
  const period = Number.parseFloat(match[5]);
  const sma = Number.parseFloat(match[6]);
  const lan = Number.parseFloat(match[7]);
  const distance = Number.parseFloat(match[8]);
  const relVelocityMag = Number.parseFloat(match[9]);
  const canAlign = match[10].toLowerCase() === 'true';
  const phaseAngle = Number.parseFloat(match[11]);
  const relativeInclination = Number.parseFloat(match[12]);
  const closestApproachTime = Number.parseFloat(match[13]);
  const closestApproachDistance = Number.parseFloat(match[14]);
  const timeToAN = Number.parseFloat(match[15]);
  const timeToDN = Number.parseFloat(match[16]);
  const anExists = match[17].toLowerCase() === 'true';
  const dnExists = match[18].toLowerCase() === 'true';

  // Build formatted output
  let formatted = `Target: ${targetInfo.name} (${targetInfo.type})\n`;
  formatted += `Distance: ${formatDistance(distance)} | Rel vel: ${fmtVel(relVelocityMag)}\n`;
  formatted += '\n';
  formatted += 'Orbit:\n';
  formatted += `  ${formatOrbit(apoapsis, periapsis)}\n`;
  formatted += `  Inc: ${inclination.toFixed(2)}° | Ecc: ${eccentricity.toFixed(4)} | Period: ${formatPeriod(period)}\n`;
  formatted += `  LAN: ${lan.toFixed(2)}°\n`;
  formatted += '\n';
  formatted += 'Rendezvous:\n';
  formatted += `  Phase angle: ${phaseAngle.toFixed(1)}° | Rel inc: ${relativeInclination.toFixed(2)}°\n`;
  formatted += `  Closest approach: ${formatDistance(closestApproachDistance)} in ${formatTime(closestApproachTime)}\n`;
  if (anExists || dnExists) {
    const parts: string[] = [];
    if (anExists) parts.push(`AN: ${formatTime(timeToAN)}`);
    if (dnExists) parts.push(`DN: ${formatTime(timeToDN)}`);
    formatted += `  Time to ${parts.join(' | ')}`;
  }
  if (canAlign) {
    formatted += '\n\nDocking alignment: available';
  }

  return {
    hasTarget: true,
    name: targetInfo.name,
    type: targetInfo.type as 'body' | 'vessel',
    apoapsis,
    periapsis,
    inclination,
    eccentricity,
    period,
    sma,
    lan,
    distance,
    relVelocityMag,
    canAlign,
    phaseAngle,
    relativeInclination,
    closestApproachTime,
    closestApproachDistance,
    timeToAN: anExists ? timeToAN : null,
    timeToDN: dnExists ? timeToDN : null,
    formatted,
  };
}
