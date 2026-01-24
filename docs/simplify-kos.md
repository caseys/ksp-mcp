# Plan: Simplify kOS Scripts

## Goal
Remove all broken kOS code. Keep only ONE self-contained script: `mcp_status.ks`.

## Current State → New State

| Script | Current | New |
|--------|---------|-----|
| `mcp_daemon.ks` | Broken loop | **Remove** |
| `mcp_landing.ks` | Broken | **Remove** |
| `mcp_env.ks` | Dependency | **Remove** (inline into status) |
| `mcp_status.ks` | Works | **Keep** (make self-contained) |

## Version Tracking (Self-Validating)

The status script outputs its version in JSON: `"v": "abc123"`.

**Flow on connect:**
1. Try to run status script: `RUNPATH("1:/boot/mcp_status").`
2. Parse output, check `v` field against expected `MCP_STATUS_VERSION`
3. If mismatch OR error → deploy + copy to volume 1, then retry

This is self-validating - no separate version check needed.

## New Self-Contained mcp_status.ks

Removes all `_MCP_*` dependencies by computing values directly:

| Old (from mcp_env) | New (inline) |
|--------------------|--------------|
| `_MCP_BODIES[body]["parent"]` | `CHOOSE "Sun" IF SHIP:BODY:NAME = "Sun" ELSE SHIP:BODY:BODY:NAME` |
| `_MCP_BODIES[body]["atm"]` | `CHOOSE SHIP:BODY:ATM:HEIGHT IF SHIP:BODY:ATM:EXISTS ELSE 0` |
| `_MCP_SHIPNAME` | `SHIP:NAME` |
| `_MCP_SHIPTYPE` | `SHIP:TYPE` |
| `_MCP_TARGET` | Guarded: `IF HASTARGET { TARGET:NAME }` |
| `_MCP_TARGETTYPE` | Guarded: `IF HASTARGET { TARGET:TYPENAME }` |
| `_MCP_TARGETPARENT` | Guarded: `IF HASTARGET AND TARGET:TYPENAME = "Body" { TARGET:BODY:NAME }` |

### Edge Cases Handled
- **Sun orbit**: `SHIP:BODY:BODY:NAME` doesn't exist for Sun → explicit check
- **No target**: All `TARGET:*` access guarded by `HASTARGET`
- **No atmosphere**: `SHIP:BODY:ATM:HEIGHT` guarded by `ATM:EXISTS`

## Operation Tracking via File

The old `_MCP_OP` global variable doesn't persist across Ctrl+C. New approach: file-based.

**How it works:**
- Status script accepts optional parameter: `RUNPATH("1:/boot/mcp_status", "landing").`
- If parameter provided and non-empty, write to file: `1:/mcp/op.json`
- On every run, read operation from file (if exists)
- Include in status output: `"op": "landing"` or `"op": ""`

**File format** (`1:/mcp/op.json`):
```json
{"op": "landing", "ts": 12345.6}
```

**Setting operation** (from TypeScript):
```kerboscript
RUNPATH("1:/boot/mcp_status", "landing").   // Sets op + returns status
RUNPATH("1:/boot/mcp_status", "").          // Clears op + returns status
RUNPATH("1:/boot/mcp_status").              // Just returns status (reads existing op)
```

**Script logic:**
```kerboscript
PARAMETER _setOp IS "-".  // "-" means "don't change", "" means "clear"

// Ensure directory exists
IF NOT EXISTS("1:/mcp") { CREATEDIR("1:/mcp"). }

// Handle operation file
LOCAL _op IS "".
IF _setOp <> "-" {
  // Write new operation (empty string clears it)
  LOCAL opData IS LEXICON("op", _setOp, "ts", TIME:SECONDS).
  WRITEJSON(opData, "1:/mcp/op.json").
  SET _op TO _setOp.
} ELSE IF EXISTS("1:/mcp/op.json") {
  // Read existing operation
  LOCAL opFile IS READJSON("1:/mcp/op.json").
  SET _op TO opFile["op"].
}
SET s["op"] TO _op.
```

**Note:** Using "-" as default (don't change) vs "" (clear operation) allows explicit clearing.

## Deployment Flow

```
TypeScript                          kOS
    |                                |
    |-- RUNPATH("1:/boot/mcp_status") -->
    |                                |
    |<-- (error: file not found)     |
    |                                |
    |-- RUNPATH("0:/boot/mcp_status") -->  [fallback to archive]
    |                                |
    |<-- STATUS_COMPACT:{...,"v":"abc"} --
    |                                |
    |  [check: v matches expected?]  |
    |                                |
    |  [if mismatch or error:]       |
    |-- deploy to 0:/boot/mcp_status.ks
    |-- CREATEDIR + COPYPATH to 1:/boot/
    |-- retry RUNPATH("1:/boot/...")  |
```

**Fallback order:**
1. Try `1:/boot/mcp_status` (local volume - fast, works during blackout)
2. If fails, try `0:/boot/mcp_status` (archive - works if not deployed to local yet)
3. If fails or version mismatch, deploy to archive + copy to local + retry

## Files to Change

### Remove entirely
- `src/utils/mcp-daemon.ts`
- `src/utils/mcp-landing.ts`
- `src/utils/mcp-env.ts`
- `src/utils/kos-operation-state.ts`

### Simplify
- `src/utils/mcp-status.ts` → self-contained script (no mcp_env dependency)
- `src/utils/boot-deploy.ts` → only deploys status script
- `src/transport/connection-tools.ts` → remove daemon logic, add version-check-on-status
- `src/transport/kos-connection.ts` → remove `restartDaemon` option

### Keep as-is
- `src/utils/kos-archive.ts` → still used for archive writes

## New boot-deploy.ts API

```typescript
// Deploy status script to archive
async function deployStatusScript(conn: KosConnection): Promise<boolean>

// Copy from archive to volume 1
async function copyStatusToLocal(conn: KosConnection): Promise<boolean>

// Combined: deploy + copy (called when version mismatch)
async function ensureStatusScript(conn: KosConnection): Promise<boolean>
```

## New connection-tools.ts Flow

```typescript
// Called on connect (replaces ensureMcpDaemon)
async function ensureStatusScript(conn: KosConnection): Promise<void> {
  // Try local volume first (works during blackout)
  let result = await tryRunStatus(conn, '1:/boot/mcp_status');
  let needsCopyToLocal = false;

  if (!result.success) {
    // Fallback to archive (first run, or local not copied yet)
    result = await tryRunStatus(conn, '0:/boot/mcp_status');
    needsCopyToLocal = result.success; // If archive works, copy to local
  }

  // Parse version from output
  const version = result.success ? parseStatusVersion(result.output) : null;

  if (version !== MCP_STATUS_VERSION) {
    // Version mismatch or not found - deploy fresh
    await deployStatusScript(conn);
    needsCopyToLocal = true;
  }

  if (needsCopyToLocal) {
    // Copy to local volume for blackout resilience
    await conn.execute('IF NOT EXISTS("1:/boot") { CREATEDIR("1:/boot"). }', 3000);
    await conn.execute('COPYPATH("0:/boot/mcp_status.ks", "1:/boot/mcp_status.ks").', 3000);
  }
}

async function tryRunStatus(conn: KosConnection, path: string): Promise<{success: boolean, output: string}> {
  try {
    const result = await conn.execute(`RUNPATH("${path}").`, 5000);
    return { success: result.output.includes('STATUS_COMPACT:'), output: result.output };
  } catch {
    return { success: false, output: '' };
  }
}
```

## Benefits
- ONE kOS script (was 4)
- No daemon to manage
- No boot file needed
- Terminal always free
- Self-validating version
- Simpler deployment
- MechJeb still handles operations
