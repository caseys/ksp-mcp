# Tech Debt: Radio-Finding Algorithm Duplication

## Problem

The "find next radio contact window" algorithm is implemented in **3 separate places** with slight differences. This happened during a single session when context was lost between edits.

## Current Implementations

| Location | Purpose | Context |
|----------|---------|---------|
| `src/utils/radio-contact.ts` | TypeScript utility | Called while connected |
| `src/utils/mcp-daemon.ts` | Daemon WHEN trigger | Runs autonomously on vessel |
| `src/lib/mechjeb/execute-node.ts` | Blackout script | Self-contained, runs through blackout |

## Differences

| Feature | radio-contact.ts | mcp-daemon.ts | execute-node.ts |
|---------|------------------|---------------|-----------------|
| Tidal lock detection | Yes | No | No |
| Step size | Dynamic `MAX(30, max_dt/60)` | Dynamic `MAX(30, max_dt/60)` | Fixed `60` |
| Landed vessel handling | Yes (`sb:ROTATIONPERIOD`) | Yes (`sb:ROTATIONPERIOD`) | No (only `SHIP:ORBIT:PERIOD`) |
| Start offset | `dt = step` | `dt = step` | `dt = 60` |

## Why This Matters

- **Maintenance burden**: Bug fixes must be applied to 3 places
- **Drift risk**: Updates to one implementation don't propagate to others
- **Inconsistent behavior**: Different edge case handling across contexts

## Proposed Fix

Create a shared TypeScript function that generates the kOS snippet:

```typescript
// src/utils/radio-search-script.ts

export interface RadioSearchOptions {
  includeTidalCheck?: boolean;  // For landed scenarios
  dynamicStep?: boolean;        // true = MAX(30, period/60), false = 60
  handleLanded?: boolean;       // Use body rotation period for landed
}

export function generateRadioSearchScript(options: RadioSearchOptions = {}): string {
  const {
    includeTidalCheck = false,
    dynamicStep = true,
    handleLanded = true,
  } = options;

  // Return kOS script string with appropriate logic
}
```

Then update each consumer:

```typescript
// radio-contact.ts
const script = generateRadioSearchScript({ includeTidalCheck: true });

// mcp-daemon.ts
const script = generateRadioSearchScript({ includeTidalCheck: false });

// execute-node.ts (orbital only, so simpler is fine)
const script = generateRadioSearchScript({ handleLanded: false });
```

## Files to Modify

1. Create `src/utils/radio-search-script.ts` - shared generator
2. Update `src/utils/radio-contact.ts` - use shared generator
3. Update `src/utils/mcp-daemon.ts` - use shared generator
4. Update `src/lib/mechjeb/execute-node.ts` - use shared generator

## Priority

Low - current implementations work. Fix when:
- A bug is found in the algorithm
- Adding new radio-related features
- Doing general cleanup

## Date Identified

2026-01-14

---

# Additional Tech Debt: False "No Power" Detection

## Problem

The health check in `connection-tools.ts` (`checkConnectionHealth`) sometimes reports "no power" when the vessel is fully accessible.

## Observed

- Vessel 100% accessible in kOS terminal
- `status` tool returns: "Vessel appears to have no power"
- Happens after daemon initialization

## Location

`src/transport/connection-tools.ts` - `checkConnectionHealth()` function (around line 251)

## Likely Cause

The health check sends `PRINT "HEALTH_OK".` and looks for the response. If the daemon's `WAIT UNTIL FALSE` or other blocking operation interferes with terminal output parsing, it may falsely report no response.

## Priority

Medium - causes confusing errors when vessel is actually fine.

## Date Identified

2026-01-14
