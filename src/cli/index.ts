#!/usr/bin/env node
/**
 * Unified CLI for ksp-mcp
 *
 * Usage: ksp-mcp <command> [args...] [options]
 *
 * Examples:
 *   ksp-mcp status
 *   ksp-mcp launch 80000
 *   ksp-mcp hohmann Mun --capture
 *   ksp-mcp circularize --time-ref APOAPSIS
 *   ksp-mcp warp soi
 *   ksp-mcp list-tools
 */

import { callTool, listTools, cleanup } from './mcp-client.js';

// Tool name mappings: CLI command -> MCP tool name
const TOOL_ALIASES: Record<string, string> = {
  // Shortcuts
  'launch': 'launch_ascent',
  'hohmann': 'hohmann_transfer',
  'interplanetary': 'interplanetary_transfer',
  'return': 'return_from_moon',
  'resonant': 'resonant_orbit',
  'execute': 'execute_node',
  'clear': 'clear_nodes',
  'target': 'set_target',
  'targets': 'get_targets',
  'crash': 'crash_avoidance',
  'saves': 'list_saves',
  'load': 'load_save',
  'save': 'quicksave',
  'run': 'run_script',
  'cpus': 'list_cpus',
  'cpu': 'switch_cpu',

  // Kebab to snake conversions
  'launch-ascent': 'launch_ascent',
  'hohmann-transfer': 'hohmann_transfer',
  'course-correct': 'course_correct',
  'adjust-apoapsis': 'adjust_apoapsis',
  'adjust-periapsis': 'adjust_periapsis',
  'change-inclination': 'change_inclination',
  'change-ascending-node': 'change_ascending_node',
  'change-periapsis-longitude': 'change_periapsis_longitude',
  'change-semi-major-axis': 'change_semi_major_axis',
  'change-eccentricity': 'change_eccentricity',
  'match-planes': 'match_planes',
  'match-velocities': 'match_velocities',
  'interplanetary-transfer': 'interplanetary_transfer',
  'return-from-moon': 'return_from_moon',
  'resonant-orbit': 'resonant_orbit',
  'set-target': 'set_target',
  'get-target': 'get_target',
  'get-targets': 'get_targets',
  'clear-target': 'clear_target',
  'execute-node': 'execute_node',
  'clear-nodes': 'clear_nodes',
  'crash-avoidance': 'crash_avoidance',
  'list-saves': 'list_saves',
  'load-save': 'load_save',
  'run-script': 'run_script',
  'list-cpus': 'list_cpus',
  'switch-cpu': 'switch_cpu',
};

// Tool-specific positional argument mappings
// Maps: tool_name -> [arg1Name, arg2Name, ...]
const POSITIONAL_ARGS: Record<string, string[]> = {
  'launch_ascent': ['altitude'],
  'hohmann_transfer': ['target'],
  'adjust_apoapsis': ['altitude'],
  'adjust_periapsis': ['altitude'],
  'ellipticize': ['periapsis', 'apoapsis'],
  'circularize': ['timeRef'],
  'change_inclination': ['newInclination'],
  'set_target': ['name'],
  'course_correct': ['targetDistance'],
  'match_planes': ['target'],
  'match_velocities': ['target'],
  'interplanetary_transfer': ['target'],
  'warp': ['target'],
  'command': ['command'],
  'quicksave': ['saveName'],
  'load_save': ['saveName'],
  'run_script': ['sourcePath'],
  'crash_avoidance': ['targetPeriapsis'],
  'return_from_moon': ['targetPeriapsis'],
  'resonant_orbit': ['numerator', 'denominator'],
  'change_ascending_node': ['lan'],
  'change_periapsis_longitude': ['longitude'],
  'change_semi_major_axis': ['semiMajorAxis'],
  'change_eccentricity': ['eccentricity'],
  'switch_cpu': ['cpuId'],
};

/**
 * Parse CLI arguments into tool arguments object
 */
function parseArgs(args: string[], toolName: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const positionalNames = POSITIONAL_ARGS[toolName] || [];
  let positionalIndex = 0;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--')) {
      // Named argument: --key=value or --key value or --flag
      const eqIndex = arg.indexOf('=');
      if (eqIndex !== -1) {
        const key = kebabToCamel(arg.slice(2, eqIndex));
        const value = parseValue(arg.slice(eqIndex + 1));
        result[key] = value;
      } else {
        const key = kebabToCamel(arg.slice(2));
        // Check if next arg is a value or another flag
        if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
          result[key] = parseValue(args[i + 1]);
          i++;
        } else {
          // Boolean flag
          result[key] = true;
        }
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      // Short flag: -x (treat as boolean)
      const key = arg.slice(1);
      result[key] = true;
    } else {
      // Positional argument
      if (positionalIndex < positionalNames.length) {
        result[positionalNames[positionalIndex]] = parseValue(arg);
        positionalIndex++;
      }
    }
  }

  return result;
}

/**
 * Parse a string value into appropriate type
 */
function parseValue(value: string): unknown {
  // Boolean
  if (value.toLowerCase() === 'true') return true;
  if (value.toLowerCase() === 'false') return false;

  // Number
  const num = Number(value);
  if (!isNaN(num) && value.trim() !== '') return num;

  // String
  return value;
}

/**
 * Convert kebab-case to camelCase
 */
function kebabToCamel(str: string): string {
  return str.replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Resolve tool name from alias or convert kebab to snake
 */
function resolveToolName(command: string): string {
  // Check aliases first
  if (TOOL_ALIASES[command]) {
    return TOOL_ALIASES[command];
  }

  // Convert kebab-case to snake_case
  return command.replaceAll('-', '_');
}

/**
 * Print help message
 */
async function printHelp(): Promise<void> {
  console.log(`
ksp-mcp - CLI for KSP automation via kOS and MechJeb

Usage: ksp-mcp <command> [args...] [options]

Launch & Orbit:
  status                    Get ship info: orbit, fuel, position
  launch [altitude]         Launch into orbit (default: 80km)
  circularize               Circularize current orbit
  ellipticize               Set both apoapsis and periapsis

Transfers:
  hohmann <target>          Transfer to moon (Mun, Minmus)
  interplanetary [target]   Transfer to planet (waits for window)
  return [periapsis]        Return from moon to Kerbin
  course-correct [distance] Fine-tune approach trajectory

Rendezvous:
  target <name>             Set navigation target
  targets                   List available targets
  get-target                Show current target
  clear-target              Clear navigation target
  match-planes              Align orbit with target
  match-velocities          Match speed with target

Orbital Maneuvers:
  adjust-apoapsis <alt>     Change orbit high point
  adjust-periapsis <alt>    Change orbit low point
  change-inclination <deg>  Change orbital inclination
  resonant <num> <denom>    Create resonant orbit (e.g., 2 3 for 2:3)

Advanced Orbital:
  change-ascending-node <lan>        Change longitude of ascending node
  change-periapsis-longitude <lon>   Rotate orbit orientation
  change-semi-major-axis <sma>       Change orbital period
  change-eccentricity <ecc>          Change orbit shape

Execution:
  execute                   Execute next maneuver node
  clear                     Delete all maneuver nodes
  warp <target>             Time warp (node, soi, periapsis, apoapsis, <seconds>)
  crash                     Emergency burn to avoid crash

Utility:
  save <name>               Create quicksave
  load <name>               Load quicksave
  saves                     List quicksaves
  command <kos-cmd>         Run raw kOS command
  run <script-path>         Run kOS script file
  cpus                      List available kOS CPUs
  cpu <id>                  Switch to different CPU

Meta:
  list-tools                List all available MCP tools (with descriptions)
  help                      Show this help

Options:
  --execute=false           Plan only, don't execute (most maneuver commands)
  --time-ref <ref>          When to execute (APOAPSIS, PERIAPSIS, etc.)
  --capture                 Include capture burn (hohmann)
  --verbose                 Show MCP protocol details

Examples:
  ksp-mcp launch 100000                    # Launch to 100km orbit
  ksp-mcp hohmann Mun --capture            # Transfer to Mun with capture
  ksp-mcp return 40000                     # Return from moon, 40km periapsis
  ksp-mcp warp soi                         # Warp to SOI change
  ksp-mcp circularize --time-ref PERIAPSIS # Circularize at periapsis
  ksp-mcp interplanetary Duna              # Transfer to Duna
`);
}

/**
 * Print list of available tools
 */
async function printToolList(): Promise<void> {
  try {
    const tools = await listTools();
    console.log('\nAvailable MCP Tools:\n');
    for (const tool of tools) {
      const desc = tool.description ? ` - ${tool.description}` : '';
      console.log(`  ${tool.name}${desc}`);
    }
    console.log();
  } catch (error) {
    console.error('Error listing tools:', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Main CLI entry point
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Handle no arguments or help
  if (args.length === 0 || args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
    await printHelp();
    return;
  }

  // Handle list-tools
  if (args[0] === 'list-tools' || args[0] === 'tools') {
    await printToolList();
    await cleanup();
    return;
  }

  // Get command and resolve to tool name
  const command = args[0];
  const toolName = resolveToolName(command);
  const toolArgs = parseArgs(args.slice(1), toolName);

  // Check for verbose flag
  const verbose = toolArgs.verbose === true;
  delete toolArgs.verbose;

  if (verbose) {
    console.log(`[MCP] Tool: ${toolName}`);
    console.log(`[MCP] Args: ${JSON.stringify(toolArgs)}`);
  }

  try {
    const result = await callTool(toolName, toolArgs);

    if (result.isError) {
      console.error(`Error: ${result.content}`);
      process.exitCode = 1;
    } else {
      console.log(result.content);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

// Run
main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
