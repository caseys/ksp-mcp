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
  /** Body radius in meters (only for bodies, not vessels) */
  radius?: number;
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
 * Uses SET-then-PRINT pattern for reliability.
 *
 * @param conn kOS connection
 * @returns Target info or null if no target set
 */
export async function getTargetValidationInfo(conn: KosConnection): Promise<TargetInfo | null> {
  // Step 1: Check if target exists
  const hasTargetResult = await conn.queue('PRINT HASTARGET.', 2000);
  if (!hasTargetResult.success || !hasTargetResult.output.toLowerCase().includes('true')) {
    return null;
  }

  // Step 2: Get target info using SET-then-PRINT (more reliable than inline expressions)
  // For bodies, also get RADIUS (needed for altitude calculations in course_correct)
  const infoCmd = [
    'SET _tgtType TO TARGET:TYPENAME.',
    'SET _tgtName TO TARGET:NAME.',
    'SET _shipSOI TO SHIP:BODY:NAME.',
    'SET _tgtParent TO TARGET:BODY:NAME.',
    'SET _inSOI TO (_tgtParent = _shipSOI).',
    'IF _tgtType = "Body" { SET _tgtRad TO ROUND(TARGET:RADIUS). } ELSE { SET _tgtRad TO 0. }',
    'PRINT "INFO|" + _tgtType + "|" + _tgtName + "|" + _tgtParent + "|" + _inSOI + "|" + _tgtRad.',
  ].join(' ');

  // Flush stale data before query (prevents reading leftover output from previous commands)
  await conn.flushStaleData(50);

  // Retry once if output is empty (handles timing/buffer issues)
  let infoResult = await conn.queue(infoCmd, 5000);
  let infoMatch = infoResult.success ? infoResult.output.match(/INFO\|(\w+)\|([^|]+)\|([^|]+)\|(\w+)\|(\d+)/) : null;

  if (!infoMatch && (!infoResult.success || infoResult.output === '')) {
    // Empty output - wait briefly and retry
    await new Promise(r => setTimeout(r, 200));
    infoResult = await conn.queue(infoCmd, 5000);
    infoMatch = infoResult.success ? infoResult.output.match(/INFO\|(\w+)\|([^|]+)\|([^|]+)\|(\w+)\|(\d+)/) : null;
  }

  if (!infoMatch) {
    throw new Error(`[validateTarget] Failed to parse target info. Output: "${infoResult.output}"`);
  }

  const [, typename, name, parentBody, inSOIStr, radiusStr] = infoMatch;
  const isInShipSOI = inSOIStr.toLowerCase() === 'true';

  // Classify target
  let targetClass: TargetClass;
  if (typename === 'Vessel') {
    targetClass = 'vessel';
  } else if (parentBody === 'Sun') {
    targetClass = 'planet';
  } else {
    targetClass = 'moon';
  }

  // Step 3: Check for encounter (separate query for reliability)
  const encResult = await conn.queue(
    'IF SHIP:ORBIT:HASNEXTPATCH { PRINT "ENC|" + SHIP:ORBIT:NEXTPATCH:BODY:NAME. } ELSE { PRINT "NOENC". }',
    2000
  );
  const encMatch = encResult.success ? encResult.output.match(/ENC\|(\w+)/) : null;

  const radius = parseInt(radiusStr);
  return {
    name: name.trim(),
    class: targetClass,
    parentBody: parentBody.trim(),
    isInShipSOI,
    hasEncounter: encMatch !== null,
    encounterBody: encMatch ? encMatch[1] : undefined,
    radius: radius > 0 ? radius : undefined,
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
    const soiResult = await conn.queue('PRINT SHIP:BODY:NAME.', 2000);
    const currentSOI = soiResult.success ? soiResult.output.replace(/[>\s]+$/, '') : '';

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
