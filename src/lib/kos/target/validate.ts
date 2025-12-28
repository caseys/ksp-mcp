/**
 * Target Validation - Validate targets before maneuver operations
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { listTargets } from './get-targets.js';
import { formatDistance } from './shared.js';

/**
 * Target classification: planet, moon, vessel, or none
 */
export type TargetClass = 'planet' | 'moon' | 'vessel' | 'none';

/**
 * Detailed information about the current target
 */
export interface TargetInfo {
  /** Target name */
  name: string;
  /** Target classification */
  class: TargetClass;
  /** Body the target orbits (or SOI body for vessels) */
  parentBody: string;
  /** Whether target is in same SOI as ship */
  isInShipSOI: boolean;
  /** Whether ship has encounter with target (orbit patch) */
  hasEncounter: boolean;
  /** Name of encounter body if different from target */
  encounterBody?: string;
}

/**
 * Requirements for target validation
 */
export interface TargetRequirements {
  /** Allowed target classes (e.g., ['moon', 'vessel']) */
  allowedClasses?: TargetClass[];
  /** Target must be in same SOI as ship */
  requireSameSOI?: boolean;
  /** Ship must have encounter (orbit patch) with target */
  requireEncounter?: boolean;
  /** Target cannot be ship's current SOI body (for interplanetary) */
  forbidCurrentSOI?: boolean;
}

/**
 * Result of target validation
 */
export interface ValidationResult {
  /** Whether target meets requirements */
  valid: boolean;
  /** Target info if target exists */
  targetInfo: TargetInfo | null;
  /** Error message with alternatives if invalid */
  error?: string;
}

/**
 * Query detailed target information from kOS.
 * Single atomic query to minimize round trips.
 *
 * @param conn kOS connection
 * @returns Target info or null if no target set
 */
export async function getTargetValidationInfo(conn: KosConnection): Promise<TargetInfo | null> {
  // Single atomic kOS command to get all target info
  // Format: TYPE|name|parentBody|isInSOI|hasEncounter|encounterBody
  const cmd = [
    'IF HASTARGET {',
    '  SET tgtType TO TARGET:TYPENAME.',
    '  SET shipSOI TO SHIP:BODY:NAME.',
    '  SET parentPlanet TO SHIP:BODY.',
    '  IF parentPlanet:BODY:NAME <> "Sun" { SET parentPlanet TO parentPlanet:BODY. }',
    '  IF tgtType = "Vessel" {',
    '    SET tgtParent TO TARGET:BODY:NAME.',
    '    SET inSOI TO (tgtParent = shipSOI).',
    '    PRINT "VESSEL|" + TARGET:NAME + "|" + tgtParent + "|" + inSOI.',
    '  } ELSE {',
    '    SET tgtParent TO TARGET:BODY:NAME.',
    '    SET isPlanet TO (tgtParent = "Sun").',
    '    SET inSOI TO (TARGET:BODY = parentPlanet).',
    '    IF isPlanet { PRINT "PLANET|" + TARGET:NAME + "|" + tgtParent + "|" + inSOI. }',
    '    ELSE { PRINT "MOON|" + TARGET:NAME + "|" + tgtParent + "|" + inSOI. }',
    '  }',
    '  IF SHIP:ORBIT:HASNEXTPATCH {',
    '    PRINT "ENC|" + SHIP:ORBIT:NEXTPATCH:BODY:NAME.',
    '  } ELSE { PRINT "NOENC". }',
    '} ELSE { PRINT "NOTGT". }',
  ].join(' ');

  const result = await conn.execute(cmd, 5000);
  const output = result.output;

  // Check for no target
  if (output.includes('NOTGT')) {
    return null;
  }

  // Parse target type and info: TYPE|name|parent|inSOI
  const typeMatch = output.match(/(VESSEL|PLANET|MOON)\|([^|]+)\|([^|]+)\|(\w+)/);
  if (!typeMatch) {
    return null;
  }

  const [, typeStr, name, parentBody, inSOIStr] = typeMatch;
  const targetClass = typeStr.toLowerCase() as TargetClass;
  const isInShipSOI = inSOIStr.toLowerCase() === 'true';

  // Parse encounter info
  const encMatch = output.match(/ENC\|(\w+)/);
  const hasEncounter = encMatch !== null;
  const encounterBody = encMatch ? encMatch[1] : undefined;

  return {
    name: name.trim(),
    class: targetClass,
    parentBody: parentBody.trim(),
    isInShipSOI,
    hasEncounter,
    encounterBody,
  };
}

/**
 * Format a list of targets for display in error messages
 */
function formatTargetList(targets: Array<{ name: string; distance: number }>, max = 5): string {
  if (targets.length === 0) return '(none available)';
  return targets
    .slice(0, max)
    .map(t => `${t.name} (${formatDistance(t.distance)})`)
    .join(', ');
}

/**
 * Validate target against requirements.
 * Returns helpful error message with alternatives if invalid.
 *
 * @param conn kOS connection
 * @param requirements Validation requirements
 * @param toolName Name of tool for error messages
 * @returns Validation result with error message if invalid
 */
export async function validateTarget(
  conn: KosConnection,
  requirements: TargetRequirements,
  toolName: string
): Promise<ValidationResult> {
  const targetInfo = await getTargetValidationInfo(conn);

  // No target set
  if (!targetInfo) {
    const targets = await listTargets(conn);
    let suggestion = '';

    if (requirements.allowedClasses?.includes('moon') && targets.moons.length > 0) {
      suggestion += `\nAvailable moons: ${formatTargetList(targets.moons)}`;
    }
    if (requirements.allowedClasses?.includes('planet') && targets.planets.length > 0) {
      suggestion += `\nAvailable planets: ${formatTargetList(targets.planets)}`;
    }
    if (requirements.allowedClasses?.includes('vessel') && targets.vessels.length > 0) {
      suggestion += `\nAvailable vessels: ${formatTargetList(targets.vessels)}`;
    }

    return {
      valid: false,
      targetInfo: null,
      error: `No target set. Use set_target first.${suggestion}`,
    };
  }

  const { allowedClasses, requireSameSOI, requireEncounter, forbidCurrentSOI } = requirements;

  // Check allowed classes
  if (allowedClasses && !allowedClasses.includes(targetInfo.class)) {
    const targets = await listTargets(conn);
    const classNames = allowedClasses.map(c => c + 's').join(' or ');

    let error = `Invalid target: ${targetInfo.name} is a ${targetInfo.class}.\n`;
    error += `${toolName} works with ${classNames}.`;

    // Suggest alternative tool
    if (targetInfo.class === 'planet' && !allowedClasses.includes('planet')) {
      error += '\n\nFor planets, use interplanetary_transfer instead.';
    } else if (targetInfo.class === 'moon' && !allowedClasses.includes('moon')) {
      error += '\n\nFor moons, use hohmann_transfer instead.';
    }

    // List valid alternatives
    if (allowedClasses.includes('moon') && targets.moons.length > 0) {
      error += `\n\nAvailable moons: ${formatTargetList(targets.moons)}`;
    }
    if (allowedClasses.includes('vessel') && targets.vessels.length > 0) {
      error += `\nAvailable vessels: ${formatTargetList(targets.vessels)}`;
    }
    if (allowedClasses.includes('planet') && targets.planets.length > 0) {
      error += `\n\nAvailable planets: ${formatTargetList(targets.planets)}`;
    }

    return { valid: false, targetInfo, error };
  }

  // Check same SOI requirement
  if (requireSameSOI && !targetInfo.isInShipSOI) {
    const targets = await listTargets(conn);

    let error = `Invalid target: ${targetInfo.name} is not in your current sphere of influence.\n`;
    error += `${toolName} requires a target in the same SOI as your ship.`;

    // Suggest interplanetary for planets
    if (targetInfo.class === 'planet') {
      error += '\n\nFor planets in other SOIs, use interplanetary_transfer.';
    }

    // List valid alternatives in current SOI
    if (targets.moons.length > 0) {
      error += `\n\nMoons in your SOI: ${formatTargetList(targets.moons)}`;
    }
    if (targets.vessels.length > 0) {
      error += `\nVessels in your SOI: ${formatTargetList(targets.vessels)}`;
    }

    return { valid: false, targetInfo, error };
  }

  // Check encounter requirement
  if (requireEncounter && !targetInfo.hasEncounter) {
    let error = `No encounter with ${targetInfo.name}.\n`;
    error += `${toolName} requires an existing encounter (trajectory that passes through target's SOI).`;
    error += '\n\nUse hohmann_transfer first to establish an encounter.';

    return { valid: false, targetInfo, error };
  }

  // Check forbidden current SOI (for interplanetary - can't transfer to where you already are)
  if (forbidCurrentSOI) {
    // Get current SOI body name
    const soiResult = await conn.execute('PRINT SHIP:BODY:NAME.', 2000);
    const currentSOI = soiResult.output.trim().replace(/[>\s]+$/, '');

    if (targetInfo.name.toLowerCase() === currentSOI.toLowerCase()) {
      const targets = await listTargets(conn);

      let error = `Invalid target: You are already orbiting ${targetInfo.name}.\n`;
      error += `${toolName} is for transferring to other celestial bodies.`;

      if (targets.planets.length > 0) {
        error += `\n\nAvailable planets: ${formatTargetList(targets.planets)}`;
      }

      return { valid: false, targetInfo, error };
    }
  }

  // All checks passed
  return { valid: true, targetInfo };
}
