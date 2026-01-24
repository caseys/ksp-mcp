# Plan: Event-Driven kOS Architecture ("New World")

## Overview

Replace the current polling-based daemon architecture with an event-driven, file-backed control system. This eliminates the fundamental problem: current design sends Ctrl+C before every command, killing the daemon loop.

**Key Insights**:
1. WHEN triggers persist after program termination
2. **Triggers execute at yield points** (after WAIT or instruction slice boundaries), never preempt instructions
3. TypeScript can safely send commands by waiting for ready marker
4. **No Ctrl+C ever** - it's an emergency abort, not a protocol

**Important**: Triggers may run during long actions that yield (e.g., contain WAIT). This is not strict exclusivity.

---

## Terminal Contract

### The Core Rule
> **TypeScript must only send commands when it has positively observed a "ready" marker printed by kOS.**

The ready marker is `[MCP READY]>` - a protocol marker we control, not the kOS prompt.

### Ready Marker Protocol

**1. Status script always prints ready marker last:**
```kerboscript
// mcp_status.ks - purely observational, no side effects
@LAZYGLOBAL OFF.
// Prints exactly one JSON object line, nothing else
PRINT JSON:STRINGIFY(statusJson).
PRINT "[MCP READY]>".  // MUST be last line
```

**2. Commands that don't produce output end with status:**
```kerboscript
// TypeScript sends:
RUNPATH("1:/boot/do_something"). RUNPATH("1:/boot/mcp_status").
```

**3. Long-running actions own the terminal:**
- Do NOT print ready marker during execution
- Call status explicitly when done:
```kerboscript
// End of mcp_landing.ks:
PRINT "Landing complete.".
RUNPATH("1:/boot/mcp_status").
```

### TypeScript Command Flow
```
1. Send exactly one command
2. Read terminal output
3. Ignore everything until [MCP READY]> appears
4. Only then send next command
```

No timing assumptions. No Ctrl+C. No guessing.

### Safe Command Classes
1. **Pure queries**: `PRINT SHIP:STATUS. RUNPATH("1:/boot/mcp_status").`
2. **Short actions**: `RUNPATH("1:/boot/act_circ"). RUNPATH("1:/boot/mcp_status").`
3. **Long actions**: `RUNPATH("1:/boot/act_land").` (action calls status when done)

### Forbidden
- Commands requiring interruption to regain control
- Commands assuming concurrent execution
- Commands depending on terminal timing
- Ctrl+C except for emergency abort

### Why This Doesn't Break Triggers
- `mcp_status` is short and bounded (< 50ms)
- Triggers run when CPU yields (after status completes)
- If trigger fires during status: runs after status, terminal ordering preserved
- TypeScript still waits for `[MCP READY]>` - always safe
- **Triggers must never PRINT** - all trigger effects are file-only

---

## Hard Invariants (Do Not Violate)

### 1. Terminal Output Discipline
- **Only `mcp_status.ks` may print `[MCP READY]>`** - nowhere else, ever
- **WHEN triggers must never PRINT anything** - all effects are file-only
- Action scripts may print human-readable progress but never the ready marker

### 2. Action Exclusivity
- Only one action script may run at a time
- An `MCP_ACTION_ACTIVE` flag must be set before action start and cleared on exit
- Triggers must not launch actions while `MCP_ACTION_ACTIVE` is true
- TypeScript must not launch actions while `MCP_ACTION_ACTIVE` is true

### 3. State Atomicity
- All state writes must use **temp-file + rename** pattern
- State file must always be valid JSON (never partial writes)
- Example: write to `state.tmp`, then `MOVEPATH("state.tmp", "state.json")`

### 4. Trigger Scope
- Triggers may update state files
- Triggers may **not** launch complex actions (unless designated safety override)
- Triggers may **not** change mode while an action is active
- Triggers must exit in bounded time (< 10 statements, no loops)

### 5. Terminal Contract
- TypeScript sends exactly one command at a time
- TypeScript waits for `[MCP READY]>` before sending the next
- Ctrl+C is emergency abort only, never normal protocol

### 6. Safety Overrides (Exception to #2 and #4)
Designated safety triggers (e.g., landed stabilization) may:
- Launch stabilization action even if another action is "active"
- But must set `MCP_ACTION_ACTIVE` and clear when done
- These are the only exception to action exclusivity

---

## Current vs New Architecture

| Aspect | Current | New |
|--------|---------|-----|
| Daemon | UNTIL FALSE loop with WAIT 5 | Set of WHEN triggers |
| State | Global variables (`_MCP_OP`, etc.) | Files: `1:/mcp/*.json` |
| Commands | Ctrl+C + execute | Wait for prompt + execute |
| Status | TypeScript polls (kills scripts) | Short status script, exits |
| Ctrl+C | Before every command | Emergency abort only |
| Terminal | Blocked by daemon 50%+ | Free 95%+ |

---

## Core Components

### 1. Boot Installer (`mcp_boot.ks`)
- Runs once at vessel boot (CORE:BOOTFILENAME)
- Waits for SHIP:UNPACKED
- Ensures directory structure: `1:/mcp/`
- Installs all WHEN triggers
- Initializes state file
- Exits immediately

### 2. Triggers (the "resident logic")
- Persist after program exit
- React to changes, not poll
- Update state file
- Dispatch commands
- Must be short, never loop, always PRESERVE

**Trigger Categories (minimal set):**
- **State Triggers**: SHIP:STATUS, SHIP:BODY, radio status
- **Safety Triggers**: Landed stabilization
- **Deferred**: TARGET changes, orbit achieved (add later if needed)

### 3. State Management

**kOS Internal State** (file-based, for kOS scripts):
- `1:/mcp/state.json` - Written by triggers, read by action scripts
- Stored on volume 1 (local) to avoid archive latency
- `mcp_boot.ks` seeds `1:/mcp/state.json` directly if missing (not from any deployed script file)
- Persists across script exits
- Single source of truth within kOS

**TypeScript Access** (terminal-based):
- TypeScript does NOT read kOS files directly
- Runs status script: `RUNPATH("1:/mcp/status").`
- Status script reads the volume 1 cached state, PRINTs exactly one JSON object line
- TypeScript parses the last JSON object before `[MCP READY]>`
- Action scripts may print human-readable logs but must never PRINT JSON

```
TypeScript → terminal → "RUNPATH..." → kOS runs status → PRINT JSON → terminal → TypeScript
```

**State File Example (minimal):**
```json
{
  "body": "Mun",
  "status": "ORBITING",
  "radio": true,
  "action": ""
}
```
Only fields needed by status script + action tracking. Keep it tiny.
Defer versioning, checksums, target tracking until needed.

### 4. Command Interface

TypeScript sends commands via terminal using **direct action launches only**:

```kerboscript
// TypeScript sends via terminal:
RUNPATH("1:/boot/act_land"). RUNPATH("1:/boot/mcp_status").
// Action runs, updates state, exits, status prints JSON + ready marker
```

No intent variables. No dispatch scripts. No file-based commands.
TypeScript waits for `[MCP READY]>` before sending next command.

### 5. Action Scripts (short-lived)
- Perform one task
- Read state from file
- Write updates to state
- Exit cleanly
- Never install triggers or loop forever

Examples:
- `act_land.ks` - Start MechJeb landing, update state
- `act_circularize.ks` - Plan circularization, update state
- `act_warp.ks` - Execute warp, update state

---

## Implementation Phases

### Phase 1: Ready Marker Protocol
**Replace Ctrl+C + sentinel with ready marker**
1. Update `mcp_status.ks` to print `[MCP READY]>` as last line
2. Modify `kos-connection.ts` to wait for `[MCP READY]>` instead of sentinel
3. Remove `clear=true` default from `execute()` - no more Ctrl+C
4. Update all commands to chain `RUNPATH("1:/boot/mcp_status").` after execution
5. Keep Ctrl+C only for `abort()` emergency function
6. Test: send 10 commands, verify all complete with ready marker

### Phase 2: Boot Installer & Triggers
**Create event-driven foundation**
1. New `mcp_boot.ks` - installs triggers, exits immediately
2. State triggers: SHIP:STATUS, SHIP:BODY, TARGET changes
3. Write state to file on each trigger fire
4. Verify triggers persist and fire when CPU idle
5. Replace `mcp_daemon.ts` loop with trigger installer

### Phase 3: State File System
**kOS internal state, TypeScript reads via terminal**
1. Create `1:/mcp/` directory structure in kOS
2. Implement kOS helpers for JSON state read/write (READJSON/WRITEJSON)
3. Status script (`1:/mcp/status.ks`) reads state file, PRINTs JSON, exits
4. TypeScript runs: `RUNPATH("1:/mcp/status").` and parses terminal output
5. No direct file I/O between TypeScript and kOS - terminal only

### Phase 4: Action Scripts
**Short-lived operations**
1. `act_land.ks` - Start MechJeb landing, set state, exit
2. `act_circularize.ks` - Plan maneuver, set state, exit
3. `act_warp.ks` - Execute warp, set state, exit
4. Touchdown stabilization via WHEN SHIP:STATUS="LANDED" trigger
5. All actions exit in < 1 second

### Phase 5: Tool Migration
**Update MCP tools to new architecture**
1. `land` tool: launches `act_land.ks`, monitors state file
2. `circularize` tool: launches action, waits for node
3. `status` tool: runs status script, returns JSON
4. Remove daemon restart logic from tools
5. Validate all 20+ tools work with new system

---

## Loop-to-Trigger Conversion (Blocking → Event)

### `mcp_daemon.ks` main loop
- **Heartbeat loop**: remove; status script updates state on demand
- **SOI/ship/target changes**: keep as WHEN triggers (already supported)
- **Radio change**: WHEN `HOMECONNECTION:ISCONNECTED` changes → update state and, if radio is down and no action is active, run `act_blackout_warp` (short-lived)
- **Landing monitor**: replace `_MCP_OP` loop with state-driven triggers + actions

### `mcp_landing.ks` long loop
- Split into short actions:
  - `act_land.ks` starts MechJeb landing and exits immediately
  - `act_stabilize.ks` runs on touchdown (triggered by `SHIP:STATUS = LANDED/SPLASHED`)
- Optional: `act_landing_watch.ks` for stall detection, invoked only when radio is down and altitude is low; runs a bounded loop then exits

### Trigger lifecycle
- Triggers are installed once by `mcp_boot.ks` and persist after program exit
- No trigger reinstall per TypeScript command

## Key Files to Create

| File | Type | Purpose |
|------|------|---------|
| `src/utils/mcp-boot.ts` | TS Generator | Generates boot installer + triggers |

**kOS Scripts Generated:**
- `mcp_boot.ks` - Boot installer (installs triggers, seeds state, exits)
- `mcp_status.ks` - Status renderer (already exists, add ready marker)
- `act_land.ks` - Start MechJeb landing, update state, exit
- `act_stabilize.ks` - Post-touchdown stabilization

No dispatch scripts. No command files. Direct action launches only.

---

## Files to Modify/Remove

| File | Action |
|------|--------|
| `src/utils/mcp-daemon.ts` | Replace with boot installer + triggers |
| `src/utils/boot-deploy.ts` | Update for new boot system |
| `src/utils/kos-operation-state.ts` | Replace with state read via status script |
| `src/transport/connection-tools.ts` | Update health check, remove daemon restart |
| `src/transport/kos-connection.ts` | Remove Ctrl+C default, add prompt detection |

---

## Deployment & Version Tracking (EXISTING - REUSE)

**Keep existing deployment system** in `kos-archive.ts` and `boot-deploy.ts`:

### Existing Infrastructure (KEEP ALL)
- **Direct archive write**: `writeToArchive()` writes directly to `Ships/Script/` via filesystem
- **Version tracking**: MD5 hash per script, `MCP_COMBINED_VERSION` for change detection
- **Volume 1 copy**: `runDaemon()` copies scripts to local volume for blackout resilience
- **Compilation**: Compiles .ks → .ksm on local volume for faster execution
- **Version check in kOS**: Boot script checks `MCP_DAEMON_VERSION` against expected, reinstalls if mismatch
- **Cache invalidation**: Deletes file in kOS before write to force re-read

### What Changes
| Current | New |
|---------|-----|
| `mcp_daemon.ks` (loop) | `mcp_boot.ks` (triggers, exits) |
| `mcp_env.ks` | Keep or merge into boot |
| `mcp_status.ks` | Keep (already short-lived) |
| `mcp_landing.ks` | Convert to `act_land.ks` + WHEN trigger |

### Files to Deploy (new structure)
| Script | Location | Purpose |
|--------|----------|---------|
| `mcp_boot.ks` | 0:/boot/ → 1:/boot/.ksm | Boot installer, installs triggers, exits |
| `mcp_status.ks` | 0:/boot/ → 1:/boot/.ksm | Status renderer (unchanged) |
| `act_land.ks` | 0:/mcp/ → 1:/mcp/.ksm | Start MechJeb landing, exit |
| `act_stabilize.ks` | 0:/mcp/ → 1:/mcp/.ksm | Post-touchdown stabilization |

### Deployment API (minor updates)
```typescript
// Existing functions - keep as-is
deployScript(conn, path, content)  // Direct write + fallback
checkDaemonStatus(conn)            // Rename to checkBootStatus()
runDaemon(conn)                    // Rename to runBoot()

// Update boot-deploy.ts to generate new scripts
generateMcpBoot()     // Replaces generateMcpDaemon()
generateActLand()     // New action script
generateActStabilize() // New action script
```

---

## Critical Design Decisions

### 1. State File Format
- JSON, single file, minimal fields
- Defer versioning/checksums until needed

### 2. Trigger Limits
- Keep trigger bodies short (< 10 statements)
- Defer complex work to action scripts
- Always use PRESERVE

### 3. Command Serialization
- One command at a time
- TypeScript waits for `[MCP READY]>` before sending next
- `MCP_ACTION_ACTIVE` in status JSON prevents concurrent actions

### 4. Performance
- Start simple, defer optimization
- Defer .ksm compilation until needed

---

## WHEN Trigger Examples (minimal set)

```kerboscript
// Status change - includes safety trigger for landing
WHEN SHIP:STATUS <> _prevStatus THEN {
  SET _prevStatus TO SHIP:STATUS.
  // Update state file (temp + rename for atomicity)
  IF SHIP:STATUS = "LANDED" AND MCP_ACTION_ACTIVE {
    RUNPATH("1:/boot/act_stabilize").
  }
  PRESERVE.
}

// Radio status
WHEN HOMECONNECTION:ISCONNECTED <> _prevRadio THEN {
  SET _prevRadio TO HOMECONNECTION:ISCONNECTED.
  PRESERVE.
}

// SOI change
WHEN SHIP:BODY <> _prevBody THEN {
  SET _prevBody TO SHIP:BODY.
  PRESERVE.
}
```

No intent triggers. No target triggers. Add later if needed.

---

## Testing Strategy

1. **Unit Test**: Trigger installation survives Ctrl+C
2. **Unit Test**: State file read/write correctness
3. **Unit Test**: Command dispatch works
4. **Integration**: Landing operation end-to-end
5. **Integration**: Blackout recovery
6. **Stress Test**: Rapid command sequences

---

## Open Questions (to validate during implementation)

1. **Prompt Detection**: What does kOS terminal prompt look like? Is it consistent?
2. **Trigger Timing**: How quickly do triggers fire after CPU becomes idle?
3. **File I/O Speed**: How fast are READJSON/WRITEJSON operations?
4. **Trigger Count Limits**: How many concurrent triggers can kOS handle?

---

## Success Criteria

From new-world.md:
- Terminal usable >95% of time
- No script runs indefinitely
- Commands always serialize
- Rebooting doesn't corrupt state
- Landing works identically
- No dependency on "what ran before"

**Additional from terminal contract:**
- Ctrl+C never used in normal operation
- TypeScript always waits for prompt
- All actions exit in < 1 second

---

## Verification Plan

1. **Phase 1 Test**: Send 10 commands without Ctrl+C, verify all succeed
2. **Phase 2 Test**: Install triggers, send commands, verify triggers still fire
3. **Phase 3 Test**: Write state file, read via status script, verify JSON
4. **Phase 4 Test**: Land on Mun, verify stabilization via WHEN trigger
5. **End-to-End**: Complete Mun mission (launch → transfer → land) with new system

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Prompt detection fails | Add timeout, fall back to delay-based sending |
| Triggers don't fire fast enough | Reduce trigger body complexity |
| State file corrupted | Add checksum/version field |
| Action script hangs | Add timeout in TypeScript, emergency Ctrl+C |

---

## Incremental Migration Path

### Small changes to current code that ease transition:

**1. mcp_status.ts (trivial, backward compatible)**
```typescript
// Current: PRINT "STATUS_COMPACT:"+j.
// New: emit one JSON object line, then ready marker
PRINT j.  // j is a JSON string
PRINT "[MCP READY]>".
```
Current sentinel-based code ignores the marker - no breakage.
JSON-only output matches the new parsing contract.

**2. kos-connection.ts - Add ready marker mode**
```typescript
// New option in execute():
options.readyMarker?: boolean  // If true, wait for [MCP READY]> instead of sentinel

// New method alongside existing waitFor():
async waitForReadyMarker(timeoutMs: number): Promise<string>
```

**3. Test hybrid mode first**
- Keep Ctrl+C (daemon still running)
- But use ready marker for completion detection instead of sentinel
- Validates the marker protocol before changing daemon

**4. mcp-daemon.ts - Add "exit after triggers" flag**
```kerboscript
// Add to generated daemon:
IF MCP_DAEMON_MODE = "triggers" {
  // Install triggers, print status, exit
  RUNPATH("1:/boot/mcp_status").
} ELSE {
  // Current loop behavior
  UNTIL FALSE { ... }
}
```

### Why this ordering helps:
1. Ready marker is backward compatible (add it now)
2. Test ready marker with current system (safe)
3. Switch daemon to trigger mode (terminal free)
4. Remove Ctrl+C (now safe because terminal is free)

---

## First Implementation Step

**Phase 0 - Add Ready Marker (backward compatible, no risk):**
1. Add `PRINT "[MCP READY]>".` to end of mcp_status.ks
2. Deploy and verify marker appears in output
3. Current system still works (sentinel still used)

**Phase 0.5 - Ready Marker Detection:**
1. Add `waitForReadyMarker()` to kos-connection.ts
2. Add `readyMarker: true` option to execute()
3. Test with `clear: true` still (Ctrl+C sent, but ready marker for completion)

**Phase 1 - Trigger-Based Daemon:**
1. New daemon that installs triggers and exits immediately
2. Terminal is now free 95%+ of the time
3. Switch default: `clear: false` (no Ctrl+C)

**Phase 1.5 - Remove Sentinel:**
1. All commands use ready marker
2. Remove sentinel generation code
3. Cleaner protocol


----

Here are the key assumptions we need to validate with minimal experiments:

Critical Unknowns to Test

1. WHEN triggers persist after program exit

// Test: Run this, then run another program, then check if trigger fires
GLOBAL _testFired IS FALSE.
WHEN SHIP:STATUS <> SHIP:STATUS THEN { SET _testFired TO TRUE. PRESERVE. }
PRINT "Triggers installed, exiting...".
Then run PRINT _testFired. after doing something that changes status.

2. Chained RUNPATH executes sequentially

// Does this work? Or does second RUNPATH fail?
RUNPATH("0:/script1"). RUNPATH("0:/script2").
If script1 exits cleanly, does script2 run immediately?

3. Ready marker appears reliably

Can TypeScript detect [MCP READY]> in terminal output without Ctrl+C? Test by:
- Removing clear: true from one execute() call
- Adding PRINT "[MCP READY]>". to end of a script
- See if output parsing works

4. MOVEPATH atomicity

// Does this prevent partial reads?
LOG "data" TO "1:/test.tmp".
MOVEPATH("1:/test.tmp", "1:/test.json").

5. Trigger timing during WAITs

// If action has WAIT, when does trigger fire?
WHEN TRUE THEN { PRINT "TRIGGER FIRED". PRESERVE. }
WAIT 5.  // Does trigger fire during this wait?
PRINT "WAIT done".

Suggested Prototype Order

1. Test #1 and #2 first - These are the foundation. If triggers don't persist or chained RUNPATH doesn't work, the whole plan fails.
2. Test #3 next - If ready marker detection works, we can incrementally migrate.
3. Tests #4 and #5 - These affect robustness but don't invalidate the core approach.
