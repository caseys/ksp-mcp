# ksp-mcp Project Instructions

## CRITICAL: Debugging kOS Issues

**NEVER debug kOS issues without watching the terminal log.**

Before ANY kOS debugging:
1. Ask the user to run `tail -f /tmp/kos-terminal.log` in a separate terminal
2. Or run tests with the log visible: `rm -f /tmp/kos-terminal.log && KOS_DEBUG=1 node dist/cli/index.js <cmd>`
3. The log shows actual TX/RX traffic - without it you're debugging blind

Use `/debug-kos` to see the full debugging workflow.

## Build & Test

```bash
npm run build                    # Build TypeScript
node dist/cli/index.js status    # Test CLI
```

After building, kill stale MCP servers:
```bash
pkill -f 'node.*ksp-mcp.*dist/index'
```

## kOS Script Deployment

Scripts are embedded at build time from `src/lib/kos/script/`. After modifying `.ks` files:
1. Run `npm run build`
2. Scripts deploy to kOS volume 0 (archive)
3. Volume 1 (local) may have stale copies - delete them if testing updated scripts

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `KOS_DEBUG=1` | Log TX/RX to `/tmp/kos-terminal.log` |
| `KOS_TRACE=1` | Detailed per-session trace logs |

Set in `.env` for MCP server, or prefix commands for CLI testing.

## CRITICAL: Parsing kOS Command Output with Markers

**This has caused bugs DOZENS of times. Read carefully.**

When parsing kOS command output, you need markers to reliably extract values. But markers in PRINT statements appear in BOTH:
1. The **command echo** (kOS echoes the command you sent)
2. The **actual output** (the result of executing the command)

### The Problem

```typescript
// BAD - markers appear in echo AND output
await conn.execute('PRINT "[START]". PRINT SHIP:NAME. PRINT "[END]".');
```

The RX will contain:
```
PRINT "[START]". PRINT SHIP:NAME. PRINT "[END]".   // <-- echo has [START] and [END]!
[START]
My Ship
[END]
```

If you regex for `/\[START\](.*?)\[END\]/`, it matches the ECHO first, capturing `". PRINT SHIP:NAME. PRINT "` instead of `My Ship`.

### The Solution: Concatenate Markers

```typescript
// GOOD - markers are split in the command, only complete in output
await conn.execute('PRINT "["+"START"+"]". PRINT SHIP:NAME. PRINT "["+"END"+"]".');
```

The RX will contain:
```
PRINT "["+"START"+"]". PRINT SHIP:NAME. PRINT "["+"END"+"]".   // <-- no complete markers
[START]
My Ship
[END]
```

Now the regex only matches the actual output.

### Examples from the Codebase

**Version check** (`boot-deploy.ts`):
```typescript
// Markers concatenated so they don't appear complete in echo
`PRINT "["+"VER_START"+"]". IF EXISTS("${path}") { ... } PRINT "["+"VER_END"+"]".`
```

**KSPROOT query** (`kos-archive.ts`):
```typescript
// Concatenated directly in the expression
'PRINT "["+"ROOT_START"+"]" + ADDONS:MJ:KSPROOT + "["+"ROOT_END"+"]".'
```

### Alternative Approaches (Also Valid)

1. **Count occurrences** - Match the Nth instance of a pattern
2. **Negative lookbehind for quotes** - `/(?<!")\[START\]/` skips quoted markers
3. **Unique prefixes** - Use markers unlikely to appear in commands

But **string concatenation is the simplest and most reliable**.
