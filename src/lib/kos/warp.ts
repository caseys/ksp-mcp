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

const POLL_INTERVAL_MS = 2000;  // Poll every 2s
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes for long warps

export type WarpTarget = 'node' | 'soi' | 'periapsis' | 'apoapsis' | 'reentry';

/**
 * Moon return scenario info (escaping moon to parent body)
 */
interface MoonReturnInfo {
  isMoonReturn: boolean;
  parentBody?: string;
  parentAtmHeight?: number;  // 0 if no atmosphere
  etaToReentry?: number;     // Time to atmosphere edge (~95% of periapsis time)
}

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
 * Detect moon return scenario: in moon SOI with parent body encounter
 * Returns info needed for reentry warp targeting
 */
async function detectMoonReturn(conn: KosConnection, targetName?: string): Promise<MoonReturnInfo> {
  // Query: current body's parent, next patch body, and encounter body atmosphere
  const cmd = [
    'LOCAL _curParent IS SHIP:BODY:BODY:NAME.',
    'LOCAL _hasPatch IS SHIP:ORBIT:HASNEXTPATCH.',
    'LOCAL _nextBody IS "".',
    'LOCAL _nextAtm IS 0.',
    'LOCAL _nextPeTime IS 0.',
    'IF _hasPatch {',
    '  SET _nextBody TO SHIP:ORBIT:NEXTPATCH:BODY:NAME.',
    '  SET _nextAtm TO ROUND(SHIP:ORBIT:NEXTPATCH:BODY:ATM:HEIGHT).',
    '  SET _nextPeTime TO ROUND(SHIP:ORBIT:NEXTPATCH:ETA:PERIAPSIS).',
    '}',
    'PRINT "MR|" + _curParent + "|" + _nextBody + "|" + _nextAtm + "|" + _nextPeTime.',
  ].join(' ');

  const result = await conn.execute(cmd, 5000);
  const match = result.output.match(/MR\|([^|]*)\|([^|]*)\|(\d+)\|(\d+)/);

  if (!match) return { isMoonReturn: false };

  const [, curParent, nextBody, nextAtmStr, nextPeTimeStr] = match;
  const nextAtm = parseInt(nextAtmStr);
  const nextPeTime = parseInt(nextPeTimeStr);

  // Is moon return if:
  // 1. Auto mode (no targetName): next body is our current parent
  // 2. Explicit target: targetName matches next body AND next body is our parent
  const autoModeMatch = !targetName && nextBody.toLowerCase() === curParent.toLowerCase();
  const explicitTargetMatch = targetName &&
    targetName.toLowerCase() === nextBody.toLowerCase() &&
    nextBody.toLowerCase() === curParent.toLowerCase();

  const isMoonReturn = autoModeMatch || explicitTargetMatch;

  if (!isMoonReturn || nextPeTime <= 0) return { isMoonReturn: false };

  // Estimate time to target altitude (~95% of periapsis time for reentry)
  const etaToReentry = Math.round(nextPeTime * 0.95);

  return {
    isMoonReturn: true,
    parentBody: nextBody,
    parentAtmHeight: nextAtm,
    etaToReentry,
  };
}

/**
 * Orbit context for better error messages
 */
interface OrbitContext {
  currentBody: string;
  parentBody: string;
  orbitType: 'circular' | 'elliptical' | 'hyperbolic';
  eccentricity: number;
  isAtMoon: boolean;  // Current body orbits a planet (not Sun)
}

/**
 * Get orbit context for error messages
 */
async function getOrbitContext(conn: KosConnection): Promise<OrbitContext> {
  const result = await conn.execute(
    'LOCAL cb IS SHIP:BODY. ' +
    'LOCAL pb IS cb:BODY:NAME. ' +
    'LOCAL ecc IS SHIP:ORBIT:ECCENTRICITY. ' +
    'LOCAL isMoon IS (pb <> "Sun"). ' +
    'PRINT "CTX|" + cb:NAME + "|" + pb + "|" + ROUND(ecc, 4) + "|" + isMoon.',
    3000
  );

  const match = result.output.match(/CTX\|([^|]+)\|([^|]+)\|([\d.]+)\|(True|False)/i);
  if (!match) {
    return { currentBody: '?', parentBody: '?', orbitType: 'elliptical', eccentricity: 0, isAtMoon: false };
  }

  const ecc = parseFloat(match[3]);
  let orbitType: 'circular' | 'elliptical' | 'hyperbolic';
  if (ecc >= 1) {
    orbitType = 'hyperbolic';
  } else if (ecc < 0.1) {
    orbitType = 'circular';
  } else {
    orbitType = 'elliptical';
  }

  return {
    currentBody: match[1].trim(),
    parentBody: match[2].trim(),
    orbitType,
    eccentricity: ecc,
    isAtMoon: match[4].toLowerCase() === 'true',
  };
}

/**
 * Build helpful error message when target name doesn't match trajectory
 */
async function buildTrajectoryError(
  conn: KosConnection,
  targetName: string,
  trajInfo: TrajectoryInfo
): Promise<string> {
  const ctx = await getOrbitContext(conn);

  // Check if target is the parent body (e.g., Kerbin when at Minmus)
  const isTargetParent = ctx.parentBody.toLowerCase() === targetName.toLowerCase();

  if (isTargetParent && ctx.isAtMoon) {
    // Trying to warp to parent body from moon orbit
    if (ctx.orbitType === 'hyperbolic') {
      // Has escape trajectory but no encounter with parent
      return `Hyperbolic orbit around ${ctx.currentBody} but no ${targetName} encounter.\n` +
             `Your escape trajectory may not intercept ${targetName}.\n` +
             `Use return_from_moon to create a proper return trajectory.`;
    } else {
      // Circular/elliptical orbit - needs escape burn
      return `Cannot warp to ${targetName} from ${ctx.orbitType} orbit around ${ctx.currentBody}.\n` +
             `Use return_from_moon to escape ${ctx.currentBody} first.`;
    }
  }

  // Generic case - body exists but no encounter
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

  // Suggest appropriate transfer tool
  if (ctx.isAtMoon && isTargetParent) {
    msg += `\nUse return_from_moon to create an escape trajectory.`;
  } else {
    msg += `\nUse transfer or hohmann_transfer to create an encounter first.`;
  }

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

    // Check if this is a moon return scenario (target is parent body)
    const moonReturn = await detectMoonReturn(conn, targetName);
    if (moonReturn.isMoonReturn) {
      logger.info(`[Warp] Moon return detected - warping to ${targetName} atmosphere edge`);
      return { resolved: true, warpTarget: 'reentry' };
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
  // Try title case since KSP body names use that format (e.g., "Kerbin", "Minmus")
  const titleCase = targetName.charAt(0).toUpperCase() + targetName.slice(1).toLowerCase();
  const bodyCheck = await conn.execute(
    `IF EXISTS(BODY("${titleCase}")) { PRINT "BODY|${titleCase}". } ` +
    `ELSE IF EXISTS(BODY("${targetName}")) { PRINT "BODY|${targetName}". } ` +
    `ELSE { PRINT "NO". }`,
    3000
  );

  // Check if we got a valid response - if not, might be a communication issue
  const hasValidResponse = bodyCheck.output.includes('BODY|') || bodyCheck.output.includes('NO');
  if (!hasValidResponse) {
    // kOS didn't return expected output - likely communication issue
    return { resolved: false, error: `Unable to verify "${targetName}" - communication issue. Check vessel signal.` };
  }

  const bodyMatch = bodyCheck.output.match(/BODY\|(\w+)/);
  if (bodyMatch) {
    // Valid body but no SOI encounter - provide context-aware error
    const canonicalName = bodyMatch[1];
    return { resolved: false, error: await buildTrajectoryError(conn, canonicalName, trajInfo) };
  }

  // Case 4: Not a valid body or vessel (kOS responded with "NO")
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
 * Warp to a specific target (node, soi, periapsis, apoapsis, reentry)
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
    case 'reentry': {
      return await warpToReentry(conn, leadTime, timeout, logger);
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

  log.progress(`[Warp] Helm, course set for maneuver node. ETA ${formatTime(initialEta)}... Engage!`);

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
    onPoll: (eta) => log.progress(`[Warp] ETA to maneuver: ${formatTime(eta)}`),
  });

  if (result.success) {
    log.progress('[Warp] Dropping out of warp. Ready for maneuver, Captain.');
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

  // Get destination body name for the message
  const destBody = await queryValue(conn, 'SHIP:ORBIT:NEXTPATCH:BODY:NAME');
  log.progress(`[Warp] Leaving ${currentBody} orbit. Destination: ${destBody}. Warp in ${formatTime(soiEta)}... Engage!`);

  // Clear any existing warp state before starting new warp
  await stopWarp(conn);
  await conn.execute(`KUNIVERSE:TIMEWARP:WARPTO(TIME:SECONDS + SHIP:ORBIT:NEXTPATCHETA - ${leadTime}).`, 5000);

  // Poll body name until it changes (SOI crossed)
  interface SOIPollState {
    body: string;
    eta: number | null;
    nextBody: string | null;  // Body after next patch (for flyby detection)
  }

  const result = await pollWithBlackoutResilience<SOIPollState>({
    poll: async () => {
      const body = await queryValue(conn, 'SHIP:BODY:NAME');
      let eta: number | null = null;
      let nextBody: string | null = null;
      try {
        const patchInfo = await conn.execute(
          'IF SHIP:ORBIT:HASNEXTPATCH { PRINT ROUND(SHIP:ORBIT:NEXTPATCHETA) + "|" + SHIP:ORBIT:NEXTPATCH:BODY:NAME. } ELSE { PRINT "NONE". }',
          3000
        );
        const match = patchInfo.output.match(/(\d+)\|(.+)/);
        if (match) {
          eta = Number.parseInt(match[1]);
          nextBody = match[2].trim();
        }
      } catch {
        // May not have ETA if already crossed or during blackout
      }
      return { body, eta, nextBody };
    },
    isDone: (state) => state.body.toLowerCase() !== currentBody.toLowerCase(),
    isSuccess: (state) => state.body.toLowerCase() !== currentBody.toLowerCase(),
    timeoutMs: timeout,
    pollIntervalMs: POLL_INTERVAL_MS,
    logger: log,
    context: 'Warp',
    connection: conn,
    onPoll: (state) => {
      // Check if we've crossed into the new SOI
      const crossed = state.body.toLowerCase() !== currentBody.toLowerCase();

      if (!crossed) {
        // Still approaching destination
        if (state.eta !== null && state.eta < 100_000) {
          log.progress(`[Warp] Approaching destination... ETA ${formatTime(state.eta)}`);
        }
      } else if (state.eta !== null && state.nextBody) {
        // Crossed into new SOI - eta now refers to exit trajectory
        log.progress(`[Warp] Flyby trajectory - returns to ${state.nextBody} in ${formatTime(state.eta)}`);
      }
    },
  });

  if (result.success && result.result) {
    const newBody = result.result.body;
    log.progress(`[Warp] Entering ${newBody} space. All stop. Circularize to establish standard orbit.`);

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

  const pointName = point === 'PERIAPSIS' ? 'periapsis' : 'apoapsis';
  log.progress(`[Warp] Helm, course laid in for ${pointName}. ETA ${formatTime(initialEta)}... Engage!`);

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
    onPoll: (eta) => log.progress(`[Warp] On approach... ${formatTime(eta)} to ${pointName}`),
  });

  if (result.success) {
    log.progress(`[Warp] Arriving at ${pointName}. All stop.`);
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
    'PRINT "SOI:" + SHIP:BODY:NAME + "|" + ROUND(ALTITUDE) + "|" + ROUND(PERIAPSIS) + "|" + ROUND(SHIP:BODY:RADIUS) + "|" + ROUND(SHIP:ORBIT:ECCENTRICITY, 3).',
    5000
  );

  // Parse structured output
  const soiMatch = soiInfo.output.match(/SOI:([^|]+)\|(-?\d+)\|(-?\d+)\|(\d+)\|([\d.]+)/);
  if (!soiMatch) {
    log.warn(`[Warp] SOI info parse failed: ${soiInfo.output}`);
    return { success: true, body, altitude: 0 };
  }

  const newBody = soiMatch[1].trim();
  const altitude = Number.parseInt(soiMatch[2]);
  const periapsis = Number.parseInt(soiMatch[3]);
  const bodyRadius = Number.parseInt(soiMatch[4]);
  const eccentricity = Number.parseFloat(soiMatch[5]);

  // Describe trajectory type accurately
  if (periapsis < 0) {
    log.info(`[Warp] ${newBody} encounter - IMPACT TRAJECTORY! Periapsis ${fmtDist(periapsis)}`);
  } else if (eccentricity >= 1) {
    log.info(`[Warp] ${newBody} flyby - hyperbolic trajectory. Periapsis ${fmtDist(periapsis)}`);
  } else {
    log.info(`[Warp] Captured by ${newBody}. Periapsis ${fmtDist(periapsis)}`);
  }

  // Warn about crash trajectory (periapsis below surface) but don't auto-trigger avoidance
  // User can call crash_avoidance tool manually if needed
  if (periapsis < 0) {
    return {
      success: true,
      body: newBody,
      altitude,
      periapsis,
      bodyRadius,
      warning: `⚠️ CRASH TRAJECTORY: Periapsis ${(periapsis / 1000).toFixed(1)}km below surface!\nNext: use crash_avoidance to escape.`,
    };
  }

  // Add Next guidance based on trajectory type
  let warning: string | undefined;
  if (eccentricity >= 1) {
    warning = `Hyperbolic trajectory (ecc=${eccentricity.toFixed(2)})\nNext: circularize to capture into orbit`;
  } else {
    warning = `Next: circularize to establish stable orbit`;
  }

  return {
    success: true,
    body: newBody,
    altitude,
    periapsis,
    bodyRadius,
    warning,
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

  log.progress(`[Warp] Time warp engaged. Jumping ahead ${formatTime(seconds)}...`);

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
    onPoll: (warpLevel) => log.progress(`[Warp] Warp factor ${warpLevel}...`),
  });

  if (result.success) {
    log.progress('[Warp] Time jump complete. Resuming normal space.');
    return await getBasicStatus(conn);
  }

  return { success: false, error: result.timedOut ? 'Warp timeout' : 'Warp failed' };
}

/**
 * Warp to reentry: for moon-to-parent returns, warp to atmosphere edge
 * Target altitude: atmosphere height × 1.5 (or 50km if no atmosphere)
 */
async function warpToReentry(
  conn: KosConnection,
  leadTime: number,
  timeout: number,
  logger?: McpLogger
): Promise<WarpResult> {
  const log = logger ?? nullLogger;

  // Get moon return info
  const moonReturn = await detectMoonReturn(conn);
  if (!moonReturn.isMoonReturn || !moonReturn.etaToReentry) {
    return { success: false, error: 'No parent body encounter detected. Use this from moon orbit with a return trajectory.' };
  }

  const { parentBody, parentAtmHeight, etaToReentry } = moonReturn;
  const targetAlt = parentAtmHeight && parentAtmHeight > 0
    ? Math.round(parentAtmHeight * 1.5)
    : 50_000;
  const targetDesc = parentAtmHeight && parentAtmHeight > 0
    ? `${parentBody} atmosphere edge (~${Math.round(targetAlt / 1000)}km)`
    : `${parentBody} 50km altitude`;

  log.progress(`[Warp] Course laid in for ${targetDesc}. ETA ${formatTime(etaToReentry)}... Engage!`);

  // Clear any existing warp and issue WARPTO command
  await stopWarp(conn);
  const warpTargetUT = `TIME:SECONDS + ${etaToReentry - leadTime}`;
  await conn.execute(`KUNIVERSE:TIMEWARP:WARPTO(${warpTargetUT}).`, 5000);

  // Poll until we reach the parent body's SOI
  let pollCount = 0;
  const result = await pollWithBlackoutResilience<{ body: string; alt: number }>({
    poll: async () => {
      const r = await conn.execute('PRINT "WR|" + SHIP:BODY:NAME + "|" + ROUND(ALTITUDE).', 3000);
      const m = r.output.match(/WR\|(\w+)\|(\d+)/);
      return m ? { body: m[1], alt: parseInt(m[2]) } : { body: '', alt: 0 };
    },
    isDone: (state) => state.body.toLowerCase() === parentBody!.toLowerCase(),
    isSuccess: (state) => state.body.toLowerCase() === parentBody!.toLowerCase(),
    timeoutMs: timeout,
    pollIntervalMs: POLL_INTERVAL_MS,
    logger: log,
    context: 'Warp to reentry',
    connection: conn,
    onPoll: () => {
      pollCount++;
      if (pollCount % 15 === 0) {  // Every ~30 seconds
        log.progress(`[Warp] Approaching ${parentBody}...`);
      }
    },
  });

  if (!result.success) {
    return { success: false, error: result.timedOut ? 'Warp to reentry timed out' : 'Warp to reentry failed' };
  }

  const finalAlt = result.result?.alt ?? 0;
  log.progress(`[Warp] Arrived at ${parentBody}. Altitude: ${fmtDist(finalAlt)}`);

  return {
    success: true,
    body: parentBody,
    altitude: finalAlt,
    warning: `Ready for reentry.\nTarget altitude was ~${Math.round(targetAlt / 1000)}km (atm×1.5 or 50km).`,
  };
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
      z.enum(['node', 'soi', 'periapsis', 'apoapsis', 'reentry', 'auto']),
      z.number(),
      z.string(),
    ]).optional().default('auto').describe('Optional. "node" = warp to maneuver, "soi" = warp to body encounter (after transfer), "reentry" = warp to atmosphere edge (for moon returns), "periapsis"/"apoapsis" = orbital point, number = seconds, or body/vessel name (e.g., "Mun"). If omitted, auto-detects (moon return > node > SOI).'),
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
      const knownTargets = ['node', 'soi', 'periapsis', 'apoapsis', 'reentry'];

      // Get trajectory info for smart decisions
      const trajInfo = await getTrajectoryInfo(conn);

      // Auto-detect target if 'auto'
      if (target === 'auto') {
        // Check for maneuver node first
        if (trajInfo.hasNode) {
          target = 'node';
          logger.info('[Warp] Computer recommends: course to maneuver node');
        } else if (trajInfo.hasSOIChange) {
          // Check for moon return scenario (escaping moon to parent body)
          const moonReturn = await detectMoonReturn(conn);
          if (moonReturn.isMoonReturn) {
            target = 'reentry';
            logger.info(`[Warp] Moon return detected - warping to ${moonReturn.parentBody} atmosphere edge`);
          } else {
            target = 'soi';
            logger.info('[Warp] Computer recommends: course to planetary encounter');
          }
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
