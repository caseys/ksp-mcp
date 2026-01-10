# MCP Client Improvement Notes

Observations from Mun landing mission (2026-01-05).

## Issues Observed

### 1. Command Echo Leakage in Output Parsing

Monitor output shows raw kOS command text mixed with actual output:

```
07:24:07 ETA|462|~|0|~|False[MCP.8.F65C4D57]PRINT SHIP:BODY:NAME + "|" + SHIP:STATUS...
```

The command echo (`PRINT SHIP:BODY:NAME + "|"...`) appears in the output, which can confuse regex parsing. The sentinel pattern (`[MCP.X.HASH]`) helps but doesn't fully isolate command echo from output.

**Recommendation**: Use `__MARKER__` sentinel pattern consistently to distinguish command echo from actual output. See debug-kos skill for pattern details.

### 2. Status Output Garbling

Occasionally status shows garbled data mixing command text with values:

```
Tool: " + TIME:SECONDS.PRINT ""
```

This happens when output parsing doesn't properly handle command echo boundaries.

**Recommendation**: Add stricter output parsing that discards anything before the sentinel marker.

### 3. Duplicate Targets in List

`get_targets` output shows duplicates:

```
MOON|Mun|11655922
MOON|Minmus|47406231
...
```

While not shown in this session's output, previous runs showed the same body appearing multiple times.

**Recommendation**: Deduplicate target list by name before returning.

### 4. Warp Output Empty Body Name

Warp status sometimes shows empty body name:

```
Warping to  SOI...
```

The body name field is empty when it should show target body.

**Recommendation**: Check warp status parsing for empty body name handling.

### 5. Target Parent Type Incorrect

When targeting Mun, the type showed "Planet" instead of indicating it's a moon of Kerbin:

```
Target: Mun (Planet)
```

Should show: `Target: Mun (moon of Kerbin)` or similar.

**Recommendation**: Query `TARGET:BODY:BODY:NAME` to detect if target is a moon and show parent body.

### 6. Telemetry Failures on Startup

Status shows "kOS Not Accessible - Telemetry error: failed to query ship data" on first invocation after game load.

The error occurs when both orbit and vessel queries fail - likely a race condition with kOS initialization.

**Recommendation**: Add retry logic with backoff for initial telemetry queries, or return partial status when some queries succeed.

### 7. Default Args Preferred

When launching with `altitude: 80000`, the orbit was too low for optimal burn accuracy. Default args (which auto-select based on atmosphere) produce better results.

**Recommendation**: Tool descriptions should emphasize that `auto` defaults are usually preferred over manual specification. LLMs tend to over-specify parameters.

### 8. TIMETOIMPACT Type Error (Fixed)

MechJeb's `TIMETOIMPACT` returns "N/A" string when no impact trajectory, causing `ROUND()` to fail.

**Fixed**: Added type check `_tti:TYPENAME = "Scalar"` before rounding.

## Mission Results

Successfully completed full mission:
- Launch to 80km orbit (lower than ideal but worked)
- Hohmann transfer to Mun
- Course correction to 50km periapsis
- Circularize at Mun (~75km orbit)
- Land on Mun surface
- Final delta-v remaining: 890 m/s

All MCP tools functioned correctly. The issues above are UX improvements, not blockers.
