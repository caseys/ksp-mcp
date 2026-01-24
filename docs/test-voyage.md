# Test Voyage: Tool Evaluation for Small LLM Usability

**Date**: 2026-01-24
**Objective**: Evaluate ksp-mcp tools for small LLM usability

---

## Summary

- **Mission**: test-on-pad → orbit → Mun transfer
- **Issues Found**: 3 major, 2 minor
- **Fixes Applied**: Smart RCS alignment control

---

## Issues Found

### MAJOR: Stale Volume 1 Scripts (CRITICAL)

**Problem**: When scripts are updated, volume 1 often has stale copies that are used instead of the new version.

**Symptoms**:
- Syntax errors in scripts that should work
- Old behavior after code updates
- Truncated scripts causing parse errors

**Root Cause**: `ensureAlignScript()` checks if file EXISTS on volume 1 but not its VERSION. Old copies are used without checking hash.

**Fix Needed**: Check version hash before using local copy, or always re-deploy.

### MAJOR: Alignment Timeout on Low-Torque Vessels

**Problem**: Vessels with poor reaction wheel torque get stuck during alignment, causing 5+ minute timeouts.

**Symptoms**:
- "Aligning to burn vector (X°)..." hangs for minutes
- Node ETA passes before alignment completes
- Missed burns

**Fix Applied**: Smart RCS control with:
- Adaptive thrust limiting based on angular velocity
- Stuck detection with automatic restart
- Up to 3 alignment attempts

### MAJOR: TRANSLATIONRCS Suffix Doesn't Exist

**Problem**: `SHIP:CONTROL:TRANSLATIONRCS` is not a valid kOS suffix.

**Fix**: Removed from script (feature not available in kOS).

### MINOR: Load Save Message Unclear

**Message**: `Connection reset - reconnect to continue.`

**Issue**: Small LLM might not know the connection auto-recovers on next command.

**Suggestion**: Change to: `Save loaded. Ready for next command.`

### MINOR: Burn Time Shows "mark."

**Output**: `Est. burn time: mark.`

**Issue**: Confusing output when burn time calculation fails.

**Suggestion**: Show "unknown" or omit line.

---

## Tool Timing Log

| Time | Tool | Duration | Result |
|------|------|----------|--------|
| 12:17:25 | load_save test-on-pad | 2s | Success |
| 12:17:34 | status | 5s | Success |
| 12:17:47 | launch --target Minmus | 10min | TIMEOUT (plane warp stuck) |
| 12:30:19 | launch (no target) | 5min | TIMEOUT (ascent incomplete) |
| 12:35:26 | clear-target | 10s | Success |
| 12:35:41 | launch | 5min | Partial (suborbital) |
| 12:41:35 | circularize | 5min | TIMEOUT (alignment stuck) |
| 13:26:25 | transfer Mun | 5min | TIMEOUT (alignment stuck) |
| 13:35:55 | execute | 2min | SUCCESS (aligned 0.10°) |

---

## Smart RCS Alignment Script

**New Features**:
1. **Adaptive RCS thrust** based on angular velocity:
   - > 0.1 rad/s → 25% thrust (prevent overshoot)
   - > 0.05 rad/s → 50% thrust
   - < 0.01 rad/s with large error → 100% thrust (unstick)
   - Normal → 75% thrust

2. **Stuck detection**: If angle doesn't change and angular velocity is low for 2+ seconds, restart alignment.

3. **Automatic restart**: Up to 3 attempts with full re-initialization.

4. **RCS modes** (ascending aggressiveness):
   - 0 = no RCS
   - 1 = burst at start/end
   - 2 = pulsed + adaptive
   - 3 = continuous + adaptive

---

## Recommendations for Small LLM Guidance

1. **Always check status** after load_save before proceeding
2. **Clear target** if launch gets stuck on plane matching
3. **Use longer timeouts** for maneuvers (5+ minutes)
4. **Check for stale scripts** if unexpected errors occur
5. **Retry execute** if alignment fails (script has auto-retry)
