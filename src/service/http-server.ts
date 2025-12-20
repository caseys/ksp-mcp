import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  handleDisconnect,
  handleStatus,
  handleExecute,
  getConnection,
  ensureConnected,
  setCpuPreference,
  getCpuPreference,
  forceDisconnect,
} from '../transport/connection-tools.js';
import {
  listCpusInputSchema,
  handleListCpus,
} from '../transport/list-cpus.js';
import {
  CONNECTION_GUIDE,
  CPU_MENU_FORMAT,
  TRANSPORT_OPTIONS,
} from '../config/mcp-resources.js';
import { AscentProgram, AscentHandle } from '../lib/mechjeb/ascent.js';
import { clearNodes } from '../lib/kos/nodes.js';
import { getShipTelemetry, formatTargetEncounterInfo, getOrbitInfo, type ShipTelemetryOptions } from '../lib/mechjeb/telemetry.js';
import { queryTargetEncounterInfo } from '../lib/mechjeb/shared.js';
import { ManeuverOrchestrator } from '../lib/mechjeb/orchestrator.js';
import { executeNode, getNodeProgress } from '../lib/mechjeb/execute-node.js';
import { warpTo, warpForward, WarpTarget } from '../lib/kos/warp.js';
import { crashAvoidance } from '../lib/kos/crash-avoidance.js';
import { globalKosMonitor } from '../utils/kos-monitor.js';
import { listQuicksaves, quicksave, quickload } from '../lib/kos/kuniverse.js';
import { runScript } from '../lib/kos/run-script.js';

// Track current ascent handle for status/abort
let currentAscentHandle: AscentHandle | null = null;

const INLINE_TELEMETRY_OPTIONS: ShipTelemetryOptions = {
  timeoutMs: 2500,  // Per-query timeout (max 2 queries = 5s max)
};

const FULL_TELEMETRY_OPTIONS: ShipTelemetryOptions = {
  timeoutMs: 3000,  // Per-query timeout for standalone telemetry (max 2 queries = 6s max)
};

/**
 * Clear the current ascent handle.
 * Called when disconnecting to prevent stale handle issues.
 */
export function clearAscentHandle(): void {
  currentAscentHandle = null;
}

const DEBUG = process.env.KSP_MCP_DEBUG === '1';

/**
 * Helper to create a success response.
 */
function successResponse(action: string, text: string) {
  return {
    content: [{ type: 'text' as const, text }],
  };
}

/**
 * Helper to create an error response.
 * In debug mode, includes the raw error details.
 */
function errorResponse(action: string, error: string) {
  const text = DEBUG ? `${action}: ${error}` : error;
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  };
}

/**
 * Common zod schema for the execute parameter
 */
const executeSchema = z.boolean()
  .optional()
  .default(true)
  .describe('Execute the maneuver node after planning. Optional, defaults to true.');

/**
 * Common zod schema for the optional target parameter
 */
const targetSchema = z.string()
  .optional()
  .describe('Target name (body or vessel). If omitted, uses current target.');

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'ksp-mcp',
    version: '0.1.0',
  });

  // Register connection tools
  // Note: 'connect' is intentionally not exposed - all tools auto-connect via ensureConnected()

  server.registerTool(
    'launch_ascent',
    {
      description: 'Launch to orbit. Blocks until orbit achieved or aborted (up to 15 min).',
      inputSchema: {
        altitude: z.number().describe('Target orbit altitude in meters (e.g., 100000 for 100km)'),
        inclination: z.number().optional().default(0).describe('Target orbit inclination in degrees'),
        skipCircularization: z.boolean().optional().default(false).describe('Skip circularization burn (leaves in elliptical orbit)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { tier: 1 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();

        const ascent = new AscentProgram(conn);
        currentAscentHandle = await ascent.launchToOrbit({
          altitude: args.altitude,
          inclination: args.inclination,
          skipCircularization: args.skipCircularization,
          autoStage: true,
          autoWarp: true,
        });

        // Wait for ascent to complete (polls every 5 seconds, up to 15 min)
        const result = await currentAscentHandle.waitForCompletion();
        currentAscentHandle = null;

        return result.success ? successResponse('launch_ascent',
            `In orbit: Ap ${Math.round(result.finalOrbit.apoapsis / 1000)}km, Pe ${Math.round(result.finalOrbit.periapsis / 1000)}km`) : errorResponse('launch_ascent', result.aborted ? 'Ascent aborted' : 'Ascent failed');
      } catch (error) {
        return errorResponse('launch_ascent', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'circularize',
    {
      description: 'Circularize the orbit. Auto-detects best timing if not specified.',
      inputSchema: {
        timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
          .optional()
          .describe('When to circularize. If omitted, auto-picks based on orbit (periapsis for hyperbolic, nearest apse for elliptical)'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 1 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();

        // Auto-detect best timeRef if not specified
        let timeRef = args.timeRef;
        if (!timeRef) {
          const orbitInfo = await conn.execute(
            'PRINT SHIP:ORBIT:ECCENTRICITY + "|" + ETA:APOAPSIS + "|" + ETA:PERIAPSIS.'
          );
          const parts = orbitInfo.output.split('|').map(s => Number.parseFloat(s.trim()));
          const [ecc, etaApo, etaPe] = parts;

          if (ecc >= 1) {
            // Hyperbolic orbit - no apoapsis exists
            timeRef = 'PERIAPSIS';
          } else {
            // Elliptical orbit - pick whichever is sooner
            timeRef = etaApo < etaPe ? 'APOAPSIS' : 'PERIAPSIS';
          }
        }

        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.circularize(timeRef!, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('circularize',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('circularize', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('circularize', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'adjust_apoapsis',
    {
      description: 'Set a new high point (apoapsis) in the orbit.',
      inputSchema: {
        altitude: z.number().describe('Target apoapsis altitude in meters'),
        timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
          .optional()
          .default('PERIAPSIS')
          .describe('When to execute the maneuver'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.adjustApoapsis(args.altitude, args.timeRef, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('adjust_ap',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('adjust_ap', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('adjust_ap', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'adjust_periapsis',
    {
      description: 'Set a new low point (periapsis) in the orbit.',
      inputSchema: {
        altitude: z.number().describe('Target periapsis altitude in meters'),
        timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
          .optional()
          .default('APOAPSIS')
          .describe('When to execute the maneuver'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.adjustPeriapsis(args.altitude, args.timeRef, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('adjust_pe',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('adjust_pe', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('adjust_pe', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'ellipticize',
    {
      description: 'Set both periapsis and apoapsis in one maneuver.',
      inputSchema: {
        periapsis: z.number().describe('Target periapsis altitude in meters'),
        apoapsis: z.number().describe('Target apoapsis altitude in meters'),
        timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
          .optional()
          .default('APOAPSIS')
          .describe('When to execute the maneuver'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.ellipticize(args.periapsis, args.apoapsis, args.timeRef, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('ellipticize',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('ellipticize', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('ellipticize', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'change_inclination',
    {
      description: 'Change orbital inclination.',
      inputSchema: {
        newInclination: z.number().describe('Target inclination in degrees'),
        timeRef: z.enum(['EQ_ASCENDING', 'EQ_DESCENDING', 'EQ_NEAREST_AD', 'EQ_HIGHEST_AD', 'X_FROM_NOW'])
          .optional()
          .default('EQ_NEAREST_AD')
          .describe('When to execute: at ascending node, descending node, nearest AN/DN, or highest AD'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.changeInclination(args.newInclination, args.timeRef, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('change_inclination',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('change_inclination', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('change_inclination', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'change_ascending_node',
    {
      description: 'Change longitude of ascending node (LAN).',
      inputSchema: {
        lan: z.number().describe('Target LAN in degrees (0 to 360)'),
        timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
          .optional()
          .default('APOAPSIS')
          .describe('When to execute the maneuver'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.changeLAN(args.lan, args.timeRef, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('change_ascending_node',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('change_ascending_node', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('change_ascending_node', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'change_periapsis_longitude',
    {
      description: 'Change longitude of periapsis (rotates orbit).',
      inputSchema: {
        longitude: z.number().describe('Target longitude in degrees (-180 to 180)'),
        timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
          .optional()
          .default('APOAPSIS')
          .describe('When to execute the maneuver'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.changeLongitude(args.longitude, args.timeRef, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('change_periapsis_longitude',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('change_periapsis_longitude', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('change_periapsis_longitude', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'change_semi_major_axis',
    {
      description: 'Change semi-major axis (affects orbital period).',
      inputSchema: {
        semiMajorAxis: z.number().describe('Target semi-major axis in meters'),
        timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
          .optional()
          .default('APOAPSIS')
          .describe('When to execute the maneuver'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.changeSemiMajorAxis(args.semiMajorAxis, args.timeRef, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('change_semi_major_axis',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('change_semi_major_axis', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('change_semi_major_axis', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'change_eccentricity',
    {
      description: 'Change orbital eccentricity (0=circular, higher=more elliptical).',
      inputSchema: {
        eccentricity: z.number().min(0).max(0.99).describe('Target eccentricity (0 = circular, <1 = elliptical)'),
        timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
          .optional()
          .default('APOAPSIS')
          .describe('When to execute the maneuver'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.changeEccentricity(args.eccentricity, args.timeRef, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('change_eccentricity',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('change_eccentricity', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('change_eccentricity', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'hohmann_transfer',
    {
      description: 'Hohmann transfer to target body or vessel.',
      inputSchema: {
        target: targetSchema,
        timeReference: z.enum(['COMPUTED', 'PERIAPSIS', 'APOAPSIS'])
          .optional()
          .default('COMPUTED')
          .describe('When to execute: COMPUTED (optimal), PERIAPSIS, or APOAPSIS'),
        capture: z.boolean()
          .optional()
          .default(false)
          .describe('Include capture burn for vessel rendezvous. Default: false (transfer only).'),
        execute: executeSchema,
        includeTelemetry: z.boolean()
          .optional()
          .default(false)
          .describe('Include ship telemetry in response (slower but more info)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 1 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.hohmannTransfer(args.timeReference, args.capture, { target: args.target, execute: args.execute });

        if (result.success) {
          const nodeCount = result.nodesCreated ?? 1;
          const execInfo = result.executed ? ' (executed)' : '';
          let text = `${nodeCount} node(s): ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`;

          if (args.includeTelemetry) {
            // Query target encounter info
            const targetInfo = await queryTargetEncounterInfo(conn);
            if (targetInfo) {
              text += '\n\n' + formatTargetEncounterInfo(targetInfo);
            }
            text += '\n\n' + await getShipTelemetry(conn, INLINE_TELEMETRY_OPTIONS);
          }

          return successResponse('hohmann', text);
        } else {
          return errorResponse('hohmann', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('hohmann', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'course_correct',
    {
      description: 'Fine-tune approach to target with a course correction.',
      inputSchema: {
        target: targetSchema,
        targetDistance: z.number().describe('Target periapsis (bodies) or closest approach (vessels) in meters'),
        execute: executeSchema,
        includeTelemetry: z.boolean()
          .optional()
          .default(false)
          .describe('Include ship telemetry in response (slower but more info)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 1 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.courseCorrection(args.targetDistance, { target: args.target, execute: args.execute });

        if (!result.success) {
          return errorResponse('course_correct', result.error ?? 'Failed');
        }

        const execInfo = result.executed ? ' (executed)' : '';
        let text = `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`;

        if (args.includeTelemetry) {
          // Query target encounter info
          const targetInfo = await queryTargetEncounterInfo(conn);
          if (targetInfo) {
            text += '\n\n' + formatTargetEncounterInfo(targetInfo);
          }
          text += '\n\n' + await getShipTelemetry(conn, INLINE_TELEMETRY_OPTIONS);
        }

        return successResponse('course_correct', text);
      } catch (error) {
        return errorResponse('course_correct', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'match_planes',
    {
      description: 'Match orbital plane with target (plane change maneuver).',
      inputSchema: {
        target: targetSchema,
        timeRef: z.enum(['REL_NEAREST_AD', 'REL_HIGHEST_AD', 'REL_ASCENDING', 'REL_DESCENDING'])
          .optional()
          .default('REL_NEAREST_AD')
          .describe('When to execute: nearest AN/DN, highest AN/DN, ascending node, or descending node'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 1 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.matchPlane(args.timeRef, { target: args.target, execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('match_planes',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('match_planes', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('match_planes', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'match_velocities',
    {
      description: 'Match velocity with target (rendezvous maneuver).',
      inputSchema: {
        target: targetSchema,
        timeRef: z.enum(['CLOSEST_APPROACH', 'X_FROM_NOW'])
          .optional()
          .default('CLOSEST_APPROACH')
          .describe('When to execute: at closest approach or after X seconds'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.killRelVel(args.timeRef, { target: args.target, execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('match_velocities',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('match_velocities', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('match_velocities', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'interplanetary_transfer',
    {
      description: 'Plan interplanetary transfer to target planet.',
      inputSchema: {
        target: targetSchema,
        waitForPhaseAngle: z.boolean()
          .optional()
          .default(true)
          .describe('If true, waits for optimal phase angle. If false, transfers immediately.'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.interplanetaryTransfer(args.waitForPhaseAngle, { target: args.target, execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('interplanetary',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('interplanetary', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('interplanetary', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'return_from_moon',
    {
      description: 'Return from moon to parent body.',
      inputSchema: {
        targetPeriapsis: z.number().describe('Target periapsis at parent body in meters (e.g., 100000 for 100km)'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.returnFromMoon(args.targetPeriapsis, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('return_from_moon',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('return_from_moon', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('return_from_moon', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'resonant_orbit',
    {
      description: 'Create resonant orbit for constellation deployment.',
      inputSchema: {
        numerator: z.number().int().positive().describe('Numerator of resonance ratio (e.g., 2 for 2:3)'),
        denominator: z.number().int().positive().describe('Denominator of resonance ratio (e.g., 3 for 2:3)'),
        timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW'])
          .optional()
          .default('APOAPSIS')
          .describe('When to execute the maneuver'),
        execute: executeSchema,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.resonantOrbit(args.numerator, args.denominator, args.timeRef, { execute: args.execute });

        if (result.success) {
          const execInfo = result.executed ? ' (executed)' : '';
          return successResponse('resonant_orbit',
            `Node: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s${execInfo}`);
        } else {
          return errorResponse('resonant_orbit', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('resonant_orbit', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'set_target',
    {
      description: 'Set target for transfers. Prefer using target parameter on maneuver tools instead.',
      inputSchema: {
        name: z.string().describe('Name of target (e.g., "Mun", "Minmus", vessel name)'),
        type: z.enum(['auto', 'body', 'vessel']).optional().default('auto')
          .describe('Target type: "auto" tries name directly, "body" for celestial bodies, "vessel" for ships'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { tier: 3 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);

        const result = await orchestrator.setTarget(args.name, args.type);
        if (!result.success) {
          return errorResponse('set_target', result.error ?? `Failed to set target "${args.name}"`);
        }

        return successResponse('set_target', `Target: ${result.name} (${result.type})`);
      } catch (error) {
        return errorResponse('set_target', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'get_target',
    {
      description: 'Get information about the current target.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async () => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);

        const info = await orchestrator.getTargetInfo();
        if (!info.hasTarget) {
          return successResponse('get_target', 'No target set.');
        }

        return successResponse('get_target', info.details ?? `Target: ${info.name}`);
      } catch (error) {
        return errorResponse('get_target', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'clear_target',
    {
      description: 'Clear the current target.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async () => {
      try {
        const conn = await ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.clearTarget();

        if (result.cleared) {
          return successResponse('clear_target', 'Target cleared.');
        }

        return successResponse('clear_target', result.warning ?? 'Clear command sent.');
      } catch (error) {
        return errorResponse('clear_target', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'execute_node',
    {
      description: 'Execute the next maneuver node. Prefer using execute parameter on maneuver tools instead.',
      inputSchema: {
        async: z.boolean()
          .optional()
          .default(false)
          .describe('If true, return immediately after starting executor instead of waiting for completion'),
        timeoutSeconds: z.number()
          .optional()
          .default(240)
          .describe('Maximum time to wait for node execution in seconds (default: 240 = 4 minutes)'),
        includeTelemetry: z.boolean()
          .optional()
          .default(false)
          .describe('Include ship telemetry in response (slower but more info)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { tier: 3 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const result = await executeNode(conn, {
          timeoutMs: args.timeoutSeconds * 1000,
          async: args.async,
        });

        if (result.success) {
          let text: string;
          text = args.async ? `Executor started: ${result.deltaV?.required.toFixed(1)} m/s required` : `Node executed: ${result.nodesExecuted} node(s)`;

          if (args.includeTelemetry) {
            // Query target encounter info
            const targetInfo = await queryTargetEncounterInfo(conn);
            if (targetInfo) {
              text += '\n\n' + formatTargetEncounterInfo(targetInfo);
            }
            text += '\n\n' + await getShipTelemetry(conn, INLINE_TELEMETRY_OPTIONS);
          }

          return successResponse('execute_node', text);
        } else {
          return errorResponse('execute_node', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('execute_node', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'telemetry',
    {
      description: 'Get current ship telemetry including orbit, SOI, maneuver nodes, and encounters.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async () => {
      try {
        const conn = await ensureConnected();
        const telemetry = await getShipTelemetry(conn, FULL_TELEMETRY_OPTIONS);
        return successResponse('telemetry', telemetry);
      } catch (error) {
        return errorResponse('telemetry', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'orbit_info',
    {
      description: 'Get quick orbital parameters (apoapsis, periapsis, period, inclination, eccentricity, LAN).',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async () => {
      try {
        const conn = await ensureConnected();
        const info = await getOrbitInfo(conn);
        return successResponse('orbit_info',
          `Ap: ${(info.apoapsis / 1000).toFixed(1)}km, Pe: ${(info.periapsis / 1000).toFixed(1)}km, ` +
          `Period: ${info.period.toFixed(0)}s, Inc: ${info.inclination.toFixed(1)}°, ` +
          `Ecc: ${info.eccentricity.toFixed(4)}, LAN: ${info.lan.toFixed(1)}°`);
      } catch (error) {
        return errorResponse('orbit_info', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'node_progress',
    {
      description: 'Get current maneuver node execution progress (nodes remaining, ETA, throttle, executing status).',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async () => {
      try {
        const conn = await ensureConnected();
        const progress = await getNodeProgress(conn);

        if (progress.nodesRemaining === 0) {
          return successResponse('node_progress', 'No maneuver nodes.');
        }

        const execStatus = progress.executing ? 'Burning' : 'Waiting';
        return successResponse('node_progress',
          `${execStatus}: ${progress.nodesRemaining} node(s), ` +
          `T-${progress.etaToNode.toFixed(0)}s, Throttle: ${(progress.throttle * 100).toFixed(0)}%`);
      } catch (error) {
        return errorResponse('node_progress', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'clear_nodes',
    {
      description: 'Remove all maneuver nodes.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 2 },
    },
    async () => {
      try {
        const conn = await ensureConnected();
        const result = await clearNodes(conn);

        return result.success ? successResponse('clear_nodes', `Cleared ${result.nodesCleared} node(s)`) : errorResponse('clear_nodes', result.error ?? 'Failed to clear nodes');
      } catch (error) {
        return errorResponse('clear_nodes', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'command',
    {
      description: 'Run raw kOS script - advanced use.',
      inputSchema: {
        command: z.string().describe('kOS script command to send'),
        timeout: z.number().optional().default(5000).describe('Command timeout in milliseconds'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { tier: -1 },
    },
    async (args) => {
      const result = await handleExecute(args);
      return result.success ? successResponse('command', result.output || '(no output)') : errorResponse('command', result.error ?? 'Failed');
    }
  );

  // =============================================================================
  // SCRIPT EXECUTION
  // =============================================================================

  server.registerTool(
    'run_script',
    {
      description: 'Run a kOS script file. Copies script to KSP Archive (Ships/Script) and executes it. LIMITATION: Scripts using TERMINAL:INPUT will hang - use only non-interactive scripts.',
      inputSchema: {
        sourcePath: z.string().describe('Absolute path to the .ks script file to run'),
        timeout: z.number()
          .optional()
          .default(60_000)
          .describe('Maximum execution time in milliseconds (default: 60000 = 1 minute)'),
        cleanup: z.boolean()
          .optional()
          .default(true)
          .describe('Delete script from Archive after execution (default: true)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const result = await runScript(conn, args.sourcePath, {
          timeout: args.timeout,
          cleanup: args.cleanup,
        });

        if (result.success) {
          const outputPreview = result.output.slice(-30).join('\n');
          const timeStr = result.executionTime ? `${(result.executionTime / 1000).toFixed(1)}s` : 'unknown';
          return successResponse('run_script',
            `Script completed in ${timeStr}\n\nOutput (last 30 lines):\n${outputPreview}`);
        } else {
          const outputPreview = result.output.slice(-20).join('\n');
          return errorResponse('run_script',
            `${result.error}\n\nOutput:\n${outputPreview}`);
        }
      } catch (error) {
        return errorResponse('run_script',
          error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'status',
    {
      description: 'Get current kOS connection status. Note: All tools auto-connect when needed.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async () => {
      const state = await handleStatus();
      const text = state.connected
        ? `Connected to CPU ${state.cpuId} on ${state.vesselName}`
        : 'Ready for automated maneuver planning with kOS and MechJeb.';
      return successResponse('status', text);
    }
  );

  server.registerTool(
    'disconnect',
    {
      description: 'Disconnect from kOS terminal.',
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async () => {
      try {
        await handleDisconnect();
        return successResponse('disconnect', 'Disconnected successfully.');
      } catch (error) {
        return errorResponse('disconnect', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'list_cpus',
    {
      description: 'List available kOS CPUs without connecting.',
      inputSchema: listCpusInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async (args) => {
      try {
        const cpus = await handleListCpus(args);
        const text = cpus.length > 0
          ? `Found ${cpus.length} CPU(s):\n` + cpus.map(c => `  ${c.id}: ${c.vessel} (${c.tag || 'no tag'})`).join('\n')
          : 'No CPUs found';
        return successResponse('list_cpus', text);
      } catch (error) {
        return errorResponse('list_cpus', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    'switch_cpu',
    {
      description: 'Switch to a different kOS CPU. Only needed when multiple CPUs exist.',
      inputSchema: {
        cpuId: z.number().optional().describe('CPU ID (1-based) to switch to'),
        cpuLabel: z.string().optional().describe('CPU label/tag (e.g., "guidance") to switch to'),
        clear: z.boolean().optional().describe('Clear preference and revert to auto-select'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: -1 },
    },
    async (args) => {
      try {
        if (args.clear) {
          setCpuPreference(null);
          await forceDisconnect();
          return successResponse('switch_cpu', 'CPU preference cleared.');
        }

        if (args.cpuId === undefined && args.cpuLabel === undefined) {
          const current = getCpuPreference();
          if (current) {
            const desc = current.cpuLabel ? `label="${current.cpuLabel}"` : `id=${current.cpuId}`;
            return successResponse('switch_cpu', `Current: ${desc}`);
          }
          return successResponse('switch_cpu', 'Auto-select (no preference).');
        }

        setCpuPreference({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const desc = args.cpuLabel ? `label="${args.cpuLabel}"` : `id=${args.cpuId}`;
        return successResponse('switch_cpu', `Switched to ${desc}`);
      } catch (error) {
        return errorResponse('switch_cpu', error instanceof Error ? error.message : String(error));
      }
    }
  );

  // Register resources (documentation)
  server.resource(
    'kos-connection-guide',
    'kos://connection-guide',
    async () => ({
      contents: [{
        uri: 'kos://connection-guide',
        mimeType: 'text/markdown',
        text: CONNECTION_GUIDE,
      }],
    })
  );

  server.resource(
    'kos-cpu-menu-format',
    'kos://cpu-menu-format',
    async () => ({
      contents: [{
        uri: 'kos://cpu-menu-format',
        mimeType: 'text/markdown',
        text: CPU_MENU_FORMAT,
      }],
    })
  );

  server.resource(
    'kos-transport-options',
    'kos://transport-options',
    async () => ({
      contents: [{
        uri: 'kos://transport-options',
        mimeType: 'text/markdown',
        text: TRANSPORT_OPTIONS,
      }],
    })
  );

  // Monitoring resources
  server.resource(
    'kos-status',
    'kos://status',
    async () => {
      const conn = getConnection();
      const connState = conn?.getState();
      const status = globalKosMonitor.getStatus();

      return {
        contents: [{
          uri: 'kos://status',
          mimeType: 'application/json',
          text: JSON.stringify({
            connected: conn?.isConnected() || false,
            cpuId: connState?.cpuId || null,
            vessel: connState?.vesselName || null,
            lastError: status.lastError,
            errorCount: status.errorCount,
            isLooping: status.isLooping,
            hasErrors: status.hasErrors,
          }, null, 2),
        }],
      };
    }
  );

  // Time Warp Tool
  server.registerTool(
    'warp',
    {
      description: 'Time warp to an event: "soi" (SOI change), "node" (next maneuver), "periapsis", "apoapsis", or a number of seconds.',
      inputSchema: {
        target: z.enum(['node', 'soi', 'periapsis', 'apoapsis'])
          .or(z.number())
          .describe('Warp target: "node", "soi", "periapsis", "apoapsis", or a number of seconds to warp forward'),
        leadTime: z.number()
          .optional()
          .default(60)
          .describe('Seconds before target to stop warping (default: 60)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 1 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();

        const result = await (typeof args.target === 'number' ? warpForward(conn, args.target) : warpTo(conn, args.target as WarpTarget, { leadTime: args.leadTime }));

        if (result.success) {
          let msg = `Warp complete: ${result.body}, ${((result.altitude || 0) / 1000).toFixed(0)}km`;
          if (result.periapsis !== undefined) {
            msg += `, periapsis: ${(result.periapsis / 1000).toFixed(0)}km`;
          }
          if (result.warning) {
            msg += `\n\n${result.warning}`;
          }
          return successResponse('warp', msg);
        } else {
          return errorResponse('warp', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('warp', error instanceof Error ? error.message : String(error));
      }
    }
  );

  // Crash Avoidance Tool
  server.registerTool(
    'crash_avoidance',
    {
      description: 'Emergency burn to raise periapsis above safe altitude. Uses RCS, SAS radial-out, and full throttle with auto-staging.',
      inputSchema: {
        targetPeriapsis: z.number()
          .optional()
          .default(10_000)
          .describe('Target periapsis in meters (default: 10000 = 10km)'),
        timeoutMs: z.number()
          .optional()
          .default(300_000)
          .describe('Maximum burn time in milliseconds (default: 300000 = 5 min)'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { tier: 1 },
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const result = await crashAvoidance(conn, {
          targetPeriapsis: args.targetPeriapsis,
          timeoutMs: args.timeoutMs,
        });

        return result.success ? successResponse('crash_avoidance',
            `Crash avoided! Pe: ${result.initialPeriapsis?.toFixed(0)}m → ${result.finalPeriapsis?.toFixed(0)}m, ΔV: ${result.deltaVUsed?.toFixed(1)} m/s, Stages: ${result.stagesUsed}`
          ) : errorResponse('crash_avoidance', result.error ?? 'Burn failed');
      } catch (error) {
        return errorResponse('crash_avoidance', error instanceof Error ? error.message : String(error));
      }
    }
  );

  // Save/Load Tools (using kuniverse library)
  server.registerTool(
    'load_save',
    {
      description: 'Load a KSP quicksave. Connection will be reset after load.',
      inputSchema: {
        saveName: z.string().describe('Name of the quicksave to load (e.g., "test-in-orbit")'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      _meta: { tier: 2 },
    },
    async (args) => {
      const conn = await ensureConnected();
      const result = await quickload(conn, args.saveName);

      return result.success ? successResponse('load_save', `Loading: ${result.saveName}`) : errorResponse('load_save', result.error ?? 'Failed');
    }
  );

  server.registerTool(
    'list_saves',
    {
      description: 'List available KSP quicksaves.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async () => {
      const conn = await ensureConnected();
      const result = await listQuicksaves(conn);

      if (result.success) {
        const savesList = result.saves.length > 0
          ? result.saves.join(', ')
          : '(none)';
        return successResponse('list_saves', `Saves: ${savesList}`);
      } else {
        return errorResponse('list_saves', result.error ?? 'Failed');
      }
    }
  );

  server.registerTool(
    'quicksave',
    {
      description: 'Create a KSP quicksave with the given name.',
      inputSchema: {
        saveName: z.string().describe('Name for the quicksave'),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { tier: 3 },
    },
    async (args) => {
      const conn = await ensureConnected();
      const result = await quicksave(conn, args.saveName);

      return result.success ? successResponse('quicksave', `Saved: ${result.saveName}`) : errorResponse('quicksave', result.error ?? 'Failed');
    }
  );

  server.resource(
    'kos-terminal-recent',
    'kos://terminal/recent',
    async () => {
      const status = globalKosMonitor.getStatus();

      return {
        contents: [{
          uri: 'kos://terminal/recent',
          mimeType: 'application/json',
          text: JSON.stringify({
            recentLines: status.recentLines,
            hasErrors: status.hasErrors,
            isLooping: status.isLooping,
            errorPattern: status.errorPattern,
            errorCount: status.errorCount,
            summary: globalKosMonitor.getSummary(),
          }, null, 2),
        }],
      };
    }
  );

  return server;
}
