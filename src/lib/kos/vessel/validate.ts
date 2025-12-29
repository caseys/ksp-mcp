/**
 * Vessel State Validation - Validate vessel state before maneuver operations
 */

import type { KosConnection } from '../../../transport/kos-connection.js';

/**
 * KSP Vessel.Situations enum values (from SHIP:STATUS)
 */
export type VesselStatus = 'prelaunch' | 'landed' | 'splashed' | 'flying' | 'sub_orbital' | 'orbiting' | 'escaping' | 'docked';

/**
 * Classification of the body the vessel is orbiting
 */
export type BodyType = 'sun' | 'planet' | 'moon';

/**
 * Detailed information about the vessel's current state
 */
export interface VesselStateInfo {
  /** Current vessel situation (from KSP enum) */
  status: VesselStatus;
  /** Name of body vessel is in SOI of */
  bodyName: string;
  /** Type of body: sun, planet, or moon */
  bodyType: BodyType;
  /** Name of body that the SOI body orbits */
  parentBodyName: string;
  /** Current apoapsis in meters (-1 for escape trajectory) */
  apoapsis: number;
  /** Current periapsis in meters */
  periapsis: number;
  /** Orbital eccentricity */
  eccentricity: number;
  /** Whether orbit has an encounter with another body */
  hasEncounter: boolean;
  /** Whether a maneuver node exists */
  hasManeuverNode: boolean;
}

/**
 * Requirements for vessel state validation
 */
export interface VesselStateRequirements {
  /** Vessel must be in one of these statuses */
  allowedStatuses?: VesselStatus[];
  /** Vessel must NOT be in any of these statuses */
  forbiddenStatuses?: VesselStatus[];
  /** Must be orbiting a moon (parent body is not Sun) */
  requireAtMoon?: boolean;
  /** Must be orbiting a planet (parent body is Sun) */
  requireAtPlanet?: boolean;
  /** Must have an encounter with another body */
  requireEncounter?: boolean;
  /** Must have a maneuver node */
  requireManeuverNode?: boolean;
  /** Must have stable orbit (periapsis > 0) */
  requireStableOrbit?: boolean;
}

/**
 * Result of vessel state validation
 */
export interface StateValidationResult {
  /** Whether vessel state meets requirements */
  valid: boolean;
  /** Current vessel state info */
  stateInfo: VesselStateInfo;
  /** Error message with guidance if invalid */
  error?: string;
}

/**
 * Human-readable status names for error messages
 */
const STATUS_NAMES: Record<VesselStatus, string> = {
  prelaunch: 'on the launchpad',
  landed: 'landed',
  splashed: 'splashed down',
  flying: 'flying in atmosphere',
  sub_orbital: 'on a suborbital trajectory',
  orbiting: 'in orbit',
  escaping: 'on an escape trajectory',
  docked: 'docked',
};

/**
 * Query vessel state information from kOS.
 * Single atomic query to minimize round trips.
 *
 * @param conn kOS connection
 * @returns Vessel state info
 */
export async function getVesselStateInfo(conn: KosConnection): Promise<VesselStateInfo> {
  // Single atomic kOS command to get all vessel state info
  // Format: STATE|status|bodyName|parentBodyName|apo|peri|ecc|hasEnc|hasNode
  // Note: For escape trajectories (ecc >= 1), apoapsis is infinite - use -1 sentinel
  const cmd = [
    'PRINT "STATE|" + SHIP:STATUS + "|" + SHIP:BODY:NAME + "|" + SHIP:BODY:BODY:NAME + "|" +',
    '(CHOOSE -1 IF ORBIT:ECCENTRICITY >= 1 ELSE ROUND(APOAPSIS)) + "|" +',
    'ROUND(PERIAPSIS) + "|" + ROUND(ORBIT:ECCENTRICITY, 4) + "|" +',
    'ORBIT:HASNEXTPATCH + "|" + HASNODE.',
  ].join(' ');

  const result = await conn.execute(cmd, 5000);
  const output = result.output;

  // Parse STATE|status|body|parent|apo|peri|ecc|hasEnc|hasNode
  const match = output.match(/STATE\|(\w+)\|([^|]+)\|([^|]+)\|(-?[\d.]+)\|(-?[\d.]+)\|([\d.]+)\|(True|False)\|(True|False)/i);
  if (!match) {
    throw new Error(`Failed to parse vessel state. Raw output: ${output.slice(0, 200)}`);
  }

  const [, statusRaw, bodyName, parentBodyName, apoStr, periStr, eccStr, hasEncStr, hasNodeStr] = match;

  // Parse status (lowercase for consistency)
  const status = statusRaw.toLowerCase().replace(' ', '_') as VesselStatus;

  // Determine body type based on parent
  let bodyType: BodyType;
  if (bodyName.toLowerCase() === 'sun' || bodyName.toLowerCase() === 'kerbol') {
    bodyType = 'sun';
  } else if (parentBodyName.toLowerCase() === 'sun' || parentBodyName.toLowerCase() === 'kerbol') {
    bodyType = 'planet';
  } else {
    bodyType = 'moon';
  }

  return {
    status,
    bodyName: bodyName.trim(),
    bodyType,
    parentBodyName: parentBodyName.trim(),
    apoapsis: Number.parseFloat(apoStr),
    periapsis: Number.parseFloat(periStr),
    eccentricity: Number.parseFloat(eccStr),
    hasEncounter: hasEncStr.toLowerCase() === 'true',
    hasManeuverNode: hasNodeStr.toLowerCase() === 'true',
  };
}

/**
 * Validate vessel state against requirements.
 * Returns helpful error message with guidance if invalid.
 *
 * @param conn kOS connection
 * @param requirements Validation requirements
 * @param toolName Name of tool for error messages
 * @returns Validation result with error message if invalid
 */
export async function validateVesselState(
  conn: KosConnection,
  requirements: VesselStateRequirements,
  toolName: string
): Promise<StateValidationResult> {
  const stateInfo = await getVesselStateInfo(conn);
  const { status, bodyName, bodyType, periapsis, hasEncounter, hasManeuverNode } = stateInfo;

  // Check allowed statuses
  if (requirements.allowedStatuses && !requirements.allowedStatuses.includes(status)) {
    const allowedNames = requirements.allowedStatuses.map(s => STATUS_NAMES[s]).join(' or ');
    return {
      valid: false,
      stateInfo,
      error: `Cannot use ${toolName}: Vessel is ${STATUS_NAMES[status]}.\n` +
             `${toolName} requires the vessel to be ${allowedNames}.\n\n` +
             `Current status: ${status.toUpperCase()} at ${bodyName}`,
    };
  }

  // Check forbidden statuses
  if (requirements.forbiddenStatuses?.includes(status)) {
    let suggestion = '';
    if (['prelaunch', 'landed', 'splashed'].includes(status)) {
      suggestion = '\n\nUse launch_and_circularize to get into orbit first.';
    } else if (status === 'escaping') {
      suggestion = '\n\nUse circularize to establish a stable orbit first.';
    }

    return {
      valid: false,
      stateInfo,
      error: `Cannot use ${toolName}: Vessel is ${STATUS_NAMES[status]}.\n` +
             `${toolName} cannot be used while ${STATUS_NAMES[status]}.${suggestion}\n\n` +
             `Current status: ${status.toUpperCase()} at ${bodyName}`,
    };
  }

  // Check require at moon
  if (requirements.requireAtMoon && bodyType !== 'moon') {
    return {
      valid: false,
      stateInfo,
      error: `Cannot use ${toolName}: Not orbiting a moon.\n` +
             `${toolName} only works when orbiting a moon (Mun, Minmus, etc.).\n\n` +
             `You are currently at ${bodyName} (a ${bodyType}).\n` +
             `Use hohmann_transfer to travel to a moon first.`,
    };
  }

  // Check require at planet
  if (requirements.requireAtPlanet && bodyType !== 'planet') {
    let suggestion = '';
    if (bodyType === 'moon') {
      suggestion = `\nUse return_from_moon to get back to the parent planet first.`;
    }
    return {
      valid: false,
      stateInfo,
      error: `Cannot use ${toolName}: Not orbiting a planet.\n` +
             `${toolName} only works when orbiting a planet (Kerbin, Duna, etc.), not a moon.${suggestion}\n\n` +
             `You are currently at ${bodyName} (a ${bodyType}).`,
    };
  }

  // Check require encounter
  if (requirements.requireEncounter && !hasEncounter) {
    return {
      valid: false,
      stateInfo,
      error: `Cannot use ${toolName}: No encounter detected.\n` +
             `${toolName} requires an existing encounter (trajectory through target's SOI).\n\n` +
             `Use hohmann_transfer first to establish an encounter.`,
    };
  }

  // Check require maneuver node
  if (requirements.requireManeuverNode && !hasManeuverNode) {
    return {
      valid: false,
      stateInfo,
      error: `Cannot use ${toolName}: No maneuver node.\n` +
             `${toolName} requires a maneuver node to be planned.\n\n` +
             `Use a transfer or maneuver planning tool first (e.g., hohmann_transfer, circularize).`,
    };
  }

  // Check require stable orbit
  if (requirements.requireStableOrbit && periapsis < 0) {
    return {
      valid: false,
      stateInfo,
      error: `Cannot use ${toolName}: Orbit is not stable (periapsis below surface).\n` +
             `${toolName} requires a stable orbit with periapsis above the surface.\n\n` +
             `Current periapsis: ${(periapsis / 1000).toFixed(1)} km\n` +
             `Use crash_avoidance to raise periapsis first.`,
    };
  }

  // All checks passed
  return { valid: true, stateInfo };
}

/**
 * Common validation requirements for orbital maneuver tools
 */
export const ORBITAL_REQUIREMENTS: VesselStateRequirements = {
  forbiddenStatuses: ['prelaunch', 'landed', 'splashed'],
};

/**
 * Common validation requirements for tools that need stable orbit
 */
export const STABLE_ORBIT_REQUIREMENTS: VesselStateRequirements = {
  forbiddenStatuses: ['prelaunch', 'landed', 'splashed', 'escaping'],
};

/**
 * Validation requirements for launch tool
 */
export const LAUNCH_REQUIREMENTS: VesselStateRequirements = {
  allowedStatuses: ['prelaunch', 'landed'],
};
