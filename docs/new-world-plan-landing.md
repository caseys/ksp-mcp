# New World Landing Autopilot Migration Plan

## Goals
- Keep the `land` tool feature-complete while honoring the ready-marker protocol.
- Keep the terminal available by avoiding long, blocking kOS commands unless explicitly marked as long actions.
- Preserve blackout resilience with local (volume 1) scripts and trigger-driven stabilization.

## Command Handling Rules
- Every `execute()` must end with `RUNPATH("1:/mcp/status").` so `[MCP READY]>` is always emitted.
- No ad-hoc `UNTIL` loops in inline commands; long waits move to TypeScript polling or explicit action scripts.
- Blackout-only behavior runs in local `act_*` scripts and must exit on radio return.

## Command Inventory and Migration Plan

### 1) Vessel Status + Orbit Safety
- **Validate vessel status** (`PRINT SHIP:STATUS.` in `autopilot.ts`)
  - Keep inline; short query with ready marker.
- **Vessel state snapshot** (`getVesselStateInfo` → `PRINT "STATE|..."`)
  - Keep inline; single atomic query.
- **High-altitude reentry probe** (`PRINT "REENTRY|" + atm + ...`)
  - Keep inline; single query.
- **Periapsis check** (`PRINT "PE|" + ROUND(PERIAPSIS).`)
  - Keep inline; single query.
- **Deorbit burn** (current `deorbitScript` with `WAIT UNTIL` loops)
  - Replace with a TypeScript-driven burn loop:
    - Step 1: short command to lock retrograde, verify alignment.
    - Step 2: repeated short commands to throttle and poll periapsis until target reached.
    - Step 3: stop throttle and unlock controls.
  - Avoid a single long-running kOS script so the marker returns quickly.

### 2) Orbit Adjustment + Warp Cleanup
- **Orbit lowering cleanup** (`SET WARP TO 0. UNLOCK STEERING... WAIT 0.5.`)
  - Keep inline; short control reset.
- **Warp-to-contact** (`warpToRadioContact` in `utils/radio-contact.ts`)
  - Keep TS polling model; each warp/poll command must be short and followed by status.
- **Warp-forward** (`warpForward` in `lib/kos/warp.ts`)
  - Keep TS polling model; already uses short poll cycles (`PRINT WARP.`).

### 3) Target Resolution + Validation
- **MechJeb position target probe** (`SET TGT ... POSITIONTARGETEXISTS`)
  - Keep inline; single query.
- **Target body check** (`PRINT SHIP:BODY:NAME.`)
  - Keep inline; cache result when possible to avoid duplicates.
- **Target vessel lookup** (`VESSEL(...)` script with `PRINT OK|...`)
  - Keep inline; single query.
- **Target from existing vessel/target** (`getValidLandingTarget` multi-step queries)
  - Keep inline; keep as-is but ensure each step ends with status.
- **Set landing target** (`TGT:SETTARGET`, `TGT:SETTARGETKSC`)
  - Keep inline; short call.
- **Check target exists** (`TGT:POSITIONTARGETEXISTS`)
  - Keep inline; short query.
- **Landing site auto-find** (`findLandingSite` search loop)
  - Convert to `act_find_site.ks` (local short action) or keep inline with explicit “long action” timeout.
  - No concurrent commands while running; always ends with status + ready marker.

### 4) Landing Config + Control
- **Landing config read** (`getLandingConfig` → `PRINT "LCFG|"...`)
  - Keep inline; single query.
- **Landing config write** (`setLandingConfig` sequence)
  - Keep inline; short series of `SET LAND:` statements in one command.
- **Start landing** (`LAND:LANDATPOSITIONTARGET`, `LAND:LANDUNTARGETED`)
  - Keep inline; short call.

### 5) Vessel Scan + Separation
- **Vessel scan** (`scanVesselForLanding` heavy script)
  - Convert to `act_scan_vessel.ks` to reduce command length, but keep it short-lived.
- **Jettison stage** (`jettisonStage` with `STAGE` + `WAIT 0.5` loop)
  - Convert to `act_jettison.ks` with bounded loop; returns immediately after firing.
- **Pre-jettison warp stop** (`SET WARP TO 0.`)
  - Keep inline; short control reset.

### 6) Thrust Limit + Post-Landing Reset
- **TWR calculation** (`PRINT "TWR|"...`)
  - Keep inline; short query.
- **Apply thrust limits** (loop over engines)
  - Convert to `act_limit_thrust.ks` for readability; must be short-lived.
- **Reset thrust limits** (`RESET` script)
  - Keep inline or share same `act_limit_thrust.ks` with 100% target.

### 7) Landing Monitoring (Poll Loop)
- **Landing status polling** (`getLandingStatus` → `PRINT "LSTAT|"...`)
  - Keep inline; short query.
- **Ground check** (`PRINT SHIP:STATUS.`)
  - Keep inline; short query.
- **Autopilot pause/resume** (`LAND:ENABLED` toggles with small `WAIT`)
  - Keep inline; keep waits ≤ 2s.
- **Warp-to-periapsis wait** (`WAIT UNTIL ETA:PERIAPSIS < 620`)
  - Replace with TS polling: `PRINT ETA:PERIAPSIS` + `SET WARP TO 0` when threshold met.
- **Warp mode adjustments** (`SET WARPMODE TO "PHYSICS"`, `SET WARP TO n`, `SET WARPMODE TO "RAILS"`)
  - Keep inline; short control updates.
- **Vertical speed spot checks** (`PRINT ROUND(-SHIP:VERTICALSPEED, 1).`)
  - Keep inline; short query.

### 8) Operation State + Status Reporting
- **Operation tracking** (`setKosOperation`, `clearKosOperation`)
  - Replace `_MCP_OP` writes with state JSON updates in `1:/mcp/state.json`.
  - Keep as short commands via `mcp_status` contract.
- **Post-landing site details** (`PRINT SHIP:BODY:NAME + "|" + SHIP:GEOPOSITION:TERRAINHEIGHT.`)
  - Keep inline; short query.

### 9) Blackout Resilience
- **Touchdown stabilization**
  - Move to `act_stabilize.ks` triggered by `SHIP:STATUS = LANDED/SPLASHED`.
- **Stall recovery**
  - Optional `act_landing_watch.ks` that runs only during blackout and exits on radio return.

## Implementation Steps (Landing Only)
1. Replace long blocking `WAIT UNTIL` sequences with TS polling loops.
2. Move heavy inline scripts to `act_*` scripts (scan, jettison, thrust limit) to keep commands short.
3. Update `setKosOperation` usage to state JSON and remove daemon restart calls.
4. Add trigger-driven `act_stabilize` and optional blackout watch script.
5. Ensure every landing-related command ends with status + `[MCP READY]>`.
