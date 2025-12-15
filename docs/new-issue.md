# Issue: getTargetInfo() Parsing Matches Command Echo

**Date**: 2025-12-15
**Status**: Resolved (2024-05-23)

## Problem

The `getTargetInfo()` method in `src/mechjeb/programs/maneuver.ts` uses regex to parse kOS output, but the regex matches text from the command echo rather than the actual output.

## Example Output

When executing the kOS command:
```kerboscript
IF HASTARGET { PRINT "TGT_NAME|" + TARGET:NAME. ... } ELSE { PRINT "TGT_NONE". }
```

The returned output includes BOTH the command echo AND the actual result:
```
IF HASTARGET {   PRINT "TGT_NAME|" + TARGET:NAME.   PRINT "TGT_TYPE|" + TARGET:TYPENAME. ...
TGT_NAME|Mun
TGT_TYPE|Body
TGT_DIST|12184.2
TGT_RAD|200
TGT_ALT|11400
```

## Current Behavior

The regex `result.output.match(/TGT_NAME\|(.+)/)` matches:
- First occurrence: `TGT_NAME|" + TARGET:NAME.   PRINT "TGT_TYPE|...` (from command echo)
- NOT the actual output: `TGT_NAME|Mun`

This causes the parsed name to be the entire rest of the command echo string.

## Root Cause

kOS telnet output includes command echo (the command you typed) followed by the actual output. The markers (`TGT_NAME|`, `TGT_TYPE|`, etc.) appear in both:
1. The command echo (surrounded by quotes as part of the PRINT statement)
2. The actual output (without quotes, as standalone lines)

## Resolution

- Updated `ManeuverProgram.getTargetInfo()` (see `src/mechjeb/programs/maneuver.ts`) to parse marker tokens sequentially inside the raw string, slicing from one `TGT_*|` marker to the next.
- Markers that appear inside the command echo always include quotes (`"TGT_NAME|"`) so the parser now explicitly ignores any marker whose preceding character is a double quote. This leaves only the real output tokens, even when kOS concatenates them without newline separators.
- Converting to the marker-to-marker slicing removed the need for `split('\n')` and ensures we can safely read values like `TGT_NAME|MunTGT_TYPE|Body...`.
- Verified manually via `mcp__ksp-mcp__get_target` that the reported name/type/distance now match the in-game values with no leftover echo text.
