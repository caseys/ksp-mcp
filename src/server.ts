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
  setCpuPreference,
  getCpuPreference,
  forceDisconnect,
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
        return errorResponse('disconnect', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.tool(
    'status',
    'Get current kOS connection status',
    {},
    async () => {
      const state = await handleStatus();
      const text = state.connected
        ? `Connected to CPU ${state.cpuId} on ${state.vesselName}`
        : 'Not connected';
      return successResponse('status', text);
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
        return errorResponse('clear_nodes', error instanceof Error ? error.message : String(error));
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
          ? `Found ${cpus.length} CPU(s):\n` + cpus.map(c => `  ${c.id}: ${c.vessel} (${c.tag || 'no tag'})`).join('\n')
          : 'No CPUs found';
        return successResponse('list_cpus', text);
      } catch (error) {
        return errorResponse('list_cpus', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.tool(
    'switch_cpu',
    'OPTIONAL: Switch to a different kOS CPU. Only needed when multiple CPUs exist and you want a specific one. By default, the first available CPU is used automatically.',
    {
      cpuId: z.number().optional().describe('CPU ID (1-based) to switch to'),
      cpuLabel: z.string().optional().describe('CPU label/tag (e.g., "guidance") to switch to'),
      clear: z.boolean().optional().describe('Clear preference and revert to auto-select'),
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

  server.tool(
    'command',
    'Run a manual kOS command.',
    {
      command: z.string().describe('kOS script command to send'),
      timeout: z.number().default(5000).describe('Command timeout in milliseconds'),
    },
    async (args) => {
      const result = await handleExecute(args);
      if (result.success) {
        return successResponse('command', result.output || '(no output)');
      } else {
        return errorResponse('command', result.error ?? 'Failed');
      }
    }
  );

  // Telemetry Tool
  server.tool(
    'telemetry',
    'Get current ship telemetry including orbit, SOI, maneuver nodes, and encounters.',
    {
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const telemetry = await getShipTelemetry(conn, FULL_TELEMETRY_OPTIONS);
        return successResponse('telemetry', telemetry);
      } catch (error) {
        return errorResponse('telemetry', error instanceof Error ? error.message : String(error));
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
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.adjustPeriapsis(args.altitude, args.timeRef);

        if (result.success) {
          return successResponse('adjust_pe',
            `Node created: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s`);
        } else {
          return errorResponse('adjust_pe', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('adjust_pe', error instanceof Error ? error.message : String(error));
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
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.adjustApoapsis(args.altitude, args.timeRef);

        if (result.success) {
          return successResponse('adjust_ap',
            `Node created: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s`);
        } else {
          return errorResponse('adjust_ap', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('adjust_ap', error instanceof Error ? error.message : String(error));
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
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.circularize(args.timeRef);

        if (result.success) {
          return successResponse('circularize',
            `Node created: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s`);
        } else {
          return errorResponse('circularize', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('circularize', error instanceof Error ? error.message : String(error));
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
        .describe('Include capture burn for vessel rendezvous. Bodies always create 1 node (transfer only).'),
      includeTelemetry: z.boolean()
        .default(false)
        .describe('Include ship telemetry in response (slower but more info)'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.hohmannTransfer(args.timeReference, args.capture);

        if (result.success) {
          const nodeCount = result.nodesCreated ?? 1;
          let text = `${nodeCount} node(s) created: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s`;

          if (args.includeTelemetry) {
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
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.courseCorrection(args.targetDistance, args.minLeadTime);

        if (!result.success) {
          return errorResponse('course_correct', result.error ?? 'Failed');
        }

        let text = `Node created: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s`;

        if (args.includeTelemetry) {
          text += '\n\n' + await getShipTelemetry(conn, INLINE_TELEMETRY_OPTIONS);
        }

        return successResponse('course_correct', text);
      } catch (error) {
        return errorResponse('course_correct', error instanceof Error ? error.message : String(error));
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
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.changeInclination(args.newInclination, args.timeRef);

        if (!result.success) {
          return errorResponse('change_inc', result.error ?? 'Failed');
        }

        return successResponse('change_inc',
          `Node created: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s`);
      } catch (error) {
        return errorResponse('change_inc', error instanceof Error ? error.message : String(error));
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
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const result = await ellipticize(conn, args.periapsis, args.apoapsis, args.timeRef);

        if (result.success) {
          return successResponse('ellipticize',
            `Node created: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s`);
        } else {
          return errorResponse('ellipticize', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('ellipticize', error instanceof Error ? error.message : String(error));
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
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const result = await changeSemiMajorAxis(conn, args.semiMajorAxis, args.timeRef);

        if (result.success) {
          return successResponse('change_sma',
            `Node created: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s`);
        } else {
          return errorResponse('change_sma', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('change_sma', error instanceof Error ? error.message : String(error));
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
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const result = await changeEccentricity(conn, args.eccentricity, args.timeRef);

        if (result.success) {
          return successResponse('change_ecc',
            `Node created: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s`);
        } else {
          return errorResponse('change_ecc', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('change_ecc', error instanceof Error ? error.message : String(error));
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
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const result = await changeLAN(conn, args.lan, args.timeRef);

        if (result.success) {
          return successResponse('change_lan',
            `Node created: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s`);
        } else {
          return errorResponse('change_lan', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('change_lan', error instanceof Error ? error.message : String(error));
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
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const result = await changeLongitudeOfPeriapsis(conn, args.longitude, args.timeRef);

        if (result.success) {
          return successResponse('change_lpe',
            `Node created: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s`);
        } else {
          return errorResponse('change_lpe', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('change_lpe', error instanceof Error ? error.message : String(error));
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
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const result = await matchPlane(conn, args.timeRef);

        if (result.success) {
          return successResponse('match_planes',
            `Node created: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s`);
        } else {
          return errorResponse('match_planes', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('match_planes', error instanceof Error ? error.message : String(error));
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
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const result = await killRelativeVelocity(conn, args.timeRef);

        if (result.success) {
          return successResponse('match_velocities',
            `Node created: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s`);
        } else {
          return errorResponse('match_velocities', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('match_velocities', error instanceof Error ? error.message : String(error));
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
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const result = await resonantOrbit(conn, args.numerator, args.denominator, args.timeRef);

        if (result.success) {
          return successResponse('resonant_orbit',
            `Node created: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s`);
        } else {
          return errorResponse('resonant_orbit', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('resonant_orbit', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.tool(
    'return_from_moon',
    'Return from a moon to its parent body.',
    {
      targetPeriapsis: z.number().describe('Target periapsis at parent body in meters (e.g., 100000 for 100km)'),
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const result = await returnFromMoon(conn, args.targetPeriapsis);

        if (result.success) {
          return successResponse('return_from_moon',
            `Node created: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s`);
        } else {
          return errorResponse('return_from_moon', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('return_from_moon', error instanceof Error ? error.message : String(error));
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
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const result = await interplanetaryTransfer(conn, args.waitForPhaseAngle);

        if (result.success) {
          return successResponse('interplanetary',
            `Node created: ${result.deltaV?.toFixed(1)} m/s, T-${result.timeToNode?.toFixed(0)}s`);
        } else {
          return errorResponse('interplanetary', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('interplanetary', error instanceof Error ? error.message : String(error));
      }
    }
  );

  // Node Execution Tool
  server.tool(
    'execute_node',
    'Execute the next maneuver node. Waits for completion by default.',
    {
      async: z.boolean()
        .default(false)
        .describe('If true, return immediately after starting executor instead of waiting for completion'),
      timeoutSeconds: z.number()
        .default(240)
        .describe('Maximum time to wait for node execution in seconds (default: 240 = 4 minutes)'),
      includeTelemetry: z.boolean()
        .default(false)
        .describe('Include ship telemetry in response (slower but more info)'),
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
          if (args.async) {
            text = `Executor started: ${result.deltaV?.required.toFixed(1)} m/s required`;
          } else {
            text = `Node executed: ${result.nodesExecuted} node(s)`;
          }

          if (args.includeTelemetry) {
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

  // MechJeb Ascent Guidance Tools
  server.tool(
    'launch',
    'Launch to orbit. Triggers first stage and monitors ascent.',
    {
      altitude: z.number().describe('Target orbit altitude in meters (e.g., 100000 for 100km)'),
      inclination: z.number().default(0).describe('Target orbit inclination in degrees'),
      skipCircularization: z.boolean().default(false).describe('Skip circularization burn (leaves in elliptical orbit)'),
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

        return successResponse('launch',
          `Launch initiated to ${args.altitude / 1000}km at ${args.inclination}° inclination`);
      } catch (error) {
        return errorResponse('launch', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.tool(
    'ascent_status',
    'Get current ascent progress including phase, altitude, apoapsis, and periapsis.',
    {
    },
    async (args) => {
      try {
        const conn = await ensureConnected();

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
          `${progress.phase}: Alt ${Math.round(progress.altitude / 1000)}km, Ap ${Math.round(progress.apoapsis / 1000)}km, Pe ${Math.round(progress.periapsis / 1000)}km`);
      } catch (error) {
        return errorResponse('ascent_status', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.tool(
    'abort_ascent',
    'Abort the current ascent guidance.',
    {
    },
    async (args) => {
      try {
        const conn = await ensureConnected();

        if (currentAscentHandle) {
          await currentAscentHandle.abort();
          currentAscentHandle = null;
        } else {
          await conn.execute('SET ADDONS:MJ:ASCENT:ENABLED TO FALSE.');
        }

        return successResponse('abort_ascent', 'Ascent guidance disabled.');
      } catch (error) {
        return errorResponse('abort_ascent', error instanceof Error ? error.message : String(error));
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
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const maneuver = new ManeuverProgram(conn);

        const result = await maneuver.setTarget(args.name, args.type);
        if (!result.success) {
          return errorResponse('set_target', result.error ?? `Failed to set target "${args.name}"`);
        }

        return successResponse('set_target', `Target: ${result.name} (${result.type})`);
      } catch (error) {
        return errorResponse('set_target', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.tool(
    'get_target',
    'Get information about the current target.',
    {
    },
    async (args) => {
      try {
        const conn = await ensureConnected();
        const maneuver = new ManeuverProgram(conn);

        const info = await maneuver.getTargetInfo();
        if (!info.hasTarget) {
          return successResponse('get_target', 'No target set.');
        }

        return successResponse('get_target', info.details ?? `Target: ${info.name}`);
      } catch (error) {
        return errorResponse('get_target', error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.tool(
    'clear_target',
    'Clear the current target.',
    {
    },
    async (args) => {
      try {
        const conn = await ensureConnected();

        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.clearTarget();

        if (result.cleared) {
          return successResponse('clear_target', 'Target cleared.');
        }

        return successResponse('clear_target', result.warning ?? 'Clear command sent.');
      } catch (error) {
        return errorResponse('clear_target', error instanceof Error ? error.message : String(error));
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
    },
    async (args) => {
      try {
        const conn = await ensureConnected();

        let result;
        if (typeof args.target === 'number') {
          result = await warpForward(conn, args.target);
        } else {
          result = await warpTo(conn, args.target as WarpTarget, { leadTime: args.leadTime });
        }

        if (result.success) {
          return successResponse('warp', `Warp complete: ${result.body}, ${((result.altitude || 0) / 1000).toFixed(0)}km`);
        } else {
          return errorResponse('warp', result.error ?? 'Failed');
        }
      } catch (error) {
        return errorResponse('warp', error instanceof Error ? error.message : String(error));
      }
    }
  );

  // Save/Load Tools (using kuniverse library)
  server.tool(
    'load_save',
    'Load a KSP quicksave. Connection will be reset after load.',
    {
      saveName: z.string().describe('Name of the quicksave to load (e.g., "test-in-orbit")'),
    },
    async (args) => {
      const conn = await ensureConnected();
      const result = await quickload(conn, args.saveName);

      if (result.success) {
        return successResponse('load_save', `Loading: ${result.saveName}`);
      } else {
        return errorResponse('load_save', result.error ?? 'Failed');
      }
    }
  );

  server.tool(
    'list_saves',
    'List available KSP quicksaves.',
    {
    },
    async (args) => {
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

  server.tool(
    'quicksave',
    'Create a KSP quicksave with the given name.',
    {
      saveName: z.string().describe('Name for the quicksave'),
    },
    async (args) => {
      const conn = await ensureConnected();
      const result = await quicksave(conn, args.saveName);

      if (result.success) {
        return successResponse('quicksave', `Saved: ${result.saveName}`);
      } else {
        return errorResponse('quicksave', result.error ?? 'Failed');
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
