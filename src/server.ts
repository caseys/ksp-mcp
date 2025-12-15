import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  connectionToolDefinitions,
  connectInputSchema,
  executeInputSchema,
  handleConnect,
  handleDisconnect,
  handleStatus,
  handleExecute,
  getConnection,
  ensureConnected,
} from './tools/connection-tools.js';
import {
  listCpusInputSchema,
  handleListCpus,
} from './tools/list-cpus.js';
import {
  CONNECTION_GUIDE,
  CPU_MENU_FORMAT,
  TRANSPORT_OPTIONS,
} from './resources/content.js';
import { ManeuverProgram } from './mechjeb/programs/maneuver.js';
import { AscentProgram, AscentHandle } from './mechjeb/programs/ascent.js';
import { getShipTelemetry, type ShipTelemetryOptions } from './mechjeb/telemetry.js';
// New modular operations
import { ellipticize, changeSemiMajorAxis } from './mechjeb/programs/basic/index.js';
import { changeEccentricity, changeLAN, changeLongitudeOfPeriapsis } from './mechjeb/programs/orbital/index.js';
import { matchPlane, killRelativeVelocity } from './mechjeb/programs/rendezvous/index.js';
import { resonantOrbit, returnFromMoon, interplanetaryTransfer } from './mechjeb/programs/transfer/index.js';
import { executeNode } from './mechjeb/programs/node/index.js';
import { warpTo, warpForward, WarpTarget } from './mechjeb/programs/warp.js';
import { immediateTimeWarpKick, installTimeWarpKickTrigger } from './utils/time-warp-kick.js';
import { globalKosMonitor } from './monitoring/kos-monitor.js';
import { listQuicksaves, quicksave, quickload } from './kuniverse/index.js';

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

/**
 * Helper to create a success response with structured content.
 */
function successResponse(
  action: string,
  text: string,
  data?: Record<string, unknown>
) {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: {
      status: 'success' as const,
      action,
      ...data
    }
  };
}

/**
 * Helper to create an error response with structured content.
 */
function errorResponse(
  action: string,
  text: string,
  reason: string
) {
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
    structuredContent: {
      status: 'error' as const,
      action,
      reason
    }
  };
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'ksp-mcp',
    version: '0.1.0',
  });

  // Register connection tools
  // Note: 'connect' is intentionally not exposed - all tools auto-connect via ensureConnected()

  server.tool(
    'disconnect',
    'Disconnect from kOS terminal',
    {},
    async () => {
      try {
        await handleDisconnect();
        return successResponse('disconnect', 'Disconnected successfully.');
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('disconnect', `Disconnect failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'status',
    'Get current kOS connection status',
    {},
    async () => {
      const state = await handleStatus();
      return successResponse('status', JSON.stringify(state, null, 2), { ...state });
    }
  );

  server.tool(
    'clear_nodes',
    'Remove all maneuver nodes',
    {},
    async () => {
      try {
        const conn = await ensureConnected();
        await conn.execute(
          'SET _N TO ALLNODES:LENGTH. UNTIL NOT HASNODE { REMOVE NEXTNODE. } PRINT "Cleared " + _N + " node(s)".',
          5000
        );
        return successResponse('clear_nodes', 'Maneuver nodes cleared!');
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('clear_nodes', `Clear nodes failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'list_cpus',
    'List available kOS CPUs without connecting.',
    listCpusInputSchema.shape,
    async (args) => {
      try {
        const cpus = await handleListCpus(args);
        const text = cpus.length > 0
          ? `Found ${cpus.length} CPU(s):\n` + JSON.stringify(cpus, null, 2)
          : 'No CPUs found';
        return successResponse('list_cpus', text, { cpus });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('list_cpus', `List CPUs failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'execute',
    'Execute a raw kOS command and return the output.',
    {
      command: z.string().describe('kOS command to execute'),
      timeout: z.number().default(5000).describe('Command timeout in milliseconds'),
    },
    async (args) => {
      const result = await handleExecute(args);
      if (result.success) {
        return successResponse('execute', result.output || '(no output)', { output: result.output });
      } else {
        const reason = result.error ?? 'Unknown error';
        return errorResponse('execute', `Execute failed: ${reason}\nOutput: ${result.output}`, reason);
      }
    }
  );

  // Telemetry Tool
  server.tool(
    'telemetry',
    'Get current ship telemetry including orbit, SOI, maneuver nodes, and encounters.',
    {
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const telemetry = await getShipTelemetry(conn, FULL_TELEMETRY_OPTIONS);
        // telemetry is a formatted string; include raw text in data too
        return successResponse('telemetry', telemetry, { telemetry });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('telemetry', `Telemetry failed: ${reason}`, reason);
      }
    }
  );

  // MechJeb Maneuver Tools
  server.tool(
    'adjust_pe',
    'Create a maneuver node to change periapsis. Cannot raise periapsis above current apoapsis.',
    {
      altitude: z.number().describe('Target periapsis altitude in meters'),
      timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
        .default('APOAPSIS')
        .describe('When to execute the maneuver'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.adjustPeriapsis(args.altitude, args.timeRef);

        if (result.success) {
          return successResponse('adjust_pe',
            `Periapsis change planned!\n` +
              `  Target Pe: ${args.altitude / 1000} km\n` +
              `  Time ref: ${args.timeRef}\n` +
              `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
              `  Time to node: ${result.timeToNode?.toFixed(0)} s`,
            {
              targetAltitude: args.altitude,
              timeRef: args.timeRef,
              deltaV: result.deltaV,
              timeToNode: result.timeToNode
            }
          );
        } else {
          return errorResponse('adjust_pe', `Periapsis change failed: ${result.error}`, result.error ?? 'Unknown error');
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('adjust_pe', `Periapsis change failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'adjust_ap',
    'Create a maneuver node to change apoapsis.',
    {
      altitude: z.number().describe('Target apoapsis altitude in meters'),
      timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
        .default('PERIAPSIS')
        .describe('When to execute the maneuver'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.adjustApoapsis(args.altitude, args.timeRef);

        if (result.success) {
          return successResponse('adjust_ap',
            `Apoapsis change planned!\n` +
              `  Target Ap: ${args.altitude / 1000} km\n` +
              `  Time ref: ${args.timeRef}\n` +
              `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
              `  Time to node: ${result.timeToNode?.toFixed(0)} s`,
            {
              targetAltitude: args.altitude,
              timeRef: args.timeRef,
              deltaV: result.deltaV,
              timeToNode: result.timeToNode
            }
          );
        } else {
          return errorResponse('adjust_ap', `Apoapsis change failed: ${result.error}`, result.error ?? 'Unknown error');
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('adjust_ap', `Apoapsis change failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'circularize',
    'Create a maneuver node to circularize the orbit.',
    {
      timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
        .default('APOAPSIS')
        .describe('When to circularize (usually at apoapsis or periapsis)'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.circularize(args.timeRef);

        if (result.success) {
          return successResponse('circularize',
            `Circularization planned!\n` +
              `  Time ref: ${args.timeRef}\n` +
              `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
              `  Time to node: ${result.timeToNode?.toFixed(0)} s`,
            {
              timeRef: args.timeRef,
              deltaV: result.deltaV,
              timeToNode: result.timeToNode
            }
          );
        } else {
          return errorResponse('circularize', `Circularization failed: ${result.error}`, result.error ?? 'Unknown error');
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('circularize', `Circularization failed: ${reason}`, reason);
      }
    }
  );

  // Target and Transfer Tools

  server.tool(
    'hohmann',
    'Plan a Hohmann transfer to the current target. Requires a target to be set first.',
    {
      timeReference: z.enum(['COMPUTED', 'PERIAPSIS', 'APOAPSIS'])
        .default('COMPUTED')
        .describe('When to execute: COMPUTED (optimal), PERIAPSIS, or APOAPSIS'),
      capture: z.boolean()
        .default(true)
        .describe('Include capture/insertion burn (creates 2 nodes). If false, only transfer burn (1 node)'),
      includeTelemetry: z.boolean()
        .default(false)
        .describe('Include ship telemetry in response (slower but more info)'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.hohmannTransfer(args.timeReference, args.capture);

        if (result.success) {
          const nodeCount = args.capture ? 2 : 1;
          let text = `Hohmann transfer planned!\n` +
            `  Nodes created: ${nodeCount}\n` +
            `  Delta-V (first node): ${result.deltaV?.toFixed(1)} m/s\n` +
            `  Time to node: ${result.timeToNode?.toFixed(0)} s`;

          if (args.includeTelemetry) {
            text += '\n\n' + await getShipTelemetry(conn, INLINE_TELEMETRY_OPTIONS);
          }

          return successResponse('hohmann', text, {
            nodesCreated: nodeCount,
            capture: args.capture,
            timeReference: args.timeReference,
            deltaV: result.deltaV,
            timeToNode: result.timeToNode
          });
        } else {
          return errorResponse('hohmann', `Hohmann transfer failed: ${result.error}`, result.error ?? 'Unknown error');
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('hohmann', `Hohmann transfer failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'course_correct',
    'Fine-tune closest approach to target. Requires target to be set first.',
    {
      targetDistance: z.number().describe('Target periapsis (bodies) or closest approach (vessels) in meters'),
      minLeadTime: z.number()
        .default(300)
        .describe('Minimum seconds before burn (default: 300s). Node rejected if too soon.'),
      includeTelemetry: z.boolean()
        .default(false)
        .describe('Include ship telemetry in response (slower but more info)'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });

        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.courseCorrection(args.targetDistance, args.minLeadTime);

        if (!result.success) {
          return errorResponse('course_correct', `Course correction failed: ${result.error}`, result.error ?? 'Unknown error');
        }

        let text = `Course correction planned!\n` +
              `  Target approach: ${args.targetDistance / 1000} km\n` +
              `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
              `  Time to node: ${result.timeToNode?.toFixed(0)} s`;

        if (args.includeTelemetry) {
          text += '\n\n' + await getShipTelemetry(conn, INLINE_TELEMETRY_OPTIONS);
        }

        return successResponse('course_correct', text, {
          targetDistance: args.targetDistance,
          deltaV: result.deltaV,
          timeToNode: result.timeToNode
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('course_correct', `Course correction failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'change_inc',
    'Change orbital inclination.',
    {
      newInclination: z.number().describe('Target inclination in degrees'),
      timeRef: z.enum(['EQ_ASCENDING', 'EQ_DESCENDING', 'EQ_NEAREST_AD', 'EQ_HIGHEST_AD', 'X_FROM_NOW'])
        .default('EQ_NEAREST_AD')
        .describe('When to execute: at ascending node, descending node, nearest AN/DN, or highest AD'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });

        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.changeInclination(args.newInclination, args.timeRef);

        if (!result.success) {
          return errorResponse('change_inc', `Inclination change failed: ${result.error}`, result.error ?? 'Unknown error');
        }

        return successResponse('change_inc',
          `Inclination change planned!\n` +
            `  Target inclination: ${args.newInclination}°\n` +
            `  Execution point: ${args.timeRef}\n` +
            `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
            `  Time to node: ${result.timeToNode?.toFixed(0)} s`,
          {
            targetInclination: args.newInclination,
            timeRef: args.timeRef,
            deltaV: result.deltaV,
            timeToNode: result.timeToNode
          }
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('change_inc', `Inclination change failed: ${reason}`, reason);
      }
    }
  );

  // New Modular MechJeb Operations
  server.tool(
    'ellipticize',
    'Set both periapsis and apoapsis in a single burn.',
    {
      periapsis: z.number().describe('Target periapsis altitude in meters'),
      apoapsis: z.number().describe('Target apoapsis altitude in meters'),
      timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
        .default('APOAPSIS')
        .describe('When to execute the maneuver'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const result = await ellipticize(conn, args.periapsis, args.apoapsis, args.timeRef);

        if (result.success) {
          return successResponse('ellipticize',
            `Orbit reshape planned!\n` +
              `  Target Pe: ${args.periapsis / 1000} km\n` +
              `  Target Ap: ${args.apoapsis / 1000} km\n` +
              `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
              `  Time to node: ${result.timeToNode?.toFixed(0)} s`,
            {
              targetPe: args.periapsis,
              targetAp: args.apoapsis,
              timeRef: args.timeRef,
              deltaV: result.deltaV,
              timeToNode: result.timeToNode
            }
          );
        } else {
          return errorResponse('ellipticize', `Orbit reshape failed: ${result.error}`, result.error ?? 'Unknown error');
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('ellipticize', `Orbit reshape failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'change_sma',
    'Change the orbital semi-major axis.',
    {
      semiMajorAxis: z.number().describe('Target semi-major axis in meters'),
      timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
        .default('APOAPSIS')
        .describe('When to execute the maneuver'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const result = await changeSemiMajorAxis(conn, args.semiMajorAxis, args.timeRef);

        if (result.success) {
          return successResponse('change_sma',
            `SMA change planned!\n` +
              `  Target SMA: ${args.semiMajorAxis / 1000} km\n` +
              `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
              `  Time to node: ${result.timeToNode?.toFixed(0)} s`,
            {
              targetSMA: args.semiMajorAxis,
              timeRef: args.timeRef,
              deltaV: result.deltaV,
              timeToNode: result.timeToNode
            }
          );
        } else {
          return errorResponse('change_sma', `SMA change failed: ${result.error}`, result.error ?? 'Unknown error');
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('change_sma', `SMA change failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'change_ecc',
    'Change orbital eccentricity.',
    {
      eccentricity: z.number().min(0).max(0.99).describe('Target eccentricity (0 = circular, <1 = elliptical)'),
      timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
        .default('APOAPSIS')
        .describe('When to execute the maneuver'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const result = await changeEccentricity(conn, args.eccentricity, args.timeRef);

        if (result.success) {
          return successResponse('change_ecc',
            `Eccentricity change planned!\n` +
              `  Target eccentricity: ${args.eccentricity}\n` +
              `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
              `  Time to node: ${result.timeToNode?.toFixed(0)} s`,
            {
              targetEccentricity: args.eccentricity,
              timeRef: args.timeRef,
              deltaV: result.deltaV,
              timeToNode: result.timeToNode
            }
          );
        } else {
          return errorResponse('change_ecc', `Eccentricity change failed: ${result.error}`, result.error ?? 'Unknown error');
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('change_ecc', `Eccentricity change failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'change_lan',
    'Change the Longitude of Ascending Node (LAN).',
    {
      lan: z.number().describe('Target LAN in degrees (0 to 360)'),
      timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
        .default('APOAPSIS')
        .describe('When to execute the maneuver'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const result = await changeLAN(conn, args.lan, args.timeRef);

        if (result.success) {
          return successResponse('change_lan',
            `LAN change planned!\n` +
              `  Target LAN: ${args.lan}°\n` +
              `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
              `  Time to node: ${result.timeToNode?.toFixed(0)} s`,
            {
              targetLAN: args.lan,
              timeRef: args.timeRef,
              deltaV: result.deltaV,
              timeToNode: result.timeToNode
            }
          );
        } else {
          return errorResponse('change_lan', `LAN change failed: ${result.error}`, result.error ?? 'Unknown error');
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('change_lan', `LAN change failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'change_lpe',
    'Change the Longitude of Periapsis.',
    {
      longitude: z.number().describe('Target longitude in degrees (-180 to 180)'),
      timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
        .default('APOAPSIS')
        .describe('When to execute the maneuver'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const result = await changeLongitudeOfPeriapsis(conn, args.longitude, args.timeRef);

        if (result.success) {
          return successResponse('change_lpe',
            `Periapsis longitude change planned!\n` +
              `  Target longitude: ${args.longitude}°\n` +
              `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
              `  Time to node: ${result.timeToNode?.toFixed(0)} s`,
            {
              targetLongitude: args.longitude,
              timeRef: args.timeRef,
              deltaV: result.deltaV,
              timeToNode: result.timeToNode
            }
          );
        } else {
          return errorResponse('change_lpe', `Periapsis longitude change failed: ${result.error}`, result.error ?? 'Unknown error');
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('change_lpe', `Periapsis longitude change failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'match_planes',
    'Match orbital plane with the target. Requires a target to be set first.',
    {
      timeRef: z.enum(['REL_NEAREST_AD', 'REL_HIGHEST_AD', 'REL_ASCENDING', 'REL_DESCENDING'])
        .default('REL_NEAREST_AD')
        .describe('When to execute: nearest AN/DN, highest AN/DN, ascending node, or descending node'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const result = await matchPlane(conn, args.timeRef);

        if (result.success) {
          return successResponse('match_planes',
            `Plane match planned!\n` +
              `  Execution point: ${args.timeRef}\n` +
              `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
              `  Time to node: ${result.timeToNode?.toFixed(0)} s`,
            {
              timeRef: args.timeRef,
              deltaV: result.deltaV,
              timeToNode: result.timeToNode
            }
          );
        } else {
          return errorResponse('match_planes', `Plane match failed: ${result.error}`, result.error ?? 'Unknown error');
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('match_planes', `Plane match failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'match_velocities',
    'Match velocity with the target. Requires a target to be set first.',
    {
      timeRef: z.enum(['CLOSEST_APPROACH', 'X_FROM_NOW'])
        .default('CLOSEST_APPROACH')
        .describe('When to execute: at closest approach or after X seconds'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const result = await killRelativeVelocity(conn, args.timeRef);

        if (result.success) {
          return successResponse('match_velocities',
            `Velocity match planned!\n` +
              `  Execution point: ${args.timeRef}\n` +
              `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
              `  Time to node: ${result.timeToNode?.toFixed(0)} s`,
            {
              timeRef: args.timeRef,
              deltaV: result.deltaV,
              timeToNode: result.timeToNode
            }
          );
        } else {
          return errorResponse('match_velocities', `Velocity match failed: ${result.error}`, result.error ?? 'Unknown error');
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('match_velocities', `Velocity match failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'resonant_orbit',
    'Establish a resonant orbit for satellite constellation deployment.',
    {
      numerator: z.number().int().positive().describe('Numerator of resonance ratio (e.g., 2 for 2:3)'),
      denominator: z.number().int().positive().describe('Denominator of resonance ratio (e.g., 3 for 2:3)'),
      timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW'])
        .default('APOAPSIS')
        .describe('When to execute the maneuver'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const result = await resonantOrbit(conn, args.numerator, args.denominator, args.timeRef);

        if (result.success) {
          return successResponse('resonant_orbit',
            `Resonant orbit planned!\n` +
              `  Resonance: ${args.numerator}:${args.denominator}\n` +
              `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
              `  Time to node: ${result.timeToNode?.toFixed(0)} s`,
            {
              numerator: args.numerator,
              denominator: args.denominator,
              timeRef: args.timeRef,
              deltaV: result.deltaV,
              timeToNode: result.timeToNode
            }
          );
        } else {
          return errorResponse('resonant_orbit', `Resonant orbit failed: ${result.error}`, result.error ?? 'Unknown error');
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('resonant_orbit', `Resonant orbit failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'return_from_moon',
    'Return from a moon to its parent body.',
    {
      targetPeriapsis: z.number().describe('Target periapsis at parent body in meters (e.g., 100000 for 100km)'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const result = await returnFromMoon(conn, args.targetPeriapsis);

        if (result.success) {
          return successResponse('return_from_moon',
            `Moon return planned!\n` +
              `  Target periapsis: ${args.targetPeriapsis / 1000} km\n` +
              `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
              `  Time to node: ${result.timeToNode?.toFixed(0)} s`,
            {
              targetPeriapsis: args.targetPeriapsis,
              deltaV: result.deltaV,
              timeToNode: result.timeToNode
            }
          );
        } else {
          return errorResponse('return_from_moon', `Moon return failed: ${result.error}`, result.error ?? 'Unknown error');
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('return_from_moon', `Moon return failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'interplanetary',
    'Interplanetary transfer. Requires a target planet to be set first.',
    {
      waitForPhaseAngle: z.boolean()
        .default(true)
        .describe('If true, waits for optimal phase angle. If false, transfers immediately.'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const result = await interplanetaryTransfer(conn, args.waitForPhaseAngle);

        if (result.success) {
          return successResponse('interplanetary',
            `Interplanetary transfer planned!\n` +
              `  Wait for phase angle: ${args.waitForPhaseAngle}\n` +
              `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
              `  Time to node: ${result.timeToNode?.toFixed(0)} s`,
            {
              waitForPhaseAngle: args.waitForPhaseAngle,
              deltaV: result.deltaV,
              timeToNode: result.timeToNode
            }
          );
        } else {
          return errorResponse('interplanetary', `Interplanetary transfer failed: ${result.error}`, result.error ?? 'Unknown error');
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('interplanetary', `Interplanetary transfer failed: ${reason}`, reason);
      }
    }
  );

  // Node Execution Tool
  server.tool(
    'execute_node',
    'Execute the next maneuver node. Monitors until completion.',
    {
      timeoutSeconds: z.number()
        .default(240)
        .describe('Maximum time to wait for node execution in seconds (default: 240 = 4 minutes)'),
      includeTelemetry: z.boolean()
        .default(false)
        .describe('Include ship telemetry in response (slower but more info)'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const result = await executeNode(conn, args.timeoutSeconds * 1000);

        if (result.success) {
          let text = `Node executed successfully!\n` +
            `  Nodes executed: ${result.nodesExecuted}`;

          if (args.includeTelemetry) {
            text += '\n\n' + await getShipTelemetry(conn, INLINE_TELEMETRY_OPTIONS);
          }

          return successResponse('execute_node', text, { nodesExecuted: result.nodesExecuted });
        } else {
          return errorResponse('execute_node', `Node execution failed: ${result.error}\n  Nodes executed: ${result.nodesExecuted}`, result.error ?? 'Unknown error');
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('execute_node', `Node execution failed: ${reason}`, reason);
      }
    }
  );

  // MechJeb Ascent Guidance Tools
  server.tool(
    'launch',
    'Launch to orbit. Triggers first stage and monitors ascent.',
    {
      altitude: z.number().describe('Target orbit altitude in meters (e.g., 100000 for 100km)'),
      inclination: z.number().default(0).describe('Target orbit inclination in degrees'),
      skipCircularization: z.boolean().default(false).describe('Skip circularization burn (leaves in elliptical orbit)'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });

        const ascent = new AscentProgram(conn);
        currentAscentHandle = await ascent.launchToOrbit({
          altitude: args.altitude,
          inclination: args.inclination,
          skipCircularization: args.skipCircularization,
          autoStage: true,
          autoWarp: true,
        });

        return successResponse('launch',
          `Launch initiated!\n` +
            `  Target altitude: ${args.altitude / 1000} km\n` +
            `  Target inclination: ${args.inclination}°\n` +
            `  Skip circularization: ${args.skipCircularization}`,
          {
            targetAltitude: args.altitude,
            inclination: args.inclination,
            skipCircularization: args.skipCircularization
          }
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('launch', `Launch failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'ascent_status',
    'Get current ascent progress including phase, altitude, apoapsis, and periapsis.',
    {
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });

        // Use current handle if available, otherwise create temporary one
        let progress;
        if (currentAscentHandle) {
          progress = await currentAscentHandle.getProgress();
        } else {
          const parseNum = (s: string) => {
            const m = s.match(/-?[\d.]+(?:E[+-]?\d+)?/i);
            return m ? parseFloat(m[0]) : 0;
          };
          const normalizeLines = (text: string) =>
            text
              .split('\n')
              .map(line => line.trim())
              .filter(line => line.length > 0);
          const lastLine = (text: string) => {
            const lines = normalizeLines(text);
            return lines.length > 0 ? lines[lines.length - 1] : '';
          };

          const parseCombined = (output: string) => {
            const combinedMatch = output.match(/ASC\|([^|]+)\|([^|]+)\|([^|]+)\|(True|False)\|([\s\S]+)/i);
            if (!combinedMatch) {
              return null;
            }
            return {
              altitude: parseNum(combinedMatch[1]),
              apoapsis: parseNum(combinedMatch[2]),
              periapsis: parseNum(combinedMatch[3]),
              enabled: combinedMatch[4].toLowerCase() === 'true',
              shipStatus: combinedMatch[5].trim()
            };
          };

          const combinedResult = await conn.execute(
            'PRINT "ASC|" + ALTITUDE + "|" + APOAPSIS + "|" + PERIAPSIS + "|" + ADDONS:MJ:ASCENT:ENABLED + "|" + SHIP:STATUS.'
          );

          let telemetry = parseCombined(combinedResult.output);

          if (!telemetry) {
            // Fallback to sequential queries if combined output could not be parsed
            const altResult = await conn.execute('PRINT ALTITUDE.');
            const apoResult = await conn.execute('PRINT APOAPSIS.');
            const perResult = await conn.execute('PRINT PERIAPSIS.');
            const enabledResult = await conn.execute('PRINT ADDONS:MJ:ASCENT:ENABLED.');
            const statusResult = await conn.execute('PRINT SHIP:STATUS.');

            telemetry = {
              altitude: parseNum(altResult.output),
              apoapsis: parseNum(apoResult.output),
              periapsis: parseNum(perResult.output),
              enabled: /^true$/i.test(lastLine(enabledResult.output)),
              shipStatus: lastLine(statusResult.output)
            };
          }

          const { altitude, apoapsis, periapsis, enabled, shipStatus } = telemetry;

          // Determine phase
          let phase: 'prelaunch' | 'launching' | 'gravity_turn' | 'coasting' | 'circularizing' | 'complete' | 'unknown';
          if (shipStatus.toLowerCase().includes('prelaunch') ||
              shipStatus.toLowerCase().includes('landed')) {
            phase = 'prelaunch';
          } else if (periapsis > 70000) {
            phase = 'complete';
          } else if (altitude > 70000) {
            phase = 'coasting';
          } else if (altitude > 1000) {
            phase = 'gravity_turn';
          } else {
            phase = 'launching';
          }

          progress = { altitude, apoapsis, periapsis, enabled, shipStatus, phase };
        }

        const phaseDescriptions: Record<string, string> = {
          prelaunch: 'On launchpad',
          launching: 'Initial launch',
          gravity_turn: 'Gravity turn in progress',
          coasting: 'Coasting to apoapsis',
          circularizing: 'Circularization burn',
          complete: 'In orbit!',
          unknown: 'Unknown phase',
        };

        return successResponse('ascent_status',
          `Ascent Status:\n` +
            `  Phase: ${progress.phase} (${phaseDescriptions[progress.phase] || progress.phase})\n` +
            `  Altitude: ${Math.round(progress.altitude / 1000)} km\n` +
            `  Apoapsis: ${Math.round(progress.apoapsis / 1000)} km\n` +
            `  Periapsis: ${Math.round(progress.periapsis / 1000)} km\n` +
            `  MechJeb enabled: ${progress.enabled}\n` +
            `  Ship status: ${progress.shipStatus}`,
          {
            phase: progress.phase,
            altitude: progress.altitude,
            apoapsis: progress.apoapsis,
            periapsis: progress.periapsis,
            mechjebEnabled: progress.enabled,
            shipStatus: progress.shipStatus
          }
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('ascent_status', `Ascent status failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'abort_ascent',
    'Abort the current ascent guidance.',
    {
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });

        if (currentAscentHandle) {
          await currentAscentHandle.abort();
          currentAscentHandle = null;
        } else {
          // Disable directly
          await conn.execute('SET ADDONS:MJ:ASCENT:ENABLED TO FALSE.');
        }

        return successResponse('abort_ascent', 'Ascent guidance disabled.');
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('abort_ascent', `Abort ascent failed: ${reason}`, reason);
      }
    }
  );

  // Targeting Tools
  server.tool(
    'set_target',
    'Set the target (celestial body or vessel).',
    {
      name: z.string().describe('Name of target (e.g., "Mun", "Minmus", vessel name)'),
      type: z.enum(['auto', 'body', 'vessel']).default('auto')
        .describe('Target type: "auto" tries name directly, "body" for celestial bodies, "vessel" for ships'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const maneuver = new ManeuverProgram(conn);

        const result = await maneuver.setTarget(args.name, args.type);
        if (!result.success) {
          const errorMsg = result.error ?? `Failed to set target "${args.name}"`;
          return errorResponse('set_target', errorMsg, errorMsg);
        }

        return successResponse('set_target',
          `Target set successfully!\n\nName: ${result.name}\nType: ${result.type}`,
          { name: result.name, type: result.type }
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('set_target', `Target set failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'get_target',
    'Get information about the current target.',
    {
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });
        const maneuver = new ManeuverProgram(conn);

        const info = await maneuver.getTargetInfo();
        if (!info.hasTarget) {
          return successResponse('get_target', 'No target currently set.', { hasTarget: false });
        }

        return successResponse('get_target', info.details ?? '', { ...info });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('get_target', `Get target failed: ${reason}`, reason);
      }
    }
  );

  server.tool(
    'clear_target',
    'Clear the current target.',
    {
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });

        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.clearTarget();

        if (result.cleared) {
          return successResponse('clear_target', 'Target cleared successfully.');
        }

        // Command executed but target not cleared - known kOS bug
        const message = result.warning
          ? `Clear target command sent.\n\nWARNING: ${result.warning}`
          : 'Clear target command sent, but target may still be set.';

        return successResponse('clear_target', message, { cleared: false, warning: result.warning });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('clear_target', `Clear target failed: ${reason}`, reason);
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
  server.tool(
    'warp',
    'Time warp to an event: "soi" (SOI change), "node" (next maneuver), "periapsis", "apoapsis", or a number of seconds.',
    {
      target: z.enum(['node', 'soi', 'periapsis', 'apoapsis'])
        .or(z.number())
        .describe('Warp target: "node", "soi", "periapsis", "apoapsis", or a number of seconds to warp forward'),
      leadTime: z.number()
        .default(60)
        .describe('Seconds before target to stop warping (default: 60)'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });

        let result;
        if (typeof args.target === 'number') {
          result = await warpForward(conn, args.target);
        } else {
          result = await warpTo(conn, args.target as WarpTarget, { leadTime: args.leadTime });
        }

        if (result.success) {
          return successResponse('warp',
            `Warp complete!\n` +
              `  Body: ${result.body}\n` +
              `  Altitude: ${(result.altitude || 0) / 1000} km`,
            {
              target: args.target,
              leadTime: args.leadTime,
              body: result.body,
              altitude: result.altitude
            }
          );
        } else {
          return errorResponse('warp', `Warp failed: ${result.error}`, result.error ?? 'Unknown error');
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return errorResponse('warp', `Warp failed: ${reason}`, reason);
      }
    }
  );

  // Save/Load Tools (using kuniverse library)
  server.tool(
    'load_save',
    'Load a KSP quicksave. Connection will be reset after load.',
    {
      saveName: z.string().describe('Name of the quicksave to load (e.g., "test-in-orbit")'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });

      const result = await quickload(conn, args.saveName);

      if (result.success) {
        return successResponse('load_save',
          `Quickload initiated: ${result.saveName}`,
          { saveName: result.saveName }
        );
      } else {
        return errorResponse('load_save', `Load save failed: ${result.error}`, result.error ?? 'Unknown error');
      }
    }
  );

  server.tool(
    'list_saves',
    'List available KSP quicksaves.',
    {
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });

      const result = await listQuicksaves(conn);

      if (result.success) {
        const savesList = result.saves.length > 0
          ? result.saves.map(s => `  - ${s}`).join('\n')
          : '  (no quicksaves found)';
        return successResponse('list_saves', `Available quicksaves:\n${savesList}`, { saves: result.saves });
      } else {
        return errorResponse('list_saves', `List saves failed: ${result.error}`, result.error ?? 'Unknown error');
      }
    }
  );

  server.tool(
    'quicksave',
    'Create a KSP quicksave with the given name.',
    {
      saveName: z.string().describe('Name for the quicksave'),
      cpuId: z.number().optional().describe('CPU ID to connect to (auto-connects to CPU 0 if not specified)'),
      cpuLabel: z.string().optional().describe('CPU label to connect to'),
    },
    async (args) => {
      const conn = await ensureConnected({ cpuId: args.cpuId, cpuLabel: args.cpuLabel });

      const result = await quicksave(conn, args.saveName);

      if (result.success) {
        return successResponse('quicksave', `Quicksave created: ${result.saveName}`, { saveName: result.saveName });
      } else {
        return errorResponse('quicksave', `Quicksave failed: ${result.error}`, result.error ?? 'Unknown error');
      }
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
