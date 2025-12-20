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

## Key Insight

When testing blocking operations, the key is to:
- **Not block the main thread** - Run tests in background
- **Have independent monitoring** - Separate process watches state
- **Check actual outcomes** - Don't just trust return values

This way you can observe what KSP/kOS is doing even when the test code gets stuck.
