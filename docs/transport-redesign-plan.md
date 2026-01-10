# Transport Layer Redesign: kOS.Transport.Addon

## Recommendation: New kOS Addon with Structured TCP Protocol

Create a **new kOS addon** (separate from kOS.MechJeb2.Addon) that provides length-prefixed JSON transport on a second TCP socket (port 5411), eliminating command echo parsing entirely.

## Current State Summary

The ksp-mcp transport layer has evolved significantly with these key mechanisms:

### What Works Well
1. **Sentinel markers** - Unique tokens `[MCP.XX.HASH]` for command boundary detection
2. **Command serialization** - Promise-based lock prevents race conditions
3. **Safety monitor** - On-vessel script survives MCP timeouts, handles blackouts autonomously
4. **Blackout-resilient polling** - Distinguishes signal loss vs power loss vs crash
5. **Operation state persistence** - `_MCP_OP` variable survives disconnections
6. **Transport abstraction** - Socket vs Tmux implementations swappable

### Pain Points Encountered
| Issue | Current Workaround |
|-------|-------------------|
| Command echo pollution | Custom markers (ENC\|, PROG\|), check positive before negative |
| Async node creation | Empirical WAIT 0.5 after COURSECORRECTION |
| Unicode control chars | Full protocol stripping (U+E000-U+F8FF) |
| Non-linear MechJeb I/O | Iterative refinement with secant method |
| Stale buffer data | Pre-command flush, "take last N values" |
| Lock timeouts | Auto connection reset on deadlock |
| Thread safety | *TIMED suffix variants for X_FROM_NOW |

## Root Cause Analysis

The fundamental constraints are:

1. **kOS echoes all commands** - Terminal emulation behavior, cannot disable
2. **kOS uses terminal control codes** - Legacy terminal protocol, cannot change
3. **MechJeb operations are async** - Unity/KSP threading model
4. **Telnet is stream-based** - No message framing, no acknowledgments
5. **Radio blackouts are real** - Signal loss during atmospheric entry, far side of bodies

**Key insight**: Most pain points stem from **parsing unstructured terminal output**. The telnet stream itself is reliable; the problem is the lack of structured message protocol.

## Design Options

### Option A: Enhanced Current Approach (Incremental)

Continue refining current patterns:
- Standardize marker protocol across all commands
- Create helper library for marker-based parsing
- Document empirical timing requirements
- Add more comprehensive retry logic

**Pros**: No architectural changes, leverages existing code
**Cons**: Continues accumulating workarounds, still fragile

### Option B: kOS-Side Command Handler Script

Install a persistent kOS script that provides structured command/response:

```kerboscript
// Installed on every connection
SET _MCP_CMD TO "".       // Input: command to execute
SET _MCP_RESP TO "".      // Output: JSON-like response
SET _MCP_SEQ TO 0.        // Sequence number for correlation

WHEN _MCP_CMD <> "" THEN {
  LOCAL seq IS _MCP_SEQ.
  LOCAL cmd IS _MCP_CMD.
  SET _MCP_CMD TO "".

  // Execute and capture result
  LOCAL result IS "".
  // ... execute cmd, build result ...

  SET _MCP_RESP TO seq + "|OK|" + result.
  // Or: SET _MCP_RESP TO seq + "|ERR|" + error.
  PRESERVE.
}
```

Transport becomes:
1. Set `_MCP_CMD` to command string
2. Poll `_MCP_RESP` for matching sequence number
3. Parse structured response (seq|status|payload)

**Pros**:
- Eliminates command echo parsing entirely
- Structured responses with explicit framing
- Sequence numbers for correlation
- Error handling built into protocol

**Cons**:
- Polling latency (10-50ms per command)
- kOS script must handle all command types
- Two layers of abstraction

### Option C: Hybrid Protocol

Keep telnet for simple commands, use variable-based protocol for complex operations:

```typescript
// Simple commands: direct telnet with sentinel
await conn.execute('PRINT ALTITUDE.');

// Complex operations: variable protocol
await conn.executeStructured('PLANNER:COURSECORRECTION(50000)', {
  expectMarker: 'COURSERESULT',
  timeout: 10000
});
```

The kOS side would have operation-specific handlers that format responses properly.

**Pros**: Best of both worlds
**Cons**: Two code paths to maintain

### Option D: kOS Addon for Structured Transport

Create a small kOS addon (C#) that provides:
- Message framing (length-prefixed)
- Request/response correlation
- Binary-safe transport
- Heartbeat/keepalive at protocol level

**Pros**: Proper solution at the right layer
**Cons**: Another KSP plugin to maintain, kOS dependency coupling

### Option E: Accept Current Design

The current system works. The workarounds are documented and tested. A redesign may not provide proportional benefit.

**Assessment from exploration**: "The architecture is well-designed for its constraints. A redesign would only be necessary if you needed true concurrent execution or lower latency."

## Recommendation Considerations

Questions to answer before deciding:

1. **How much time is spent on transport bugs vs feature development?**
   - If transport bugs are rare now, Option E (accept current) is valid

2. **Is latency a problem?**
   - Current: ~30-50ms per command
   - Variable polling: ~50-100ms per command
   - If latency matters, Option D is the only real improvement

3. **Would a kOS-side script (Option B) simplify enough operations?**
   - Course correction iterative loop would be cleaner
   - Telemetry queries would be simpler
   - But simple commands get slower

4. **Is maintaining another plugin (Option D) worth it?**
   - Already maintaining kOS.MechJeb2.Addon
   - Could add transport features there

## Files That Would Change

If pursuing Option B (kOS-side handler):
- `src/transport/kos-connection.ts` - Add structured execute method
- `src/transport/connection-tools.ts` - Install handler script
- `src/lib/mechjeb/*.ts` - Migrate to structured calls
- New: `src/transport/structured-protocol.ts`

If pursuing Option D (kOS addon):
- New C# project or extend kOS.MechJeb2.Addon
- `src/transport/kos-connection.ts` - New transport type
- Extensive migration of all commands

---

## Recommended Approach: kOS.Transport.Addon

### Why a Second Socket?

The existing telnet server (port 5410) is deeply tied to kOS's terminal emulation. A **separate socket** (port 5411):
- Keeps terminal available for debugging/interactive use
- No need to modify kOS core code
- Clean separation: structured API vs human-readable terminal

### Protocol: Length-Prefixed JSON

```
[4 bytes: length (big-endian uint32)][JSON payload]
```

**Request types:**
```json
// Evaluate expression
{"id": 1, "type": "eval", "expr": "APOAPSIS"}

// Execute command
{"id": 2, "type": "exec", "command": "SET TARGET TO MUN."}

// Batch query (performance)
{"id": 3, "type": "batch", "queries": [
  {"key": "apo", "expr": "APOAPSIS"},
  {"key": "per", "expr": "PERIAPSIS"}
]}
```

**Response:**
```json
{"id": 1, "type": "result", "success": true, "value": "85234.5"}
{"id": 1, "type": "error", "message": "Undefined Variable Name"}
```

### Project Structure

```
kOS.Transport.Addon/
├── kOS.Transport.Addon.csproj
├── Addon.cs                    # [kOSAddon("TRANSPORT")]
├── TransportServer.cs          # TCP server on port 5411
├── MessageHandler.cs           # JSON message routing
├── Protocol/
│   ├── Message.cs
│   ├── Request.cs
│   └── Response.cs
└── Properties/AssemblyInfo.cs
```

### ksp-mcp Integration

New file: `src/transport/structured-transport.ts`

```typescript
class StructuredTransport {
  async eval(expr: string): Promise<string>  // Direct value, no parsing
  async exec(command: string): Promise<boolean>
  async batch(queries: {key, expr}[]): Promise<Record<string, string>>
}
```

### Implementation Phases

**Phase 1: Core Transport (MVP)**
- TCP server in C# addon
- `eval` message type
- Basic error handling
- ksp-mcp client class

**Phase 2: Command Execution**
- `exec` message type
- Capture execution results

**Phase 3: Performance**
- Batch queries
- Replace telemetry queries with structured transport

**Phase 4: Full Migration**
- Update all ksp-mcp operations to prefer structured transport
- Telnet fallback for compatibility

### Key Benefits

| Current (Telnet) | New (Structured) |
|------------------|------------------|
| Regex parsing of echoed output | Direct JSON responses |
| Sentinel markers for boundaries | Length-prefixed framing |
| Empirical WAIT delays | Request-response correlation |
| Unicode stripping | Clean text only |
| Multiple round-trips for telemetry | Batch queries in one call |

### Files to Create/Modify

**New C# Project:**
- `/Users/casey/src/kOS.Transport.Addon/` (new)

**ksp-mcp changes:**
- `src/transport/structured-transport.ts` (new)
- `src/transport/kos-connection.ts` (add structured transport option)
- `src/lib/mechjeb/telemetry.ts` (migrate to batch queries)

### Compatibility

- Telnet terminal (port 5410) remains available
- Safety monitor script works unchanged
- Operation state variables work unchanged
- Gradual migration - can use both transports during transition
