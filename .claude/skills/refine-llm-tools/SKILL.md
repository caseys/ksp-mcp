---
name: refine-llm-tools
description: Refine ksp-mcp tool outputs for small LLM guidance. Use when tuning MCP tools to help ollama-tools complete multi-step missions.
---

# Refine LLM Tool Outputs

Workflow for tuning ksp-mcp MCP server outputs so small LLMs (via ollama-tools) can successfully complete multi-step missions.

## Projects

### ksp-mcp (MCP Server)
- **Location**: /Users/casey/src/ksp-mcp
- **Role**: Provides KSP automation tools via MCP protocol
- **Key files for tool outputs**:
  - `src/lib/mechjeb/transfer/*.ts` - Transfer tools (hohmann, course_correct)
  - `src/lib/mechjeb/basic/*.ts` - Basic maneuvers (circularize, adjust_*)
  - `src/lib/mechjeb/shared.ts` - Shared helpers like `formatResultingOrbit()`

### ollama-tools (MCP Client)
- **Location**: /Users/casey/src/ollama-tools
- **Role**: Connects small LLMs to MCP servers
- **Constraint**: Must stay ABSTRACT - no KSP-specific changes
- **Model**: qwen3:4b-instruct-q4_K_M (configured in .env)
- **Key files**:
  - `src/overlay/select-tool.ts` - Tool selection with consensus
  - `src/overlay/reflect.ts` - CONTINUE/DONE/ASK decisions

## Testing Workflow

1. **Load save in KSP** (use ksp-mcp):
   ```bash
   cd /Users/casey/src/ksp-mcp
   # In REPL: load_save test-on-pad
   ```

2. **Run mission test** (use ollama-tools):
   ```bash
   cd /Users/casey/src/ollama-tools
   npm run debug -- --prompt "launch to orbit, transfer to the Mun then establish a stable orbit there" 2>&1 | tee /tmp/mun-mission.log
   ```

3. **Analyze results**:
   - Watch tool selection consensus
   - Check PREVIOUS RESULTS shown to LLM
   - Verify next-step guidance in tool outputs

## Key Principles

### Tool Output Design
- Show **what was achieved**, not just node info
- Include **next-step hints** when trajectory requires action
- Use clear state indicators: "UNSAFE trajectory!", "(safe)", "(circular)"

### Example Good Output
```
Node: 847.7 m/s, T-1593s (executed)
Encounter: Mun at -199km - UNSAFE trajectory!
REQUIRED: Use course_correct to fix trajectory before doing anything else.
```

### Example After Fix
```
Node: 52.2 m/s, T-558s (executed)
Trajectory corrected! Encounter: Mun at 24km (safe)
Next: warp to Mun SOI, then circularize
```

## Common Issues

1. **LLM picks wrong tool**: Check if previous tool output gave clear guidance
2. **LLM doesn't stop**: Tool output should indicate completion state
3. **LLM crashes into surface**: Unsafe trajectory warnings need to be prominent
4. **Stale warnings persist**: PREVIOUS RESULTS accumulates - make messages contextual

## Shared Helper

Use `formatResultingOrbit()` from shared.ts to show orbit state:
```typescript
import { formatResultingOrbit } from '../shared.js';

if (result.executed) {
  text += await formatResultingOrbit(conn);
}
// Output: "\nOrbit: 30.0 × 22.0 km at Mun (circular)"
```

## Build & Test Cycle

```bash
# After changes to ksp-mcp
cd /Users/casey/src/ksp-mcp && npm run build

# Test with ollama-tools
cd /Users/casey/src/ollama-tools
npm run debug -- --prompt "your test mission"
```
