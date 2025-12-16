# Handler Refactor Plan

## Goal

Move `ensureConnected()` calls from inline in `server.ts` into dedicated handler modules for cleaner separation of concerns.

## Current State

- `server.ts` has ~25+ tools calling `ensureConnected()` inline
- `handleExecute` in `connection-tools.ts` is the cleaner pattern (connection logic encapsulated)
- Inconsistent: some tools use handlers, most don't

## Target Pattern

```typescript
// server.ts - just routing
server.tool('adjust_pe', 'Change periapsis', schema, async (args) => {
  return handleAdjustPe(args);
});

// handlers/maneuver-handlers.ts - logic + connection
export async function handleAdjustPe(args) {
  const conn = await ensureConnected();
  const maneuver = new ManeuverProgram(conn);
  // ... rest of logic
}
```

## Proposed Handler Modules

| Module | Tools |
|--------|-------|
| `handlers/maneuver-handlers.ts` | adjust_pe, adjust_ap, circularize, hohmann, course_correct, change_inc, ellipticize, change_sma, change_ecc, change_lan, change_lpe, match_planes, match_velocities, resonant_orbit |
| `handlers/transfer-handlers.ts` | return_from_moon, interplanetary |
| `handlers/node-handlers.ts` | execute_node, clear_nodes |
| `handlers/ascent-handlers.ts` | launch, ascent_status, abort_ascent |
| `handlers/targeting-handlers.ts` | set_target, get_target, clear_target |
| `handlers/time-handlers.ts` | warp |
| `handlers/save-handlers.ts` | load_save, list_saves, quicksave, quickload |

## Implementation Steps

1. Create `src/handlers/` directory
2. Start with one module (e.g., `targeting-handlers.ts`) as proof of concept
3. Move handler logic, keep `ensureConnected()` inside handlers
4. Update server.ts imports and tool registrations
5. Test thoroughly
6. Repeat for remaining modules

## Benefits

- `server.ts` becomes pure routing (~50% smaller)
- Handler logic testable without MCP server
- Connection management centralized
- Consistent pattern across all tools

## Risks

- Regression bugs during migration
- More files to navigate
- Import complexity

## Priority

Low - current code works fine. Nice-to-have cleanup when time permits.
