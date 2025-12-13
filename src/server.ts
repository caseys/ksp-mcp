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
import { getShipTelemetry } from './mechjeb/telemetry.js';
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

/**
 * Clear the current ascent handle.
 * Called when disconnecting to prevent stale handle issues.
 */
export function clearAscentHandle(): void {
  currentAscentHandle = null;
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'ksp-mcp',
    version: '0.1.0',
  });

  // Register connection tools
  server.tool(
    'kos_connect',
    'Connect to kOS terminal server and attach to a CPU by ID or label. Returns vessel name and CPU info.',
    {
      host: z.string().default('127.0.0.1').describe('kOS server host'),
      port: z.number().default(5410).describe('kOS server port'),
      cpuId: z.number().optional().describe('CPU ID (numeric). Use either cpuId or cpuLabel, not both.'),
      cpuLabel: z.string().optional().describe('CPU tag/label (e.g., "guidance"). Use either cpuId or cpuLabel, not both.'),
      transportType: z.enum(['socket', 'tmux']).optional().describe('Transport type (default: socket)'),
    },
    async (args: z.infer<typeof connectInputSchema>) => {
      try {
        const state = await handleConnect(args);
        return {
          content: [
            {
              type: 'text',
              text: state.connected
                ? `Connected to ${state.vesselName} (CPU ${state.cpuId}: ${state.cpuTag})`
                : `Connection failed: ${state.lastError}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'kos_disconnect',
    'Disconnect from kOS terminal',
    {},
    async () => {
      try {
        await handleDisconnect();
        return {
          content: [{ type: 'text', text: 'Disconnected from kOS' }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'kos_status',
    'Get current kOS connection status',
    {},
    async () => {
      const state = await handleStatus();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(state, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    'kos_list_cpus',
    'List available kOS CPUs without connecting. Useful for discovering CPU tags/labels.',
    listCpusInputSchema.shape,
    async (args) => {
      try {
        const cpus = await handleListCpus(args);
        return {
          content: [
            {
              type: 'text',
              text: cpus.length > 0
                ? `Found ${cpus.length} CPU(s):\n` + JSON.stringify(cpus, null, 2)
                : 'No CPUs found',
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'kos_execute',
    'Execute a raw kOS command and return the output. Use for advanced operations or debugging.',
    {
      command: z.string().describe('kOS command to execute'),
      timeout: z.number().default(5000).describe('Command timeout in milliseconds'),
    },
    async (args) => {
      const result = await handleExecute(args);
      if (result.success) {
        return {
          content: [{ type: 'text', text: result.output || '(no output)' }],
        };
      } else {
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${result.error}\nOutput: ${result.output}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // MechJeb Maneuver Tools
  server.tool(
    'mechjeb_adjust_periapsis',
    'Create a maneuver node to change periapsis using MechJeb. ' +
    'NOTE: Cannot raise periapsis above current apoapsis (orbital mechanics).',
    {
      altitude: z.number().describe('Target periapsis altitude in meters'),
      timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
        .default('APOAPSIS')
        .describe('When to execute the maneuver'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }
        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.adjustPeriapsis(args.altitude, args.timeRef);

        if (result.success) {
          const telemetry = await getShipTelemetry(conn);
          return {
            content: [{
              type: 'text',
              text: `Maneuver node created:\n` +
                `  Target Pe: ${args.altitude / 1000} km\n` +
                `  Time ref: ${args.timeRef}\n` +
                `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
                `  Time to node: ${result.timeToNode?.toFixed(0)} s\n` +
                telemetry
            }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Failed to create maneuver node: ${result.error}` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'mechjeb_adjust_apoapsis',
    'Create a maneuver node to change apoapsis using MechJeb.',
    {
      altitude: z.number().describe('Target apoapsis altitude in meters'),
      timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
        .default('PERIAPSIS')
        .describe('When to execute the maneuver'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }
        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.adjustApoapsis(args.altitude, args.timeRef);

        if (result.success) {
          const telemetry = await getShipTelemetry(conn);
          return {
            content: [{
              type: 'text',
              text: `Maneuver node created:\n` +
                `  Target Ap: ${args.altitude / 1000} km\n` +
                `  Time ref: ${args.timeRef}\n` +
                `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
                `  Time to node: ${result.timeToNode?.toFixed(0)} s\n` +
                telemetry
            }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Failed to create maneuver node: ${result.error}` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'mechjeb_circularize',
    'Create a maneuver node to circularize the orbit using MechJeb.',
    {
      timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
        .default('APOAPSIS')
        .describe('When to circularize (usually at apoapsis or periapsis)'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }
        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.circularize(args.timeRef);

        if (result.success) {
          const telemetry = await getShipTelemetry(conn);
          return {
            content: [{
              type: 'text',
              text: `Circularization node created:\n` +
                `  Time ref: ${args.timeRef}\n` +
                `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
                `  Time to node: ${result.timeToNode?.toFixed(0)} s\n` +
                telemetry
            }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Failed to create maneuver node: ${result.error}` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // Target and Transfer Tools
  server.tool(
    'mechjeb_set_target',
    'Set the navigation target for transfer maneuvers.',
    {
      target: z.string().describe('Target name (e.g., "Mun", "Minmus", or vessel name)'),
      type: z.enum(['body', 'vessel']).default('body').describe('Target type: body for celestial bodies, vessel for spacecraft'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }
        const maneuver = new ManeuverProgram(conn);
        const success = await maneuver.setTarget(args.target, args.type);

        if (success) {
          return {
            content: [{ type: 'text', text: `Target set to ${args.target}` }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Failed to set target to ${args.target}. Make sure the name is correct.` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'mechjeb_hohmann_transfer',
    'Plan a Hohmann transfer to the current target. Requires a target to be set first (use mechjeb_set_target).',
    {
      timeReference: z.enum(['COMPUTED', 'PERIAPSIS', 'APOAPSIS'])
        .default('COMPUTED')
        .describe('When to execute: COMPUTED (optimal), PERIAPSIS, or APOAPSIS'),
      capture: z.boolean()
        .default(true)
        .describe('Include capture/insertion burn (creates 2 nodes). If false, only transfer burn (1 node)'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }
        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.hohmannTransfer(args.timeReference, args.capture);

        if (result.success) {
          const nodeCount = args.capture ? 2 : 1;
          const telemetry = await getShipTelemetry(conn);
          return {
            content: [{
              type: 'text',
              text: `Hohmann transfer planned!\n` +
                `  Nodes created: ${nodeCount}\n` +
                `  Delta-V (first node): ${result.deltaV?.toFixed(1)} m/s\n` +
                `  Time to node: ${result.timeToNode?.toFixed(0)} s\n\n` +
                `Use mechjeb_execute_node to execute the maneuver.\n` +
                telemetry
            }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Failed to plan transfer: ${result.error}` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'mechjeb_course_correction',
    'Fine-tune closest approach to target. Optimizes periapsis for body targets or closest approach for vessel targets. Requires target to be set first.',
    {
      targetDistance: z.number().describe('Target periapsis (bodies) or closest approach (vessels) in meters'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }

        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.courseCorrection(args.targetDistance);

        if (!result.success) {
          return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
            isError: true,
          };
        }

        const telemetry = await getShipTelemetry(conn);
        return {
          content: [{
            type: 'text',
            text: `Course correction planned!\n` +
                  `  Target approach: ${args.targetDistance / 1000} km\n` +
                  `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
                  `  Time to node: ${result.timeToNode?.toFixed(0)} s\n\n` +
                  `Use mechjeb_execute_node to execute.\n` +
                  telemetry
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'mechjeb_change_inclination',
    'Change orbital inclination. Most efficient when executed at equatorial crossings (ascending/descending nodes).',
    {
      newInclination: z.number().describe('Target inclination in degrees'),
      timeRef: z.enum(['EQ_ASCENDING', 'EQ_DESCENDING', 'EQ_NEAREST_AD', 'EQ_HIGHEST_AD', 'X_FROM_NOW'])
        .default('EQ_NEAREST_AD')
        .describe('When to execute: at ascending node, descending node, nearest AN/DN, or highest AD'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }

        const maneuver = new ManeuverProgram(conn);
        const result = await maneuver.changeInclination(args.newInclination, args.timeRef);

        if (!result.success) {
          return {
            content: [{ type: 'text', text: `Error: ${result.error}` }],
            isError: true,
          };
        }

        const telemetry = await getShipTelemetry(conn);
        return {
          content: [{
            type: 'text',
            text: `Inclination change planned!\n` +
                  `  Target inclination: ${args.newInclination}°\n` +
                  `  Execution point: ${args.timeRef}\n` +
                  `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
                  `  Time to node: ${result.timeToNode?.toFixed(0)} s\n\n` +
                  `Use mechjeb_execute_node to execute.\n` +
                  telemetry
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // New Modular MechJeb Operations
  server.tool(
    'mechjeb_ellipticize',
    'Create a maneuver node to set both periapsis and apoapsis in a single burn.',
    {
      periapsis: z.number().describe('Target periapsis altitude in meters'),
      apoapsis: z.number().describe('Target apoapsis altitude in meters'),
      timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
        .default('APOAPSIS')
        .describe('When to execute the maneuver'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }
        const result = await ellipticize(conn, args.periapsis, args.apoapsis, args.timeRef);

        if (result.success) {
          const telemetry = await getShipTelemetry(conn);
          return {
            content: [{
              type: 'text',
              text: `Ellipticize node created:\n` +
                `  Target Pe: ${args.periapsis / 1000} km\n` +
                `  Target Ap: ${args.apoapsis / 1000} km\n` +
                `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
                `  Time to node: ${result.timeToNode?.toFixed(0)} s\n` +
                telemetry
            }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Failed to create maneuver node: ${result.error}` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'mechjeb_change_semimajor',
    'Create a maneuver node to change the orbital semi-major axis.',
    {
      semiMajorAxis: z.number().describe('Target semi-major axis in meters'),
      timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
        .default('APOAPSIS')
        .describe('When to execute the maneuver'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }
        const result = await changeSemiMajorAxis(conn, args.semiMajorAxis, args.timeRef);

        if (result.success) {
          const telemetry = await getShipTelemetry(conn);
          return {
            content: [{
              type: 'text',
              text: `Semi-major axis change node created:\n` +
                `  Target SMA: ${args.semiMajorAxis / 1000} km\n` +
                `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
                `  Time to node: ${result.timeToNode?.toFixed(0)} s\n` +
                telemetry
            }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Failed to create maneuver node: ${result.error}` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'mechjeb_change_eccentricity',
    'Create a maneuver node to change orbital eccentricity.',
    {
      eccentricity: z.number().min(0).max(0.99).describe('Target eccentricity (0 = circular, <1 = elliptical)'),
      timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
        .default('APOAPSIS')
        .describe('When to execute the maneuver'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }
        const result = await changeEccentricity(conn, args.eccentricity, args.timeRef);

        if (result.success) {
          const telemetry = await getShipTelemetry(conn);
          return {
            content: [{
              type: 'text',
              text: `Eccentricity change node created:\n` +
                `  Target eccentricity: ${args.eccentricity}\n` +
                `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
                `  Time to node: ${result.timeToNode?.toFixed(0)} s\n` +
                telemetry
            }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Failed to create maneuver node: ${result.error}` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'mechjeb_change_lan',
    'Create a maneuver node to change the Longitude of Ascending Node (LAN).',
    {
      lan: z.number().describe('Target LAN in degrees (0 to 360)'),
      timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
        .default('APOAPSIS')
        .describe('When to execute the maneuver'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }
        const result = await changeLAN(conn, args.lan, args.timeRef);

        if (result.success) {
          const telemetry = await getShipTelemetry(conn);
          return {
            content: [{
              type: 'text',
              text: `LAN change node created:\n` +
                `  Target LAN: ${args.lan}°\n` +
                `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
                `  Time to node: ${result.timeToNode?.toFixed(0)} s\n` +
                telemetry
            }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Failed to create maneuver node: ${result.error}` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'mechjeb_change_longitude_of_periapsis',
    'Create a maneuver node to change the Longitude of Periapsis.',
    {
      longitude: z.number().describe('Target longitude in degrees (-180 to 180)'),
      timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW', 'ALTITUDE'])
        .default('APOAPSIS')
        .describe('When to execute the maneuver'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }
        const result = await changeLongitudeOfPeriapsis(conn, args.longitude, args.timeRef);

        if (result.success) {
          const telemetry = await getShipTelemetry(conn);
          return {
            content: [{
              type: 'text',
              text: `Longitude of periapsis change node created:\n` +
                `  Target longitude: ${args.longitude}°\n` +
                `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
                `  Time to node: ${result.timeToNode?.toFixed(0)} s\n` +
                telemetry
            }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Failed to create maneuver node: ${result.error}` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'mechjeb_match_plane',
    'Create a maneuver node to match orbital plane with the target. Requires a target to be set first.',
    {
      timeRef: z.enum(['REL_NEAREST_AD', 'REL_HIGHEST_AD', 'REL_ASCENDING', 'REL_DESCENDING'])
        .default('REL_NEAREST_AD')
        .describe('When to execute: nearest AN/DN, highest AN/DN, ascending node, or descending node'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }
        const result = await matchPlane(conn, args.timeRef);

        if (result.success) {
          const telemetry = await getShipTelemetry(conn);
          return {
            content: [{
              type: 'text',
              text: `Plane match node created:\n` +
                `  Execution point: ${args.timeRef}\n` +
                `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
                `  Time to node: ${result.timeToNode?.toFixed(0)} s\n` +
                telemetry
            }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Failed to create maneuver node: ${result.error}` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'mechjeb_kill_relative_velocity',
    'Create a maneuver node to match velocity with the target. Requires a target to be set first.',
    {
      timeRef: z.enum(['CLOSEST_APPROACH', 'X_FROM_NOW'])
        .default('CLOSEST_APPROACH')
        .describe('When to execute: at closest approach or after X seconds'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }
        const result = await killRelativeVelocity(conn, args.timeRef);

        if (result.success) {
          const telemetry = await getShipTelemetry(conn);
          return {
            content: [{
              type: 'text',
              text: `Kill relative velocity node created:\n` +
                `  Execution point: ${args.timeRef}\n` +
                `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
                `  Time to node: ${result.timeToNode?.toFixed(0)} s\n` +
                telemetry
            }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Failed to create maneuver node: ${result.error}` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'mechjeb_resonant_orbit',
    'Create a maneuver node to establish a resonant orbit. Useful for satellite constellation deployment.',
    {
      numerator: z.number().int().positive().describe('Numerator of resonance ratio (e.g., 2 for 2:3)'),
      denominator: z.number().int().positive().describe('Denominator of resonance ratio (e.g., 3 for 2:3)'),
      timeRef: z.enum(['APOAPSIS', 'PERIAPSIS', 'X_FROM_NOW'])
        .default('APOAPSIS')
        .describe('When to execute the maneuver'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }
        const result = await resonantOrbit(conn, args.numerator, args.denominator, args.timeRef);

        if (result.success) {
          const telemetry = await getShipTelemetry(conn);
          return {
            content: [{
              type: 'text',
              text: `Resonant orbit node created:\n` +
                `  Resonance: ${args.numerator}:${args.denominator}\n` +
                `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
                `  Time to node: ${result.timeToNode?.toFixed(0)} s\n` +
                telemetry
            }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Failed to create maneuver node: ${result.error}` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'mechjeb_return_from_moon',
    'Create a maneuver node to return from a moon to its parent body.',
    {
      targetPeriapsis: z.number().describe('Target periapsis at parent body in meters (e.g., 100000 for 100km)'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }
        const result = await returnFromMoon(conn, args.targetPeriapsis);

        if (result.success) {
          const telemetry = await getShipTelemetry(conn);
          return {
            content: [{
              type: 'text',
              text: `Return from moon node created:\n` +
                `  Target periapsis: ${args.targetPeriapsis / 1000} km\n` +
                `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
                `  Time to node: ${result.timeToNode?.toFixed(0)} s\n` +
                telemetry
            }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Failed to create maneuver node: ${result.error}` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'mechjeb_interplanetary_transfer',
    'Create a maneuver node for an interplanetary transfer. Requires a target planet to be set first.',
    {
      waitForPhaseAngle: z.boolean()
        .default(true)
        .describe('If true, waits for optimal phase angle. If false, transfers immediately.'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }
        const result = await interplanetaryTransfer(conn, args.waitForPhaseAngle);

        if (result.success) {
          const telemetry = await getShipTelemetry(conn);
          return {
            content: [{
              type: 'text',
              text: `Interplanetary transfer node created:\n` +
                `  Wait for phase angle: ${args.waitForPhaseAngle}\n` +
                `  Delta-V: ${result.deltaV?.toFixed(1)} m/s\n` +
                `  Time to node: ${result.timeToNode?.toFixed(0)} s\n` +
                telemetry
            }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Failed to create maneuver node: ${result.error}` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // Node Execution Tool
  server.tool(
    'mechjeb_execute_node',
    'Execute the next maneuver node using MechJeb autopilot. Enables the node executor and monitors until completion.',
    {
      timeoutSeconds: z.number()
        .default(240)
        .describe('Maximum time to wait for node execution in seconds (default: 240 = 4 minutes)'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }
        const result = await executeNode(conn, args.timeoutSeconds * 1000);

        if (result.success) {
          const telemetry = await getShipTelemetry(conn);
          return {
            content: [{
              type: 'text',
              text: `Node executed successfully!\n` +
                `  Nodes executed: ${result.nodesExecuted}\n` +
                telemetry
            }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Node execution failed: ${result.error}\n  Nodes executed: ${result.nodesExecuted}` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // MechJeb Ascent Guidance Tools
  server.tool(
    'mechjeb_launch_to_orbit',
    'Launch to orbit using MechJeb ascent guidance. Configures and enables autopilot, triggers first stage. ' +
    'Use mechjeb_ascent_status to monitor progress.',
    {
      altitude: z.number().describe('Target orbit altitude in meters (e.g., 100000 for 100km)'),
      inclination: z.number().default(0).describe('Target orbit inclination in degrees'),
      skipCircularization: z.boolean().default(false).describe('Skip circularization burn (leaves in elliptical orbit)'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }

        const ascent = new AscentProgram(conn);
        currentAscentHandle = await ascent.launchToOrbit({
          altitude: args.altitude,
          inclination: args.inclination,
          skipCircularization: args.skipCircularization,
          autoStage: true,
          autoWarp: true,
        });

        const telemetry = await getShipTelemetry(conn);
        return {
          content: [{
            type: 'text',
            text: `Launch initiated!\n` +
              `  Target altitude: ${args.altitude / 1000} km\n` +
              `  Target inclination: ${args.inclination}°\n` +
              `  Skip circularization: ${args.skipCircularization}\n\n` +
              `MechJeb ascent guidance enabled. Use mechjeb_ascent_status to monitor progress.\n` +
              telemetry
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'mechjeb_ascent_status',
    'Get current ascent progress including phase, altitude, apoapsis, and periapsis.',
    {},
    async () => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }

        // Use current handle if available, otherwise create temporary one
        let progress;
        if (currentAscentHandle) {
          progress = await currentAscentHandle.getProgress();
        } else {
          // Query directly
          const altResult = await conn.execute('PRINT ALTITUDE.');
          const apoResult = await conn.execute('PRINT APOAPSIS.');
          const perResult = await conn.execute('PRINT PERIAPSIS.');
          const enabledResult = await conn.execute('PRINT ADDONS:MJ:ASCENTGUIDANCE:ENABLED.');
          const statusResult = await conn.execute('PRINT SHIP:STATUS.');

          const parseNum = (s: string) => {
            const m = s.match(/-?[\d.]+(?:E[+-]?\d+)?/i);
            return m ? parseFloat(m[0]) : 0;
          };

          const altitude = parseNum(altResult.output);
          const apoapsis = parseNum(apoResult.output);
          const periapsis = parseNum(perResult.output);
          const enabled = enabledResult.output.includes('True');
          const shipStatus = statusResult.output.trim();

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

        return {
          content: [{
            type: 'text',
            text: `Ascent Status:\n` +
              `  Phase: ${progress.phase} (${phaseDescriptions[progress.phase] || progress.phase})\n` +
              `  Altitude: ${Math.round(progress.altitude / 1000)} km\n` +
              `  Apoapsis: ${Math.round(progress.apoapsis / 1000)} km\n` +
              `  Periapsis: ${Math.round(progress.periapsis / 1000)} km\n` +
              `  MechJeb enabled: ${progress.enabled}\n` +
              `  Ship status: ${progress.shipStatus}`
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'mechjeb_abort_ascent',
    'Abort the current ascent guidance. Disables MechJeb autopilot.',
    {},
    async () => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }

        if (currentAscentHandle) {
          await currentAscentHandle.abort();
          currentAscentHandle = null;
        } else {
          // Disable directly
          await conn.execute('SET ADDONS:MJ:ASCENTGUIDANCE:ENABLED TO FALSE.');
        }

        return {
          content: [{
            type: 'text',
            text: 'Ascent guidance disabled. Manual control restored.'
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // Targeting Tools
  server.tool(
    'kos_set_target',
    'Set the target for maneuvers (celestial body or vessel). Required for Hohmann transfers, rendezvous, etc.',
    {
      name: z.string().describe('Name of target (e.g., "Mun", "Minmus", vessel name)'),
      type: z.enum(['auto', 'body', 'vessel']).default('auto')
        .describe('Target type: "auto" tries name directly, "body" for celestial bodies, "vessel" for ships'),
    },
    async (args) => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }

        let cmd: string;
        if (args.type === 'body') {
          cmd = `SET TARGET TO BODY("${args.name}").`;
        } else if (args.type === 'vessel') {
          cmd = `SET TARGET TO VESSEL("${args.name}").`;
        } else {
          cmd = `SET TARGET TO "${args.name}".`;
        }

        const result = await conn.execute(cmd, 5000);

        // Verify target was set by checking HASTARGET directly
        const verifyResult = await conn.execute('PRINT HASTARGET.');

        if (!verifyResult.output.includes('True')) {
          return {
            content: [{
              type: 'text',
              text: `Failed to set target "${args.name}"\n` +
                `The target may not exist or may not be loaded.`
            }],
            isError: true,
          };
        }

        // Get target info
        const infoResult = await conn.execute(
          'PRINT "Target: " + TARGET:NAME + " (" + TARGET:TYPENAME + ")". ' +
          'IF TARGET:TYPENAME = "Body" { ' +
          '  PRINT "Radius: " + ROUND(TARGET:RADIUS / 1000, 1) + " km". ' +
          '} ELSE IF TARGET:TYPENAME = "Vessel" { ' +
          '  PRINT "Distance: " + ROUND(TARGET:DISTANCE / 1000, 1) + " km". ' +
          '}'
        );

        return {
          content: [{
            type: 'text',
            text: `Target set successfully!\n\n${infoResult.output.trim()}`
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'kos_get_target',
    'Get information about the current target.',
    {},
    async () => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }

        const result = await conn.execute(
          'IF HASTARGET { ' +
          '  PRINT "Target: " + TARGET:NAME. ' +
          '  PRINT "Type: " + TARGET:TYPENAME. ' +
          '  PRINT "Distance: " + ROUND(TARGET:DISTANCE / 1000, 1) + " km". ' +
          '  IF TARGET:TYPENAME = "Body" { ' +
          '    PRINT "Radius: " + ROUND(TARGET:RADIUS / 1000, 1) + " km". ' +
          '    PRINT "Orbital altitude: " + ROUND(TARGET:ALTITUDE / 1000, 1) + " km". ' +
          '  } ELSE IF TARGET:TYPENAME = "Vessel" { ' +
          '    PRINT "Relative velocity: " + ROUND(TARGET:VELOCITY:ORBIT:MAG, 1) + " m/s". ' +
          '  } ' +
          '} ELSE { ' +
          '  PRINT "No target set". ' +
          '}'
        );

        if (result.output.includes('No target set')) {
          return {
            content: [{
              type: 'text',
              text: 'No target currently set.\n\nUse kos_set_target to set a target.'
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: result.output.trim()
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'kos_clear_target',
    'Clear the current target.',
    {},
    async () => {
      try {
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }

        await conn.execute('UNSET TARGET.');

        return {
          content: [{
            type: 'text',
            text: 'Target cleared successfully.'
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
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
    'kos_warp',
    'Time warp to a specific event (node, SOI change, periapsis, apoapsis) or forward by seconds. ' +
    'Essential for interplanetary missions to skip long coast phases.',
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
        const conn = getConnection();
        if (!conn.isConnected()) {
          return {
            content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
            isError: true,
          };
        }

        let result;
        if (typeof args.target === 'number') {
          result = await warpForward(conn, args.target);
        } else {
          result = await warpTo(conn, args.target as WarpTarget, { leadTime: args.leadTime });
        }

        if (result.success) {
          const telemetry = await getShipTelemetry(conn);
          return {
            content: [{
              type: 'text',
              text: `Warp complete!\n` +
                `  Body: ${result.body}\n` +
                `  Altitude: ${(result.altitude || 0) / 1000} km\n` +
                telemetry
            }],
          };
        } else {
          return {
            content: [{ type: 'text', text: `Warp failed: ${result.error}` }],
            isError: true,
          };
        }
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          }],
          isError: true,
        };
      }
    }
  );

  // Save/Load Tools (using kuniverse library)
  server.tool(
    'kos_load_save',
    'Load a KSP quicksave. Uses KUNIVERSE:QUICKLOADFROM to reload the game state. ' +
    'Note: Connection will be reset after load.',
    {
      saveName: z.string().describe('Name of the quicksave to load (e.g., "test-in-orbit")'),
    },
    async (args) => {
      const conn = getConnection();
      if (!conn.isConnected()) {
        return {
          content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
          isError: true,
        };
      }

      const result = await quickload(conn, args.saveName);

      if (result.success) {
        return {
          content: [{
            type: 'text',
            text: `Quickload initiated for save: ${result.saveName}\n\n` +
              `Note: Connection will reset after load completes. ` +
              `Use kos_connect to reconnect.`
          }],
        };
      } else {
        return {
          content: [{ type: 'text', text: `Error: ${result.error}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'kos_list_saves',
    'List available KSP quicksaves.',
    {},
    async () => {
      const conn = getConnection();
      if (!conn.isConnected()) {
        return {
          content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
          isError: true,
        };
      }

      const result = await listQuicksaves(conn);

      if (result.success) {
        const savesList = result.saves.length > 0
          ? result.saves.map(s => `  - ${s}`).join('\n')
          : '  (no quicksaves found)';
        return {
          content: [{
            type: 'text',
            text: `Available quicksaves:\n${savesList}`
          }],
        };
      } else {
        return {
          content: [{ type: 'text', text: `Error: ${result.error}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    'kos_quicksave',
    'Create a KSP quicksave with the given name.',
    {
      saveName: z.string().describe('Name for the quicksave'),
    },
    async (args) => {
      const conn = getConnection();
      if (!conn.isConnected()) {
        return {
          content: [{ type: 'text', text: 'Error: Not connected to kOS. Use kos_connect first.' }],
          isError: true,
        };
      }

      const result = await quicksave(conn, args.saveName);

      if (result.success) {
        return {
          content: [{
            type: 'text',
            text: `Quicksave created: ${result.saveName}`
          }],
        };
      } else {
        return {
          content: [{ type: 'text', text: `Error: ${result.error}` }],
          isError: true,
        };
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
