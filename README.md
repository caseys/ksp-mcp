<p align="center">
  <img src="ksp-mcp-logo.jpg" width="512" height="512" alt="ksp-mcp logo">
</p>

# ksp-mcp

STATUS: EARLY DEV

MCP (Model Context Protocol) server for Kerbal Space Program automation via kOS and MechJeb2.

Enables LLMs to directly control KSP spacecraft through kOS scripting and MechJeb autopilot features.

## Prerequisites

- **Kerbal Space Program** with the following mods:
  - [kOS](https://github.com/KSP-KOS/KOS) - Scripting and automation
  - [MechJeb2](https://github.com/MuMech/MechJeb2) - Autopilot and maneuver planning (dev version needed)
  - [kOS.MechJeb2.Addon](https://github.com/belpyro/kOS.MechJeb2.Addon) - Exposes MechJeb to kOS (in active dev)

- **kOS Telnet Server** enabled (configured in KSP settings)

## Installation

```bash
npm install ksp-mcp
```

Or from source:

```bash
git clone https://github.com/caseys/ksp-mcp
cd ksp-mcp
npm install
npm run build
```

## Usage

### As a TypeScript/JavaScript Library

Import ksp-mcp directly in your TypeScript or JavaScript projects:

```typescript
import { KosConnection, config } from 'ksp-mcp';

// Connect to kOS
const conn = new KosConnection();
await conn.connect();

// Execute kOS commands
const result = await conn.execute('PRINT "Hello from kOS".');
console.log(result.output);

// Disconnect
await conn.disconnect();
```

#### Available Exports

```typescript
// Core connection
import { KosConnection } from 'ksp-mcp';
import type { ConnectionState, CommandResult, KosConnectionOptions } from 'ksp-mcp';

// Transport layer
import { BaseTransport, SocketTransport, TmuxTransport } from 'ksp-mcp';
import type { Transport } from 'ksp-mcp';

// MechJeb interface - High-level (recommended)
import { ManeuverOrchestrator, withTargetAndExecute } from 'ksp-mcp';
import type { ManeuverOptions, OrchestratedResult } from 'ksp-mcp';

// MechJeb interface - Low-level
import { MechJebClient, ManeuverProgram, AscentProgram, AscentHandle } from 'ksp-mcp';

// MechJeb operations (direct functions)
import {
  executeNode, getNodeProgress,
  ellipticize, changeSemiMajorAxis,
  changeEccentricity, changeLAN, changeLongitudeOfPeriapsis,
  matchPlane, killRelativeVelocity,
  resonantOrbit, returnFromMoon, interplanetaryTransfer
} from 'ksp-mcp';

// MechJeb telemetry
import { getVesselState, getOrbitInfo, getMechJebInfo, getQuickStatus } from 'ksp-mcp';

// MechJeb discovery
import { discoverModules, isMechJebAvailable } from 'ksp-mcp';

// Configuration
import { config } from 'ksp-mcp';
import type { Config } from 'ksp-mcp';

// MCP Server
import { createServer } from 'ksp-mcp';

// Tool handlers (for direct use without MCP)
import { handleConnect, handleDisconnect, handleExecute, handleStatus, getConnection } from 'ksp-mcp';
import { handleListCpus } from 'ksp-mcp';
import type { CpuInfo } from 'ksp-mcp';

// Connection monitoring
import { KosMonitor, globalKosMonitor } from 'ksp-mcp';
import type { MonitorStatus, LoopDetection } from 'ksp-mcp';

// Save/Load (KUNIVERSE)
import { listQuicksaves, quicksave, quickload, canQuicksave } from 'ksp-mcp';

// Subpath imports also available
import { KosConnection } from 'ksp-mcp/transport';
import { MechJebClient, ManeuverOrchestrator } from 'ksp-mcp/mechjeb';
import { config } from 'ksp-mcp/config';
import { createServer } from 'ksp-mcp/server';
import * as daemon from 'ksp-mcp/daemon';  // Persistent connection daemon
```

### As MCP Server (Stdio - Default)

For Claude Desktop and local tools:

```bash
# Start with stdio transport (default)
ksp-mcp

# Or explicitly
ksp-mcp --transport stdio
```

Configure in Claude Code's MCP settings:

```json
{
  "mcpServers": {
    "ksp-mcp": {
      "command": "npx",
      "args": ["ksp-mcp"]
    }
  }
}
```

Or with a local installation:

```json
{
  "mcpServers": {
    "ksp-mcp": {
      "command": "node",
      "args": ["/path/to/ksp-mcp/dist/index.js"]
    }
  }
}
```

### As MCP Server (HTTP - Network)

For network access using the [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports):

```bash
# Start on localhost:3000 (stateful - session-based)
ksp-mcp --transport http --port 3000

# Listen on all interfaces
ksp-mcp --transport http --host 0.0.0.0 --port 3000

# Stateless mode (no session management)
ksp-mcp --transport http --stateless
```

Endpoints:
- `POST/GET/DELETE /mcp` - MCP Streamable HTTP endpoint
- `GET /health` - Health check (shows session count)

Clients connect by POSTing to `/mcp`. The server returns a session ID in the `mcp-session-id` header which must be included in subsequent requests.

### Direct Script Usage

All maneuver commands support `--no-execute` to plan only (create node without executing).

```bash
# Ascent
npm run ascent              # Launch to orbit with MechJeb

# Basic orbital maneuvers (auto-execute by default)
npm run circularize                    # Circularize at apoapsis
npm run circularize PERIAPSIS          # Circularize at periapsis
npm run circularize -- --no-execute    # Plan only
npm run change-periapsis    # Adjust periapsis
npm run change-apoapsis     # Adjust apoapsis
npm run ellipticize         # Set both Pe and Ap
npm run semimajor           # Change semi-major axis

# Orbital adjustments
npm run change-inclination 0                       # Change to 0° inclination
npm run change-inclination 0 EQ_NEAREST_AD         # Specify timing
npm run change-inclination 0 -- --no-execute       # Plan only
npm run eccentricity        # Change eccentricity
npm run lan                 # Change longitude of ascending node
npm run longitude           # Change longitude of periapsis

# Transfers
npm run hohmann                        # Transfer to Mun (default)
npm run hohmann Minmus                 # Transfer to Minmus
npm run hohmann Mun -- --capture       # Include capture burn
npm run hohmann -- --no-execute        # Plan only
npm run course-correction   # Fine-tune approach
npm run interplanetary      # Interplanetary transfer
npm run return-from-moon    # Return from moon
npm run resonant-orbit      # Resonant orbit for satellite deployment

# Rendezvous
npm run set-target          # Set navigation target
npm run match-plane         # Match orbital plane
npm run match-velocities    # Match velocities at closest approach
npm run kill-rel-vel        # Zero relative velocity

# Node execution
npm run execute-node        # Execute next maneuver node

# Time warp
npm run warp                # Control time warp

# Save/Load
npm run load-save           # Load a saved game

# Daemon (persistent connection)
npm run daemon:start        # Start kOS connection daemon
npm run daemon:status       # Check daemon status
npm run kos                 # Execute kOS command via daemon
```

## MCP Tools

> **Note:** Connection to kOS is automatic. All tools auto-connect when called.

### Connection & Utility

- **status** - Get connection status
- **disconnect** - Disconnect from kOS
- **execute** - Execute raw kOS commands
- **list_cpus** - List available kOS CPUs
- **set_cpu** - Set CPU preference for session (by ID or label), or clear to auto-select
- **telemetry** - Get ship orbit/status info

### Targeting

- **set_target** - Set navigation target (body or vessel)
- **get_target** - Get current target info
- **clear_target** - Clear current target

### Time Control

- **warp** - Time warp to event (soi, node, periapsis, apoapsis) or seconds

### Save/Load

- **load_save** - Load a saved game
- **list_saves** - List available saves
- **quicksave** - Create a quicksave

### Basic Maneuvers

- **adjust_pe** - Change periapsis altitude
- **adjust_ap** - Change apoapsis altitude
- **circularize** - Circularize orbit
- **ellipticize** - Set both periapsis and apoapsis
- **change_sma** - Change semi-major axis

### Orbital Adjustments

- **change_inc** - Change orbital inclination
- **change_ecc** - Change orbital eccentricity
- **change_lan** - Change longitude of ascending node
- **change_lpe** - Change longitude of periapsis

### Rendezvous

- **match_planes** - Match orbital plane with target
- **match_velocities** - Match velocity with target

### Transfers

- **hohmann** - Plan Hohmann transfer to target
- **course_correct** - Fine-tune closest approach
- **resonant_orbit** - Create resonant orbit
- **return_from_moon** - Return from moon to parent body
- **interplanetary** - Plan interplanetary transfer

### Node Execution

- **execute_node** - Execute next maneuver node

### Ascent

- **launch** - Launch to orbit
- **ascent_status** - Get ascent progress
- **abort_ascent** - Abort ascent

## Example Mission Flow

### Using MCP Tools

```javascript
// Connection is automatic - just call the tools you need!

// 1. Launch to orbit
await launch({ altitude: 150000, inclination: 0 });

// 2. Set target and plan transfer
await set_target({ name: "Mun" });
await hohmann();
await execute_node();

// 3. Course correction
await course_correct({ targetDistance: 50000 });
await execute_node();

// 4. Warp to Mun, then circularize
await warp({ target: "soi" });
await circularize({ timeRef: "PERIAPSIS" });
await execute_node();
```

### Using Library API

The library follows a "library-first" architecture where CLI and MCP are thin wrappers over the core library.

```typescript
import { KosConnection, ManeuverOrchestrator } from 'ksp-mcp';

const conn = new KosConnection();
await conn.connect();

const orchestrator = new ManeuverOrchestrator(conn);

// Transfer to Mun with auto-execution
const result = await orchestrator.hohmannTransfer('COMPUTED', false, {
  target: 'Mun',    // Auto-sets target
  execute: true,    // Auto-executes node (default)
});

if (result.success) {
  console.log(`Transfer complete! ΔV: ${result.deltaV} m/s`);
}

// Or plan without executing
const planOnly = await orchestrator.circularize('APOAPSIS', { execute: false });
console.log(`Node created: ${planOnly.deltaV} m/s`);

await conn.disconnect();
```

#### Low-level API

For more control, use `ManeuverProgram` directly:

```typescript
import { KosConnection, ManeuverProgram, executeNode } from 'ksp-mcp';

const conn = new KosConnection();
await conn.connect();

const maneuver = new ManeuverProgram(conn);

// Set target manually
await maneuver.setTarget('Mun', 'body');

// Plan transfer (does not execute)
const result = await maneuver.hohmannTransfer('COMPUTED', false);

// Execute separately
if (result.success) {
  await executeNode(conn);
}

await conn.disconnect();
```

## Configuration

Create a `.env` file (or copy from `.env.example`):

```bash
# kOS Telnet Server
KOS_HOST=127.0.0.1
KOS_PORT=5410

# Default CPU selection
KOS_CPU_ID=0
# or use label:
# KOS_CPU_LABEL=guidance
```

## Project Structure

```
src/
├── index.ts                    # CLI entry point (MCP server + transport options)
├── lib.ts                      # Public API barrel exports
├── server.ts                   # MCP tool definitions
├── config.ts                   # Configuration with dotenv support
├── transport/
│   ├── kos-connection.ts       # kOS telnet connection
│   ├── transport.ts            # Base transport interface
│   ├── socket-transport.ts     # Socket transport layer (default)
│   └── tmux-transport.ts       # Tmux transport layer
├── mechjeb/
│   ├── index.ts                # MechJeb exports
│   ├── mechjeb-client.ts       # MechJeb client
│   ├── discovery.ts            # Module discovery
│   ├── telemetry.ts            # Vessel/orbit telemetry
│   └── programs/
│       ├── orchestrator.ts     # High-level API with target/execute handling
│       ├── maneuver.ts         # Low-level maneuver planning
│       ├── ascent.ts           # Ascent guidance
│       ├── warp.ts             # Time warp control
│       ├── basic/              # Basic orbital maneuvers
│       ├── orbital/            # Orbital parameter changes
│       ├── rendezvous/         # Rendezvous operations
│       ├── transfer/           # Transfer operations
│       └── node/               # Node execution
├── kuniverse/                  # Save/load functionality
├── daemon/                     # Background kOS connection daemon
├── monitoring/                 # Connection monitoring
├── tools/
│   ├── connection-tools.ts     # Connection tool handlers
│   └── list-cpus.ts            # CPU listing tool
├── cli/                        # CLI commands
│   ├── ascent/                 # Launch commands
│   ├── basic/                  # Basic maneuver commands
│   ├── orbital/                # Orbital adjustment commands
│   ├── rendezvous/             # Rendezvous commands
│   ├── transfer/               # Transfer commands
│   ├── node/                   # Node execution commands
│   ├── warp/                   # Time warp commands
│   └── save/                   # Save/load commands
└── scripts/
    └── check-setup.ts          # Setup verification
```


## CLI Options

```
ksp-mcp [options]

Options:
  -t, --transport <type>  Transport type: stdio (default), http
  -p, --port <port>       Port for HTTP transport (default: 3000)
  -h, --host <host>       Host for HTTP transport (default: 127.0.0.1)
  --stateless             Run HTTP in stateless mode (no sessions)
  --help                  Show help
```


## License

MIT
