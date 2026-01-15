/**
 * Time warp library functions
 *
 * Uses outcome-based polling (similar to execute-node.ts pattern):
 * - Instead of polling WARP=0, poll the actual outcome (body change, ETA, etc.)
 * - This is more reliable during high time warp when kOS responses can be delayed
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { type McpLogger, nullLogger } from '../tool-types.js';
import { pollWithBlackoutResilience } from '../../utils/poll-with-resilience.js';
import { formatTime, fmtDist } from '../utils/format.js';
import { hasTarget } from './target/shared.js';
import { willBeInBlackoutAt } from '../../utils/radio-contact.js';

const POLL_INTERVAL_MS = 2000;  // Poll every 2s
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes for long warps

export type WarpTarget = 'node' | 'soi' | 'periapsis' | 'apoapsis';


/**
 * Crash trajectory check result
 */
interface CrashCheck {
  willCrashCurrentSOI: boolean;
  willCrashInEncounter: boolean;
  periapsis?: number;
  etaToPeriapsis?: number;
  encounterBody?: string;
  encounterPeriapsis?: number;
  etaToSOI?: number;
}

/**
 * Current trajectory info for smart warp target detection
 */
interface TrajectoryInfo {
  hasNode: boolean;
  nodeEta?: number;
  hasSOIChange: boolean;
  soiBody?: string;
  soiEta?: number;
}

/**
 * Get current trajectory info for smart warp decisions
 */
async function getTrajectoryInfo(conn: KosConnection): Promise<TrajectoryInfo> {
  // Query node and SOI info (close approach checked separately for vessels)
  const result = await conn.execute(
    'SET _hasNode TO HASNODE. ' +
    'SET _nodeEta TO CHOOSE NEXTNODE:ETA IF _hasNode ELSE 0. ' +
    'SET _hasPatch TO SHIP:ORBIT:HASNEXTPATCH. ' +
    'SET _patchBody TO CHOOSE SHIP:ORBIT:NEXTPATCH:BODY:NAME IF _hasPatch ELSE "". ' +
    'SET _patchEta TO CHOOSE ROUND(SHIP:ORBIT:NEXTPATCHETA) IF _hasPatch ELSE 0. ' +
    'PRINT _hasNode + "|" + ROUND(_nodeEta) + "|" + _hasPatch + "|" + _patchBody + "|" + _patchEta.',
    5000
  );

  // Parse: hasNode|nodeEta|hasPatch|patchBody|patchEta
  const match = result.output.match(/(True|False)\|(-?\d+)\|(True|False)\|([^|]*)\|(-?\d+)/i);

  if (!match) {
    return { hasNode: false, hasSOIChange: false };
  }

  const hasNode = match[1].toLowerCase() === 'true';
  const nodeEta = Number.parseInt(match[2]);
  const hasSOIChange = match[3].toLowerCase() === 'true';
  const soiBody = match[4].trim() || undefined;
  const soiEta = Number.parseInt(match[5]);

  return {
    hasNode,
    nodeEta: hasNode ? nodeEta : undefined,
    hasSOIChange,
    soiBody,
    soiEta: hasSOIChange ? soiEta : undefined,
  };
}

/**
 * Build helpful error message when target name doesn't match trajectory
 */
function buildTrajectoryError(targetName: string, trajInfo: TrajectoryInfo): string {
  let msg = `No encounter with "${targetName}" on current trajectory.`;

  if (trajInfo.hasSOIChange) {
    msg += `\nUpcoming: SOI change to ${trajInfo.soiBody} in ${formatTime(trajInfo.soiEta!)}.`;
  }
  if (trajInfo.hasNode) {
    msg += `\nUpcoming: Maneuver node in ${formatTime(trajInfo.nodeEta!)}.`;
  }
  if (!trajInfo.hasSOIChange && !trajInfo.hasNode) {
    msg += `\nNo upcoming events on current trajectory.`;
  }

  msg += `\nUse hohmann_transfer to create an encounter first.`;
  return msg;
}

/**
 * Resolve a body/vessel name to a warp target
 */
async function resolveTargetName(
  conn: KosConnection,
  targetName: string,
  trajInfo: TrajectoryInfo,
  logger: McpLogger
): Promise<{ resolved: boolean; warpTarget?: WarpTarget | number; error?: string }> {
  const lowerTarget = targetName.toLowerCase();

  // Case 1: Target matches upcoming SOI body
  if (trajInfo.hasSOIChange && trajInfo.soiBody?.toLowerCase() === lowerTarget) {
    // Check if node exists before SOI - prefer node (likely course correction)
    if (trajInfo.hasNode && trajInfo.nodeEta! < trajInfo.soiEta!) {
      logger.info(`[Warp] "${targetName}" matches SOI, but node exists before - warping to node`);
      return { resolved: true, warpTarget: 'node' };
    }
    logger.info(`[Warp] "${targetName}" matches upcoming SOI change`);
    return { resolved: true, warpTarget: 'soi' };
  }

  // Case 2: Check if it's a vessel with close approach
  // Try to set target and check for close approach
  const vesselCheck = await conn.execute(
    `IF EXISTS(VESSEL("${targetName}")) { ` +
    `SET TARGET TO VESSEL("${targetName}"). WAIT 0.1. ` +
    `IF HASTARGET { PRINT "OK|" + ROUND(TARGET:CLOSESTAPPROACHTIME) + "|" + ROUND(TARGET:CLOSESTAPPROACHDISTANCE). } ` +
    `ELSE { PRINT "NOTARGET". } ` +
    `} ELSE { PRINT "NOTFOUND". }`,
    5000
  );

  const vesselMatch = vesselCheck.output.match(/OK\|(-?\d+)\|(-?\d+)/);
  if (vesselMatch) {
    const caTime = Number.parseInt(vesselMatch[1]);
    const caDist = Number.parseInt(vesselMatch[2]);

    // Valid close approach if time is reasonable
    if (caTime > 0 && caTime < 1e8) {
      // Check if node exists before close approach - prefer node
      if (trajInfo.hasNode && trajInfo.nodeEta! < caTime) {
        logger.info(`[Warp] "${targetName}" has close approach, but node exists before - warping to node`);
        return { resolved: true, warpTarget: 'node' };
      }
      logger.info(`[Warp] "${targetName}" has close approach in ${formatTime(caTime)} (${Math.round(caDist / 1000)}km)`);
      // Warp to close approach time (with lead time applied by caller)
      return { resolved: true, warpTarget: caTime };
    }
  }

  // Case 3: Check if it's a valid body but no encounter
  const bodyCheck = await conn.execute(
    `IF EXISTS(BODY("${targetName}")) { PRINT "BODY". } ELSE { PRINT "NO". }`,
    3000
  );

  if (bodyCheck.output.includes('BODY')) {
    // Valid body but no SOI encounter
    return { resolved: false, error: buildTrajectoryError(targetName, trajInfo) };
  }

  // Case 4: Not a valid body or vessel
  return { resolved: false, error: `"${targetName}" is not a valid body or vessel name.` };
}


/**
 * Kick-start MechJeb's warp handling with a brief warp pulse.
 * Only triggers if warp is currently 0 (1x speed).
 *
 * This works around a KSP/MechJeb quirk where warp doesn't start
 * reliably without a "kick" to get it going.
 */
async function _kickstartWarp(conn: KosConnection, logger: McpLogger, _state?: unknown): Promise<boolean> {
  // Check warp and pulse in one kOS command to reduce round trips
  // IF WARP = 0: pulse to 1 (2x), wait 200ms, back to 0
  /*
  const result = await conn.execute(
    'IF WARP = 0 { SET WARP TO 1. WAIT 0.3. SET WARP TO 0. PRINT "KICKED". } ELSE { PRINT "WARP KICK SKIP". }',
    3000
  );
  const kicked = result.output.includes('KICKED');
  if (kicked) {
    logger.progress('[Execute Node] Warp kickstart MechJeb');
  }
  */
  const kicked = true;

  // Try to increase warp speed, respecting physics vs rails mode limits
  // Physics warp max is 4x (index 2), rails warp max is much higher (index 6+)
  await conn.execute(
    'SET maxWarp TO CHOOSE 2 IF KUNIVERSE:TIMEWARP:MODE = "PHYSICS" ELSE 6. ' +
    //'IF WARP > 0 AND WARP < maxWarp { SET WARP TO WARP + 1. }',
    'IF WARP < maxWarp { SET WARP TO WARP + 1. }',
    3000
  );
  logger.progress('[Execute Node] Warp INCREASE after kickstart');

  return kicked;
}

/**
 * Stop time warp by setting warp level to 0.
 */
export async function stopWarp(conn: KosConnection): Promise<void> {
  await conn.execute('SET WARP TO 0.', 3000);
}

/**
 * Check if warping to a target time would result in a crash.
 * Checks both current SOI (periapsis < 0) and upcoming encounter.
 */
async function checkCrashTrajectory(
  conn: KosConnection,
  etaToTarget: number
): Promise<CrashCheck> {
  // Query: current periapsis, ETA to periapsis, SOI ETA, and encounter info
  const result = await conn.execute(
    'PRINT ROUND(PERIAPSIS) + "|" + ROUND(ETA:PERIAPSIS) + "|" + ' +
    '(CHOOSE "NONE|0|0" IF NOT SHIP:ORBIT:HASNEXTPATCH ELSE ' +
    'SHIP:ORBIT:NEXTPATCH:BODY:NAME + "|" + ROUND(SHIP:ORBIT:NEXTPATCHETA) + "|" + ' +
    'ROUND(SHIP:ORBIT:NEXTPATCH:PERIAPSIS)).',
    3000
  );

  // Parse values: pe|etaPe|encounterBody|etaToSOI|encounterPe
  const parts = result.output.split('|');
  const periapsis = Number.parseInt(parts[0]) || 0;
  const etaToPe = Number.parseInt(parts[1]) || 0;

  // Check current SOI crash: periapsis < 0 AND we reach it before target
  const willCrashCurrentSOI = periapsis < 0 && etaToPe < etaToTarget;

  // Check encounter crash (only if warp target is AFTER SOI transition)
  let willCrashInEncounter = false;
  let encounterBody: string | undefined;
  let encounterPeriapsis: number | undefined;
  let etaToSOI: number | undefined;

  if (parts[2] && parts[2] !== 'NONE') {
    encounterBody = parts[2].trim();
    etaToSOI = Number.parseInt(parts[3]) || 0;
    encounterPeriapsis = Number.parseInt(parts[4]) || 0;

    // BLOCK if: encounter has crash trajectory
    // Any warp toward the encounter will eventually lead to crash
    // User should fix trajectory with course_correct first
    willCrashInEncounter = encounterPeriapsis < 0;
  }

  return {
    willCrashCurrentSOI,
    willCrashInEncounter,
    periapsis,
    etaToPeriapsis: etaToPe,
    encounterBody,
    encounterPeriapsis,
    etaToSOI,
  };
}

interface WarpOptions {
  /** Lead time in seconds before target (default: 0) */
  leadTime?: number;
  /** Timeout for warp completion in ms (default: 300000 = 5 minutes) */
  timeout?: number;
  /** Logger for MCP notifications */
  logger?: McpLogger;
}

export interface WarpResult {
  success: boolean;
  error?: string;
  body?: string;
  altitude?: number;
  warning?: string;      // Warning message (e.g., crash trajectory)
  periapsis?: number;    // Periapsis in new SOI (meters)
  bodyRadius?: number;   // Body radius for context
}

/**
 * Helper to query a value from kOS
 */
async function queryValue(conn: KosConnection, expr: string): Promise<string> {
  const result = await conn.execute(`PRINT ${expr}.`, 3000);
  return result.output.trim();
}

/**
 * Warp to a specific target (node, soi, periapsis, apoapsis)
 */
export async function warpTo(
  conn: KosConnection,
  target: WarpTarget,
  options: WarpOptions = {}
): Promise<WarpResult> {
  const leadTime = options.leadTime ?? 0;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  const logger = options.logger;

  switch (target) {
    case 'node': {
      return await warpToNode(conn, leadTime, timeout, logger);
    }
    case 'soi': {
      return await warpToSOI(conn, leadTime, timeout, logger);
    }
    case 'periapsis': {
      return await warpToOrbitalPoint(conn, 'PERIAPSIS', leadTime, timeout, logger);
    }
    case 'apoapsis': {
      return await warpToOrbitalPoint(conn, 'APOAPSIS', leadTime, timeout, logger);
    }
  }
}

/**
 * Warp to maneuver node
 */
async function warpToNode(
  conn: KosConnection,
  leadTime: number,
  timeout: number,
  logger?: McpLogger
): Promise<WarpResult> {
  const log = logger ?? nullLogger;

  // Check if node exists
  const nodeCheck = await conn.execute('PRINT HASNODE.');
  if (!nodeCheck.output.toLowerCase().includes('true')) {
    // Check if SOI change exists to provide helpful suggestion
    const soiCheck = await conn.execute('PRINT SHIP:ORBIT:HASNEXTPATCH.', 2000);
    if (soiCheck.output.toLowerCase().includes('true')) {
      return { success: false, error: 'No maneuver node found. Use warp with target:"soi" to warp to upcoming SOI change.' };
    }
    return { success: false, error: 'No maneuver node found' };
  }

  // Get initial ETA
  const initialEta = Number.parseFloat(await queryValue(conn, 'NEXTNODE:ETA'));
  if (initialEta <= leadTime) {
    // Already close enough
    return await getBasicStatus(conn);
  }

  // Check for crash trajectory before warping
  const crashCheck = await checkCrashTrajectory(conn, initialEta);

  if (crashCheck.willCrashCurrentSOI) {
    return {
      success: false,
      error: `Cannot warp to node - will CRASH first!\n` +
             `Impact in ${formatTime(crashCheck.etaToPeriapsis ?? 0)} (node ETA: ${formatTime(initialEta)})\n` +
             `Use crash_avoidance tool first.`,
    };
  }

  if (crashCheck.willCrashInEncounter) {
    return {
      success: false,
      error: `Cannot warp to node - will CRASH in ${crashCheck.encounterBody}!\n` +
             `Node is after SOI transition (${formatTime(crashCheck.etaToSOI ?? 0)})\n` +
             `${crashCheck.encounterBody} periapsis: ${(crashCheck.encounterPeriapsis! / 1000).toFixed(1)} km\n` +
             `Use course_correct to fix trajectory first.`,
    };
  }

  // Check if warp destination would be in radio blackout
  const warpTargetSeconds = initialEta - leadTime;
  const willBeBlackout = await willBeInBlackoutAt(conn, warpTargetSeconds);
  if (willBeBlackout) {
    return {
      success: false,
      error: `Cannot warp to node - destination is in radio blackout!\n` +
             `Would lose control for ~${formatTime(warpTargetSeconds)} until signal returns.\n` +
             `Wait for radio contact window or adjust node timing.`,
    };
  }

  log.progress(`[Warp] Warping to node T-${formatTime(leadTime)} (ETA: ${formatTime(initialEta)})`);

  // Clear any existing warp state before starting new warp
  await stopWarp(conn);
  await conn.execute(`KUNIVERSE:TIMEWARP:WARPTO(NEXTNODE:TIME - ${leadTime}).`, 5000);

  // Poll ETA until we're close to target
  const result = await pollWithBlackoutResilience<number>({
    poll: async () => Number.parseFloat(await queryValue(conn, 'NEXTNODE:ETA')),
    isDone: (eta) => eta <= leadTime + 5,
    isSuccess: (eta) => eta <= leadTime + 5,
    timeoutMs: timeout,
    pollIntervalMs: POLL_INTERVAL_MS,
    logger: log,
    context: 'Warp',
    connection: conn,
    onPoll: (eta) => log.progress(`[Warp] Node ETA: ${formatTime(eta)}`),
  });

  if (result.success) {
    log.progress('[Warp] Node warp complete');
    return await getBasicStatus(conn);
  }

  return { success: false, error: result.timedOut ? 'Warp timeout' : 'Warp failed' };
}

/**
 * Warp to SOI transition, then cross into new SOI
 */
async function warpToSOI(
  conn: KosConnection,
  leadTime: number,
  timeout: number,
  logger?: McpLogger
): Promise<WarpResult> {
  const log = logger ?? nullLogger;

  // Check for SOI transition
  const soiCheck = await conn.execute('PRINT SHIP:ORBIT:HASNEXTPATCH.');
  if (!soiCheck.output.toLowerCase().includes('true')) {
    const targetSet = await hasTarget(conn);
    if (!targetSet) {
      return {
        success: false,
        error: 'No SOI transition in current trajectory and no target set. Begin transfer to a target before warping.'
      };
    }
    // Get target info to provide helpful error message
    const targetInfo = await conn.execute(
      'PRINT TARGET:NAME + "|" + (CHOOSE "planet" IF TARGET:BODY:NAME = "Sun" ELSE "moon").',
      3000
    );
    const [targetName, targetType] = targetInfo.output.trim().split('|');
    const transferTool = targetType === 'planet' ? 'interplanetary_transfer' : 'hohmann_transfer';
    return {
      success: false,
      error: `No SOI transition in current trajectory. Use ${transferTool} to ${targetName} first.`
    };
  }

  // Get current body and SOI transition ETA
  const currentBody = await queryValue(conn, 'SHIP:BODY:NAME');
  const soiEta = Number.parseFloat(await queryValue(conn, 'SHIP:ORBIT:NEXTPATCHETA'));

  log.progress(`[Warp] Current body: ${currentBody}, SOI transition in ${formatTime(soiEta)}`);

  // Check if warp destination would be in radio blackout
  const warpTargetSeconds = soiEta - leadTime;
  const willBeBlackout = await willBeInBlackoutAt(conn, warpTargetSeconds);
  if (willBeBlackout) {
    return {
      success: false,
      error: `Cannot warp to SOI transition - destination is in radio blackout!\n` +
             `Would lose control until signal returns.\n` +
             `Wait for radio contact window or execute circularize manually.`,
    };
  }

  // Clear any existing warp state before starting new warp
  await stopWarp(conn);
  await conn.execute(`KUNIVERSE:TIMEWARP:WARPTO(TIME:SECONDS + SHIP:ORBIT:NEXTPATCHETA - ${leadTime}).`, 5000);

  // Poll body name until it changes (SOI crossed)
  interface SOIPollState {
    body: string;
    eta: number | null;
  }

  const result = await pollWithBlackoutResilience<SOIPollState>({
    poll: async () => {
      const body = await queryValue(conn, 'SHIP:BODY:NAME');
      let eta: number | null = null;
      try {
        eta = Number.parseFloat(await queryValue(conn, 'SHIP:ORBIT:NEXTPATCHETA'));
      } catch {
        // May not have ETA if already crossed or during blackout
      }
      return { body, eta };
    },
    isDone: (state) => state.body.toLowerCase() !== currentBody.toLowerCase(),
    isSuccess: (state) => state.body.toLowerCase() !== currentBody.toLowerCase(),
    timeoutMs: timeout,
    pollIntervalMs: POLL_INTERVAL_MS,
    logger: log,
    context: 'Warp',
    connection: conn,
    onPoll: (state) => {
      if (state.eta !== null && state.eta < 100_000) {
        log.progress(`[Warp] S.O.I. ETA: ${formatTime(state.eta)}`);
      }
      // Disabled: using env var control instead of kickstart pulses
      // if (state.eta !== null && state.eta > 15_000) {
      //   kickstartWarp(conn, log)
      // }
    },
  });

  if (result.success && result.result) {
    const newBody = result.result.body;
    log.progress(`[Warp] Crossed into ${newBody} S.O.I. Ciculrize to establish a safe orbit.`);

    // Stop warp and wait for KSP to settle
    await stopWarp(conn);
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get SOI info including periapsis check
    return await getSOIStatus(conn, newBody, logger);
  }

  return { success: false, error: result.timedOut ? 'S.O.I. warp timeout' : 'S.O.I. warp failed' };
}

/**
 * Warp to periapsis or apoapsis
 */
async function warpToOrbitalPoint(
  conn: KosConnection,
  point: 'PERIAPSIS' | 'APOAPSIS',
  leadTime: number,
  timeout: number,
  logger?: McpLogger
): Promise<WarpResult> {
  const log = logger ?? nullLogger;

  // Periapsis warp - block if negative periapsis (would warp to impact point)
  if (point === 'PERIAPSIS') {
    const peResult = await conn.execute('PRINT PERIAPSIS.', 2000);
    const periapsis = Number.parseFloat(peResult.output.match(/-?\d+/)?.[0] || '0');
    if (periapsis < 0) {
      return {
        success: false,
        error: `Cannot warp to periapsis - CRASH TRAJECTORY!\n` +
               `Periapsis: ${(periapsis / 1000).toFixed(1)} km (below surface)\n` +
               `Use crash_avoidance tool first.`,
      };
    }
  }

  // Get initial ETA
  const initialEta = Number.parseFloat(await queryValue(conn, `ETA:${point}`));
  if (initialEta <= leadTime) {
    return await getBasicStatus(conn);
  }

  // Check for crash trajectory (both current SOI and encounter)
  const crashCheck = await checkCrashTrajectory(conn, initialEta);

  if (crashCheck.willCrashCurrentSOI) {
    return {
      success: false,
      error: `Cannot warp to ${point.toLowerCase()} - will CRASH first!\n` +
             `Impact in ${formatTime(crashCheck.etaToPeriapsis ?? 0)} (before ${point.toLowerCase()})\n` +
             `Use crash_avoidance tool first.`,
    };
  }

  // For encounter crashes, check if SOI transition happens before we reach target
  if (crashCheck.willCrashInEncounter && crashCheck.etaToSOI! < initialEta) {
    return {
      success: false,
      error: `Cannot warp to ${point.toLowerCase()} - will CRASH in ${crashCheck.encounterBody}!\n` +
             `S.O.I. transition in ${formatTime(crashCheck.etaToSOI ?? 0)} (before ${point.toLowerCase()} at ${formatTime(initialEta)})\n` +
             `${crashCheck.encounterBody} periapsis: ${(crashCheck.encounterPeriapsis! / 1000).toFixed(1)} km\n` +
             `Use course_correct to fix trajectory first.`,
    };
  }

  // Check if warp destination would be in radio blackout
  const warpTargetSeconds = initialEta - leadTime;
  const willBeBlackout = await willBeInBlackoutAt(conn, warpTargetSeconds);
  if (willBeBlackout) {
    return {
      success: false,
      error: `Cannot warp to ${point.toLowerCase()} - destination is in radio blackout!\n` +
             `Would lose control until signal returns.\n` +
             `Wait for radio contact window or adjust maneuver timing.`,
    };
  }

  log.progress(`[Warp] Warping to ${point.toLowerCase()} T-${formatTime(leadTime)} (ETA: ${formatTime(initialEta)})`);

  // Clear any existing warp state before starting new warp
  await stopWarp(conn);
  await conn.execute(`KUNIVERSE:TIMEWARP:WARPTO(TIME:SECONDS + ETA:${point} - ${leadTime}).`, 5000);

  // Poll ETA until we're close
  const result = await pollWithBlackoutResilience<number>({
    poll: async () => Number.parseFloat(await queryValue(conn, `ETA:${point}`)),
    isDone: (eta) => eta <= leadTime + 5,
    isSuccess: (eta) => eta <= leadTime + 5,
    timeoutMs: timeout,
    pollIntervalMs: POLL_INTERVAL_MS,
    logger: log,
    context: 'Warp',
    connection: conn,
    onPoll: (eta) => log.progress(`[Warp] ${point} ETA: ${formatTime(eta)}`),
  });

  if (result.success) {
    log.progress(`[Warp] ${point.toLowerCase()} warp complete`);
    return await getBasicStatus(conn);
  }

  return { success: false, error: result.timedOut ? 'Warp timeout' : 'Warp failed' };
}

/**
 * Get basic status (body and altitude)
 */
async function getBasicStatus(conn: KosConnection): Promise<WarpResult> {
  const statusResult = await conn.execute('PRINT SHIP:BODY:NAME + "," + ROUND(ALTITUDE).');
  const parts = statusResult.output.split(',');
  return {
    success: true,
    body: parts[0]?.trim(),
    altitude: Number.parseInt(parts[1]?.trim() || '0'),
  };
}

/**
 * Get SOI status with crash trajectory check
 */
async function getSOIStatus(conn: KosConnection, body: string, logger?: McpLogger): Promise<WarpResult> {
  const log = logger ?? nullLogger;

  const soiInfo = await conn.execute(
    'PRINT "SOI:" + SHIP:BODY:NAME + "|" + ROUND(ALTITUDE) + "|" + ROUND(PERIAPSIS) + "|" + ROUND(SHIP:BODY:RADIUS).',
    5000
  );

  // Parse structured output
  const soiMatch = soiInfo.output.match(/SOI:([^|]+)\|(-?\d+)\|(-?\d+)\|(\d+)/);
  if (!soiMatch) {
    log.warn(`[Warp] SOI info parse failed: ${soiInfo.output}`);
    return { success: true, body, altitude: 0 };
  }

  const newBody = soiMatch[1].trim();
  const altitude = Number.parseInt(soiMatch[2]);
  const periapsis = Number.parseInt(soiMatch[3]);
  const bodyRadius = Number.parseInt(soiMatch[4]);

  log.info(`[Warp] In ${newBody} SOI: alt=${fmtDist(altitude)}, pe=${fmtDist(periapsis)}`);

  // Warn about crash trajectory (periapsis below surface) but don't auto-trigger avoidance
  // User can call crash_avoidance tool manually if needed
  if (periapsis < 0) {
    return {
      success: true,
      body: newBody,
      altitude,
      periapsis,
      bodyRadius,
      warning: `⚠️ CRASH TRAJECTORY: Periapsis ${(periapsis / 1000).toFixed(1)}km below surface! Use crash_avoidance tool to escape.`,
    };
  }

  return {
    success: true,
    body: newBody,
    altitude,
    periapsis,
    bodyRadius,
  };
}

/**
 * Warp forward by a specific number of seconds
 */
export async function warpForward(
  conn: KosConnection,
  seconds: number,
  timeout: number = DEFAULT_TIMEOUT_MS,
  logger?: McpLogger
): Promise<WarpResult> {
  const log = logger ?? nullLogger;

  // Check for crash trajectory before warping
  const crashCheck = await checkCrashTrajectory(conn, seconds);

  if (crashCheck.willCrashCurrentSOI) {
    return {
      success: false,
      error: `Cannot warp forward ${formatTime(seconds)} - will CRASH first!\n` +
             `Impact in ${formatTime(crashCheck.etaToPeriapsis ?? 0)}\n` +
             `Use crash_avoidance tool first.`,
    };
  }

  if (crashCheck.willCrashInEncounter) {
    return {
      success: false,
      error: `Cannot warp forward ${formatTime(seconds)} - will CRASH in ${crashCheck.encounterBody}!\n` +
             `SOI transition in ${formatTime(crashCheck.etaToSOI ?? 0)}\n` +
             `${crashCheck.encounterBody} periapsis: ${(crashCheck.encounterPeriapsis! / 1000).toFixed(1)} km\n` +
             `Use course_correct to fix trajectory first.`,
    };
  }

  // Check if warp destination would be in radio blackout
  const willBeBlackout = await willBeInBlackoutAt(conn, seconds);
  if (willBeBlackout) {
    return {
      success: false,
      error: `Cannot warp forward ${formatTime(seconds)} - destination is in radio blackout!\n` +
             `Would lose control until signal returns.\n` +
             `Wait for radio contact window or reduce warp duration.`,
    };
  }

  log.progress(`[Warp] Warping forward ${formatTime(seconds)}...`);

  // Clear any existing warp state before starting new warp
  await stopWarp(conn);
  await conn.execute(`KUNIVERSE:TIMEWARP:WARPTO(TIME:SECONDS + ${seconds}).`, 5000);

  // Poll WARP status until it's 0 (warp complete)
  const result = await pollWithBlackoutResilience<number>({
    poll: async () => {
      const warpResult = await conn.execute('PRINT WARP.', 3000);
      const warpMatch = warpResult.output.match(/^(\d+)/);
      return warpMatch ? Number.parseInt(warpMatch[1], 10) : -1;
    },
    isDone: (warpLevel) => warpLevel === 0,
    isSuccess: (warpLevel) => warpLevel === 0,
    timeoutMs: timeout,
    pollIntervalMs: POLL_INTERVAL_MS,
    logger: log,
    context: 'Warp',
    connection: conn,
    onPoll: (warpLevel) => log.progress(`[Warp] Warp level: ${warpLevel}`),
  });

  if (result.success) {
    log.progress('[Warp] Forward warp complete');
    return await getBasicStatus(conn);
  }

  return { success: false, error: result.timedOut ? 'Warp timeout' : 'Warp failed' };
}

// ============================================================================
// Tool Definition
// ============================================================================

import { z } from 'zod';
import type { ToolDefinition } from '../tool-types.js';

/**
 * Warp tool definition
 */
export const warpTool: ToolDefinition = {
  name: 'warp',
  description: 'Fast-forward time to specific moment, maneuver node, or SOI transition.',
  inputSchema: {
    target: z.union([
      z.enum(['node', 'soi', 'periapsis', 'apoapsis', 'auto']),
      z.number(),
      z.string(),
    ]).optional().default('auto').describe('Optional. "node" = warp to maneuver, "soi" = warp to body encounter (after transfer), "periapsis"/"apoapsis" = orbital point, number = seconds, or body/vessel name (e.g., "Mun"). If omitted, auto-detects node or SOI.'),
    leadTime: z.number().optional().default(10).describe('Seconds before target to stop (default: 10)'),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  tier: 1,
  handler: async (args, ctx, extra) => {
    try {
      const conn = await ctx.ensureConnected();
      const logger = ctx.createLogger(extra);

      let target = args.target as WarpTarget | number | string;
      const leadTime = args.leadTime as number;
      const knownTargets = ['node', 'soi', 'periapsis', 'apoapsis'];

      // Get trajectory info for smart decisions
      const trajInfo = await getTrajectoryInfo(conn);

      // Auto-detect target if 'auto'
      if (target === 'auto') {
        // Check for maneuver node first
        if (trajInfo.hasNode) {
          target = 'node';
          logger.info('[Warp] Auto-detected: warping to maneuver node');
        } else if (trajInfo.hasSOIChange) {
          target = 'soi';
          logger.info('[Warp] Auto-detected: warping to SOI change');
        } else {
          return ctx.errorResponse('warp', 'No maneuver node or SOI change found. Specify target: "periapsis", "apoapsis", or seconds to warp forward.');
        }
      }

      // Handle string targets that might be body/vessel names
      if (typeof target === 'string' && !knownTargets.includes(target)) {
        // Check if already in target body's SOI
        const currentBody = await queryValue(conn, 'SHIP:BODY:NAME');
        if (currentBody.toLowerCase().includes(target.toLowerCase())) {
          const orbitInfo = await conn.execute(
            'PRINT ROUND(PERIAPSIS/1000) + "|" + ROUND(APOAPSIS/1000).',
            2000
          );
          const [pe, ap] = orbitInfo.output.split('|').map(s => s.trim());
          return ctx.successResponse('warp',
            `Already at ${currentBody}! No warp needed.\n` +
            `Orbit: Pe=${pe}km, Ap=${ap}km`);
        }

        const resolved = await resolveTargetName(conn, target, trajInfo, logger);
        if (!resolved.resolved) {
          return ctx.errorResponse('warp', resolved.error ?? `Unknown target: ${target}`);
        }
        target = resolved.warpTarget!;
        logger.info(`[Warp] Resolved "${args.target}" to ${typeof target === 'number' ? `${target}s` : target}`);
      }

      // Check if warping to 'soi' but trajectory leads to current body (no actual SOI change)
      if (target === 'soi' && trajInfo.hasSOIChange) {
        const currentBody = await queryValue(conn, 'SHIP:BODY:NAME');
        if (trajInfo.soiBody?.toLowerCase() === currentBody.toLowerCase()) {
          return ctx.successResponse('warp',
            `Already at ${currentBody}! Trajectory returns to current SOI.\n` +
            `Use transfer tool to create an encounter with a different body.`);
        }
      }

      let result: WarpResult;

      if (typeof target === 'number') {
        result = await warpForward(conn, target, DEFAULT_TIMEOUT_MS, logger);
      } else {
        result = await warpTo(conn, target as WarpTarget, { leadTime, logger });
      }

      if (result.success) {
        let text = `Warp complete. Body: ${result.body}, Altitude: ${fmtDist(result.altitude ?? 0)}`;
        if (result.warning) {
          text += '\n\n' + result.warning;
        }
        return ctx.successResponse('warp', text);
      } else {
        return ctx.errorResponse('warp', result.error ?? 'Failed');
      }
    } catch (error) {
      return ctx.errorResponse('warp', error instanceof Error ? error.message : String(error));
    }
  },
};
