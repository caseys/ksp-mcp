# Tier 1 Tools: Validation & Messaging Report

This document describes the input validation, initial state validation, result validation, and result messaging patterns for all tier 1 tools in ksp-mcp.

## Overview

Tier 1 tools are the primary user-facing operations for mission-critical tasks. They require robust validation to prevent dangerous states and provide clear guidance.

| Tool | File | Purpose |
|------|------|---------|
| status | `telemetry.ts` | Get ship info, position, targets |
| warp | `kos/warp.ts` | Fast-forward time to events |
| launch | `ascent.ts` | Launch from pad to orbit |
| land | `landing/autopilot.ts` | Land on surface from orbit |
| circularize | `basic/circularize.ts` | Circularize orbit |
| transfer | `meta/transfer.ts` | Smart transfer routing |
| adjust_orbit | `meta/adjust-orbit.ts` | Change orbit altitude |
| inclination | `meta/inclination.ts` | Change orbital plane |
| course_correct | `transfer/course-correct.ts` | Fine-tune approach trajectory |

---

## 1. status

**File:** `src/lib/mechjeb/telemetry.ts`

### Input Validation
- None - no input parameters

### Initial State Validation
- None - read-only telemetry tool

### Result Validation
- Checks connection status
- Includes active operation progress if any MechJeb autopilot is running

### Result Messaging
- Structured telemetry with formatted output
- Shows SOI, orbit, maneuvers, encounters, targets
- Includes available targets section

---

## 2. warp

**File:** `src/lib/kos/warp.ts`

### Input Validation
- `target`: Enum validation (`node`, `soi`, `periapsis`, `apoapsis`, `auto`) or number/string
- `leadTime`: Numeric with default 10s

### Initial State Validation
- **Auto-detect target**: If 'auto', prioritizes node > SOI > error
- **Already at target**: Checks if current body matches target name
- **Crash trajectory check** (critical):
  - `willCrashCurrentSOI`: periapsis < 0 AND we reach it before target
  - `willCrashInEncounter`: encounter periapsis < 0 for SOI transitions
- **Trajectory info query**: Gets node ETA, SOI body, closest approach

### Result Validation
- SOI status check with periapsis validation
- Polls outcome (body change, ETA) rather than WARP=0 for reliability

### Result Messaging
- Returns body/altitude on success
- Includes crash warnings: `"⚠️ CRASH TRAJECTORY: Periapsis Xkm below surface! Use crash_avoidance tool to escape."`
- Provides helpful suggestions when no target found

---

## 3. launch

**File:** `src/lib/mechjeb/ascent.ts`

### Input Validation
- **altitude**: `distanceSchema` parsing with body constraint validation
  - Rejects altitudes below `atmosphereHeight * 1.15`
  - Shows atmosphere height, minimum safe altitude, recommended altitude
- **inclination**: Numeric with default 0
- **target**: String for smart launch parameter resolution

### Initial State Validation
- **LAUNCH_REQUIREMENTS**: Must be `prelaunch` or `landed`
- **User altitude validation**: Catches dangerous low values before smart params override
- **Smart launch parameter resolution** (if target set):
  - Vessel in same SOI: rendezvous or plane mode based on relative inclination
  - Moon in same SOI: plane matching if significant inclination
  - Planet: interplanetary with transfer window warp
  - Target in different SOI: redirects to parent body

### Result Validation
- **Orbit quality tiers**:
  - `survivable`: periapsis >= atmosphereHeight
  - `successful`: periapsis >= 95% of target
  - `goodOrbit`: successful AND eccentricity < 0.01
- **Auto-fix**: If survivable but not successful, runs changeEccentricity(0) to circularize

### Result Messaging
- Comprehensive with body name, orbit details (Ap/Pe/Inc/Ecc/Period)
- Target-specific completion info (plane match offset, rendezvous distance)
- Next step guidance based on orbit quality and target presence

---

## 4. land

**File:** `src/lib/mechjeb/landing/autopilot.ts`

### Input Validation
- **target**: `parseTarget` fuzzy matching, supports presets like "KSC"
- **latitude/longitude**: Bounds validation (-90 to 90, -180 to 180)
- **touchdownSpeed**: 0-10 m/s range
- **deployGears/deployChutes/useRCS**: Boolean flags

### Initial State Validation
- **Status check**: Must be FLYING, ORBITING, ESCAPING, or SUB_ORBITAL
  - Special error messages for LANDED, PRELAUNCH, DOCKED states
- **Hyperbolic orbit handling**:
  - Safe periapsis (>15km): circularize first
  - Low periapsis: warn and proceed with direct landing
- **Impact trajectory**: Warning but proceed
- **Orbit height check**: Lowers orbit if too high for efficient landing
- **Radio contact**: Warp to contact if in blackout
- **Vessel structure scan**:
  - Checks for landing legs (ModuleLandingLeg, ModuleWheelDeployment)
  - Identifies jettison stage (decouplers below landing legs)
  - Blocks if no landing legs found
- **TWR check**: Limits thrust if > 15 TWR to prevent "floating up"

### Result Validation
- **monitorLanding**: Polls until touchdown or abort
- Requires multiple consecutive "disabled" readings before declaring abort
- Post-landing radio contact check

### Result Messaging
- Landing complete with location details (body, elevation)
- Specific error messages for abort scenarios

---

## 5. circularize

**File:** `src/lib/mechjeb/basic/circularize.ts`

### Input Validation
- **timeRef**: Enum (`APOAPSIS`, `PERIAPSIS`, `X_FROM_NOW`, `auto`)

### Initial State Validation
- **ORBITAL_REQUIREMENTS**: Must not be on ground
- **Already circular check**:
  - `ecc < 0.02` OR (`ecc < 0.1` AND altitude ratio within 15%)
- **Auto-detect timeRef**:
  - Hyperbolic (ecc >= 1): use PERIAPSIS
  - Elliptical: use nearest apse
- **Hyperbolic high-Pe handling**: If Pe > 2500km, lowers to 250km first

### Result Validation
- Post-burn orbit check for circularity
- Uses same formula as initial check

### Result Messaging
- Shows resulting orbit with formatResultingOrbit()
- Includes explicit "Orbit is circular - no further circularization needed" when done

---

## 6. transfer

**File:** `src/lib/mechjeb/meta/transfer.ts`

### Input Validation
- **target**: `autoTargetSchema` with fuzzy matching

### Initial State Validation
- **ORBITING_ONLY_REQUIREMENTS**: Must be orbiting
- **Auto-select target**: Uses `second-closest` if 'auto'
- **Already at target SOI**: Returns success with orbit info
- **Hyperbolic orbit check**: Returns error with guidance to circularize first
- **Transfer type routing** (`determineTransferType`):
  - Planet at moon targeting parent → `return_from_moon`
  - Planet from moon to different planet → error with guidance
  - Planet targeting current SOI → error
  - Planet → `interplanetary`
  - Moon in SOI → `hohmann`
  - Moon not in SOI → error
  - Vessel in SOI → `hohmann`
  - Vessel not in SOI → error

### Result Validation
- Post-burn wait (1.5s) for physics to settle
- **Encounter quality assessment** (atmosphere-aware):
  - `minSafePe = atmHeight + 40km` (or 40km for airless)
  - `optimalMaxPe = minSafePe + 50km`
  - UNSAFE: < minSafePe
  - optimal: <= optimalMaxPe
  - acceptable: <= 500km
  - far: > 500km

### Result Messaging
- Shows transfer type used
- Encounter info with periapsis and quality assessment
- Atmosphere-aware guidance:
  - UNSAFE: "REQUIRED: Use course_correct to raise periapsis"
  - optimal: "Next: Execute transfer, warp to SOI, then circularize"
  - acceptable/far: "Next: Use course_correct to tighten approach"

---

## 7. adjust_orbit

**File:** `src/lib/mechjeb/meta/adjust-orbit.ts`

### Input Validation
- **altitude**: `distanceSchema` - single value or [low, high] array
- Automatically assigns lower to Pe, higher to Ap

### Initial State Validation
- **Radio contact**: Ensures communication before planning
- **ORBITAL_REQUIREMENTS**: Must not be on ground
- **Hyperbolic trajectory**: Special two-burn handling (Pe + capture)
- **Crash trajectory** (Pe < 0 or Pe < atmHeight): Emergency recovery mode
- **Body atmosphere query**: Gets atmHeight for min safe altitude
- **Target altitude validation**: Rejects below-surface or below-atmosphere targets
- **Already at target**: Returns early if within 100m tolerance

### Result Validation
- **checkPostBurnPeriapsis**: For lowering Pe, checks if result would crash
- Clears nodes and returns error if crash trajectory would result

### Result Messaging
- Action-specific descriptions:
  - "Orbit circularized"
  - "Orbit raised/lowered successfully"
  - "Crash avoided, orbit established"
- Shows final Pe/Ap and total Δv with burn breakdown

---

## 8. inclination

**File:** `src/lib/mechjeb/meta/inclination.ts`

### Input Validation
- **target**: `autoTargetSchema`
- **angle**: Number or 'auto' (defaults to 0° if no target)

### Initial State Validation
- **Already matched check**: Within 0.5° tolerance
- **Mode determination** (`determineInclinationMode`):
  1. Target explicitly specified → `match_planes`
  2. Angle explicitly specified → `change_inclination`
  3. Target already set (HASTARGET) → `match_planes`
  4. Default → `change_inclination` to 0°

### Result Validation
- Post-burn inclination query
- Compares to target inclination

### Result Messaging
- Shows mode used (match planes vs change inclination)
- Includes target angle for change_inclination
- Shows final inclination vs target for match_planes

---

## 9. course_correct

**File:** `src/lib/mechjeb/transfer/course-correct.ts`

### Input Validation
- **target**: `parseTarget` fuzzy matching
- **targetDistance**: `distanceSchema` with range validation (10km-2500km)
  - Below 10km: error with landing guidance
  - Above 2500km: clamped down with info log

### Initial State Validation
- **ORBITAL_REQUIREMENTS**: Must not be on ground
- **Target context validation** (critical):
  - Body targets (planet/moon): Must NOT be current SOI (we're transferring TO it)
  - Vessel targets: Must be IN current SOI
- **No target check**: Error with guidance to use set_target and hohmann_transfer
- **No encounter check**:
  - Pending node with encounter → "Execute existing node first"
  - Closest approach analysis
  - No approach → "Use hohmann_transfer first"
- **Detour scenario handling**: Intermediate body between us and target
  - Crash trajectory at intermediate → error requiring fix first
  - Safe flyby en route → proceed normally
  - Blocking encounter → suggest completing flyby first

### Result Validation
- **0 m/s node rejection**: Removes node, returns error
- **Node after SOI transition rejection**: Checks if timeToNode > timeToSOI
- **Post-burn periapsis verification**: Uses queryActualPeriapsis with retries
- **Iterative refinement** (secant method):
  - 25% tolerance for success
  - Max 3 burns
  - History-based input adjustment

### Result Messaging
- Shows burns count, target vs achieved periapsis
- Includes encounter info with target body
- Next step guidance: "warp to SOI, then circularize"
- Partial correction handling for max burns reached

---

## Validation Utilities

### Shared Functions

| Function | File | Purpose |
|----------|------|---------|
| `validateVesselState` | `kos/vessel/validate.ts` | Checks vessel status, body type, encounters |
| `validateTarget` | `kos/target/validate.ts` | Checks target class, SOI proximity |
| `queryTargetEncounterInfo` | `mechjeb/shared.ts` | Gets encounter details (Pe, time, atmo) |
| `checkPostBurnPeriapsis` | `mechjeb/shared.ts` | Checks if planned burn would crash |
| `parseDistance` | `tool-types.ts` | Converts "50km", "100m" to meters |
| `parseTarget` | `tool-types.ts` | Fuzzy matches target names |

### Preset Requirements

```typescript
ORBITAL_REQUIREMENTS        // forbids prelaunch, landed, splashed
ORBITING_ONLY_REQUIREMENTS  // requires 'orbiting' status only
STABLE_ORBIT_REQUIREMENTS   // forbids escape & ground-based
LAUNCH_REQUIREMENTS         // allows prelaunch, landed
CLEAN_ORBIT_REQUIREMENTS    // forbids encounters
```

### Error Message Quality

Validation errors provide actionable guidance:

```
"Target altitude 10km is too low for Kerbin!
Atmosphere height: 70km
Minimum safe altitude: 80km (15% above atmosphere)
Recommended: Use altitude:'auto' for 105km (50% above atmosphere)"
```

```
"Cannot warp to node - will CRASH in Mun!
Node is after SOI transition (T-2h 30min)
Mun periapsis: -5.3 km
Use course_correct to fix trajectory first."
```

---

## Identified Gaps

### Missing Validation

1. **circularize**: No radio contact check before planning
2. **inclination**: No vessel state validation (assumes already orbiting)
3. **status**: No validation needed but could benefit from connection health check

### Inconsistent Patterns

1. **Radio contact**: Only `adjust_orbit` and `land` check radio contact before planning
2. **Auto-target selection**: Different strategies used:
   - `transfer`: `second-closest`
   - `course_correct`: `second-closest`
   - `inclination`: existing target or default to equatorial
3. **Already-at-target checks**: Implemented in transfer/course_correct but not in others

### Potential Improvements

1. **Standardize radio contact checks** for all maneuver-planning tools
2. **Add vessel state validation** to inclination tool
3. **Unify already-at-target check pattern** across all transfer-related tools
4. **Add timeout validation** for long-running operations
