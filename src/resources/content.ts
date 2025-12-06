/**
 * MCP Resource content for kOS connection documentation
 */

export const CONNECTION_GUIDE = `# kOS Connection Guide

## Quick Start

The simplest way to connect to kOS:

\`\`\`
1. kos_connect(cpuLabel: "guidance")
2. kos_execute(command: "PRINT ALTITUDE.")
3. kos_disconnect()
\`\`\`

## Available Tools

### kos_list_cpus
Discover available kOS CPUs without connecting.

**Parameters:**
- \`host\` (optional): kOS server host (default: "127.0.0.1")
- \`port\` (optional): kOS server port (default: 5410)
- \`transportType\` (optional): "socket" or "tmux" (default: "socket")

**Returns:** Array of CPU info with id, vessel, tag, etc.

**Example:**
\`\`\`
kos_list_cpus()
→ [
    { id: 1, vessel: "stick 1", tag: "guidance", ... },
    { id: 2, vessel: "probe 1", tag: "flight", ... }
  ]
\`\`\`

### kos_connect
Connect to a kOS CPU by ID or label.

**Parameters:**
- \`cpuId\` (optional): Numeric CPU ID (e.g., 1)
- \`cpuLabel\` (optional): CPU tag/label (e.g., "guidance")
- \`host\` (optional): kOS server host (default: "127.0.0.1")
- \`port\` (optional): kOS server port (default: 5410)
- \`transportType\` (optional): "socket" or "tmux" (default: "socket")

**Note:** Exactly one of \`cpuId\` or \`cpuLabel\` must be provided.

**Examples:**
\`\`\`
kos_connect(cpuLabel: "guidance")  // Connect to 'guidance' CPU
kos_connect(cpuId: 1)               // Connect to CPU #1
\`\`\`

### kos_execute
Execute a kOS command.

**Parameters:**
- \`command\`: kOS command to execute
- \`timeout\` (optional): Timeout in milliseconds (default: 5000)

**Returns:** \`{ success: boolean, output: string, error?: string }\`

**Example:**
\`\`\`
kos_execute(command: "PRINT SHIP:ALTITUDE.")
→ { success: true, output: "123456.789" }
\`\`\`

### kos_status
Get current connection status.

**Returns:** Connection state with cpuId, vessel name, tag, etc.

### kos_disconnect
Disconnect from kOS.

**Returns:** \`{ disconnected: true }\`

## Workflows

### Discovery Workflow
When you don't know which CPUs are available:

\`\`\`
1. kos_list_cpus()           → See available CPUs
2. kos_connect(cpuLabel: "guidance")
3. kos_execute(command: "...")
4. kos_disconnect()
\`\`\`

### Direct Connection
When you know the CPU label:

\`\`\`
1. kos_connect(cpuLabel: "guidance")
2. kos_execute(command: "...")
3. kos_disconnect()
\`\`\`

### Multiple Commands
\`\`\`
1. kos_connect(cpuLabel: "guidance")
2. kos_execute(command: "SET x TO 42.")
3. kos_execute(command: "PRINT x.")
4. kos_disconnect()
\`\`\`

## Best Practices

1. **Use labels over IDs**: Labels like "guidance" are more descriptive than numeric IDs
2. **Always disconnect**: Call \`kos_disconnect()\` when done
3. **Check status**: Use \`kos_status()\` to verify connection state
4. **Discover first**: Use \`kos_list_cpus()\` when uncertain
5. **Handle errors**: Check \`success\` field in execute results

## Troubleshooting

### "Not connected to kOS"
- Call \`kos_connect()\` first
- Check that KSP is running with kOS mod loaded
- Verify kOS telnet server is enabled

### "No such CPU with label X"
- Use \`kos_list_cpus()\` to see available CPUs
- Check CPU tag in KSP (kOS part action menu)
- Verify spelling of label (case-insensitive)

### Connection timeout
- Ensure kOS telnet server is running on port 5410
- Check that CPU menu appears when connecting via telnet manually
- Try \`transportType: "tmux"\` as alternative

## Transport Options

ksp-mcp supports two transport backends:

### Socket Transport (default)
- Uses Node.js net.Socket for direct TCP connection
- Event-driven I/O
- Recommended for most cases
- No external dependencies
- Requires: \`transportType: "socket"\` (or omit for default)

### Tmux Transport
- Uses tmux for session management with nc (netcat)
- Polling-based I/O
- Useful for debugging (can attach with \`tmux attach\`)
- Requires: \`transportType: "tmux"\`

**Example:**
\`\`\`
kos_connect(cpuLabel: "guidance", transportType: "tmux")
\`\`\`
`;

export const CPU_MENU_FORMAT = `# kOS CPU Menu Format

When connecting to the kOS telnet server on port 5410, you see a CPU selection menu:

\`\`\`
Connected to the kOS Terminal Server.
Terminal: type = INITIAL_UNSET, size = 80x24
________________________________________________________________________________
              Menu GUI   Other
              Pick Open Telnets  Vessel Name (CPU tagname)
              ---- ---- -------  --------------------------------
               [1]   no    0     stick 1 (RC-L01(guidance))
               [2]  yes    1     probe 1 (RC-M01(flight))
               [3]   no    0     probe 1 (RC-M02())
--------------------------------------------------------------------------------
Choose a CPU to attach to by typing a selection number and pressing
return/enter. Or enter [Q] to quit terminal server.
\`\`\`

## Format Breakdown

Each CPU line follows this pattern:
\`\`\`
[ID] GUI_OPEN TELNETS VESSEL_NAME (PART_NAME(TAG))
\`\`\`

**Fields:**
- \`ID\`: Numeric CPU identifier (e.g., 1, 2, 3)
- \`GUI_OPEN\`: "yes" if kOS terminal GUI is open for this CPU, "no" otherwise
- \`TELNETS\`: Number of active telnet connections to this CPU
- \`VESSEL_NAME\`: Name of the vessel/craft this CPU is on
- \`PART_NAME\`: kOS part name (e.g., RC-L01, RC-M01)
- \`TAG\`: CPU tag/label set in KSP (can be empty)

## Examples

\`\`\`
[1]   no    0     stick 1 (RC-L01(guidance))
\`\`\`
- ID: 1
- GUI not open
- No active telnets
- Vessel: "stick 1"
- Part: "RC-L01"
- Tag: "guidance"

\`\`\`
[2]  yes    1     probe 1 (RC-M01(flight))
\`\`\`
- ID: 2
- GUI is open
- 1 active telnet connection
- Vessel: "probe 1"
- Part: "RC-M01"
- Tag: "flight"

\`\`\`
[3]   no    0     probe 1 (RC-M02())
\`\`\`
- ID: 3
- GUI not open
- No active telnets
- Vessel: "probe 1"
- Part: "RC-M02"
- Tag: (empty/unnamed)

## How ksp-mcp Uses This

The \`kos_connect\` tool can connect by:

1. **CPU ID** (\`cpuId\`): Select by numeric ID (e.g., 1, 2, 3)
2. **CPU Label** (\`cpuLabel\`): Search for matching tag (e.g., "guidance")

The \`kos_list_cpus\` tool parses this menu and returns structured data:
\`\`\`typescript
[
  {
    id: 1,
    vessel: "stick 1",
    partName: "RC-L01",
    tag: "guidance",
    guiOpen: false,
    telnets: 0
  },
  ...
]
\`\`\`
`;

export const TRANSPORT_OPTIONS = `# Transport Options

ksp-mcp uses a transport abstraction layer to communicate with kOS telnet.

## Why Transport Abstraction?

The telnet connection to kOS requires:
- Session management (connect, disconnect)
- CPU selection menu handling
- Command execution with proper timing
- Output buffering and parsing
- ANSI escape sequence handling

Rather than expose this complexity, ksp-mcp provides high-level tools that handle it automatically.

## Available Transports

### 1. Socket Transport (Default)

**Technology:** Node.js net.Socket (direct TCP)

**Pros:**
- Event-driven I/O (efficient)
- Only receives new data (no re-processing)
- No external dependencies (pure JavaScript)
- Best for MCP integration
- Cross-platform (macOS, Windows, Linux)
- TCP keepalive for long operations

**Cons:**
- Can't attach for debugging

**Usage:**
\`\`\`
kos_connect(cpuLabel: "guidance")  // Uses socket by default
\`\`\`

### 2. Tmux Transport

**Technology:** tmux CLI (terminal multiplexer)

**Pros:**
- Can attach to session: \`tmux attach -t kos\`
- Pure shell commands (no native modules)
- Useful for debugging
- Can see session in real-time

**Cons:**
- Polling-based (re-captures output)
- Requires tmux binary installed
- More overhead

**Usage:**
\`\`\`
kos_connect(cpuLabel: "guidance", transportType: "tmux")
\`\`\`

**Debugging:**
\`\`\`bash
# In another terminal:
tmux attach -t kos  # See the kOS session live
\`\`\`

## Manual tmux-mcp Usage (Advanced)

If you need direct tmux control via MCP tmux tools (\`mcp__tmux__*\`):

**Why you might NOT want this:**
- Much more complex (10+ steps vs 2 steps)
- Requires manual timing and session management
- Error-prone
- ksp-mcp tools already handle this

**But if you really need it:**
\`\`\`
1. mcp__tmux__create-session(name: "kos-debug")
2. mcp__tmux__list-panes() → get paneId
3. mcp__tmux__execute-command(paneId, "nc 127.0.0.1 5410", rawMode: true)
4. [Wait 1 second]
5. mcp__tmux__capture-pane(paneId) → verify menu appeared
6. mcp__tmux__execute-command(paneId, "1", noEnter: true)
7. mcp__tmux__execute-command(paneId, "C-m", noEnter: true)
8. [Wait 2 seconds]
9. mcp__tmux__execute-command(paneId, "PRINT ALTITUDE.", noEnter: true)
10. mcp__tmux__execute-command(paneId, "C-m", noEnter: true)
11. [Wait 1 second]
12. mcp__tmux__capture-pane(paneId) → read output
\`\`\`

Compare to ksp-mcp approach:
\`\`\`
1. kos_connect(cpuLabel: "guidance")
2. kos_execute("PRINT ALTITUDE.")
\`\`\`

## Recommendation

**Use ksp-mcp tools** (\`kos_connect\`, \`kos_execute\`, etc.) for 99% of cases.

Only use manual tmux-mcp if:
- You need to debug the transport layer itself
- You're investigating timing/buffering issues
- You want to see raw telnet interaction

Otherwise, the high-level tools are simpler, more reliable, and easier to use.
`;
