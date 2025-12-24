# Debug kOS Operations

Use these techniques when debugging kOS operations, especially those that may block or have unreliable completion detection.

## Background Testing

When testing operations that may block the main thread (like time warp), run them in background processes using Claude Code's background bash capability:

```javascript
// Run the warp test in background so main thread doesn't block
<Bash run_in_background=true>
node -e "
const { KosConnection } = require('./dist/transport/kos-connection.js');
const { warpTo } = require('./dist/mechjeb/programs/warp.js');

async function test() {
  console.log('Starting test...');
  const conn = new KosConnection();
  await conn.connect();
  const result = await warpTo(conn, 'soi', { timeout: 300000 });
  console.log('Result:', JSON.stringify(result, null, 2));
  process.exit(0);
}
test().catch(e => { console.error('Error:', e.message); process.exit(1); });
"
</Bash>
```

## Background Monitoring

Start a separate background process to monitor kOS state while tests run:

```javascript
// Monitor kOS state every 2 seconds
<Bash run_in_background=true>
node -e "
const { KosConnection } = require('./dist/transport/kos-connection.js');
async function monitor() {
  const conn = new KosConnection();
  await conn.connect();
  console.log('Monitor started...');
  setInterval(async () => {
    try {
      const result = await conn.execute('PRINT SHIP:BODY:NAME + \"|\" + WARP.', 2000);
      console.log(new Date().toISOString().substr(11,8), result.output.trim());
    } catch (e) {
      console.log('Error:', e.message);
    }
  }, 2000);
}
monitor().catch(console.error);
"
</Bash>
```

## Checking Background Output

Use TaskOutput or Read to check background process output:

```javascript
// Check test output (replace TASK_ID with actual ID)
<TaskOutput task_id="TASK_ID" block=false />

// Or read the output file directly
<Read file_path="/tmp/claude/tasks/TASK_ID.output" />
```

## Kill Stale Processes

If background processes get stuck:

```javascript
<KillShell shell_id="TASK_ID" />
```

## Common Monitoring Patterns

### Monitor Body and Warp
```kos
PRINT SHIP:BODY:NAME + "|" + WARP.
```
Output: `Kerbin|0` or `Minmus|3` (body|warp_level)

### Monitor SOI ETA
```kos
PRINT SHIP:ORBIT:NEXTPATCHETA.
```
Output: seconds until next SOI transition

### Monitor Node ETA
```kos
PRINT NEXTNODE:ETA.
```
Output: seconds until next maneuver node

### Check Encounter Status
```kos
PRINT SHIP:ORBIT:HASNEXTPATCH.
```
Output: `True` or `False`

## Debugging Workflow

1. **Start monitor in background** - Watch kOS state changes
2. **Run test in background** - So main thread stays responsive
3. **Periodically check outputs** - See what's happening
4. **Compare monitor vs test** - Identify where detection fails
5. **Kill processes when done** - Clean up

## Connection Issues

If you see "Garbled selection" errors, the connection is stuck at CPU selection menu:
1. Kill any background processes using that connection
2. Use `mcp__ksp-mcp__disconnect` to reset
3. Wait a few seconds before reconnecting

## Sentinel Pattern for Parsing kOS Output

When parsing kOS command output, the raw output includes the **command echo** (the command text itself) followed by the actual output. This can cause regex patterns to match the wrong content.

### The Problem

```kos
FOR b IN bods { PRINT "BODY|" + b:NAME. }
```

Output includes both:
1. **Command echo**: `FOR b IN bods { PRINT "BODY|" + b:NAME. }`
2. **Actual output**: `BODY|SunBODY|KerbinBODY|Mun...`

A naive regex like `/BODY\|([^|]+)/g` will match `BODY|"` from the echo!

### Solution: Use `__MARKER__` Sentinel Pattern

Use double-underscore markers that won't appear in the command echo's quoted strings:

```kos
FOR b IN bods { PRINT "__BODY__" + b:NAME + "__". }
```

- **Command echo**: `PRINT "__BODY__" + b:NAME + "__"` (has quotes around markers)
- **Actual output**: `__BODY__Sun____BODY__Kerbin__...` (no quotes)

Regex: `/__BODY__(.+?)__(?=__|$|\s)/g`

The echo has `"__BODY__"` with quotes, so the regex won't match it.

### Examples in This Project

| Pattern | Usage | Regex |
|---------|-------|-------|
| `__BODY__name__` | List bodies | `/__BODY__(.+?)__(?=__\|$\|\s)/g` |
| `__VESSEL__name__` | List vessels | `/__VESSEL__(.+?)__(?=__\|$\|\s)/g` |
| `__MCP_DONE_xxx__` | Command completion | Used by kos-connection.ts |
| `__MCP_SCRIPT_COMPLETE__` | Script completion | Used by run-script.ts |

### Alternative: Numeric Sentinel

For simple cases, append a number that the echo won't have:

```kos
PRINT "BODY|" + b:NAME + "|" + ROUND(distance).
```

Regex: `/BODY\|([^|]+)\|(\d+)/g` - requires digits after the name, which the echo lacks.

### Key Rules

1. **Always use sentinels** - Never assume your marker won't appear in the echo
2. **Prefer `__MARKER__` style** - Consistent with existing patterns in the project
3. **Use non-greedy matching** - `(.+?)` handles names with special characters
4. **Lookahead for termination** - `(?=__|$|\s)` ensures proper boundary matching

## Key Insight

When testing blocking operations, the key is to:
- **Not block the main thread** - Run tests in background
- **Have independent monitoring** - Separate process watches state
- **Check actual outcomes** - Don't just trust return values

This way you can observe what KSP/kOS is doing even when the test code gets stuck.
