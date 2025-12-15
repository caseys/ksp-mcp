# kOS Bug Report: Cannot Programmatically Clear Target

**Affects**: kOS (tested on current develop branch)
**Severity**: Medium - No workaround exists for clearing targets from scripts
**Date**: 2025-12-15

## Summary

There is no way to programmatically clear the KSP target from a kOS script. The `TARGET` setter in `MissionSettings.cs` has code intended to clear the target when an invalid value is provided, but this code path is broken due to `VesselUtils.GetVesselByName()` throwing an exception instead of returning null.

## Expected Behavior

According to the code comment on line 57 of `MissionSettings.cs`:
```csharp
//Target not found, if we have a target we clear it
VesselUtils.UnsetTarget();
```

The developers intended that passing an invalid/empty target name would clear the current target.

## Actual Behavior

| Command | Expected | Actual |
|---------|----------|--------|
| `SET TARGET TO ""` | Clear target | HASTARGET remains True |
| `SET TARGET TO "   "` | Clear target | HASTARGET remains True |
| `SET TARGET TO "NONEXISTENT"` | Clear target | Exception: "Vessel 'NONEXISTENT' not found" |
| `SET TARGET TO SHIP` | Clear target | Exception: "A ship cannot set TARGET to itself" |
| `SET TARGET TO FALSE` | Clear target | Exception: "Vessel 'False' not found" |

## Root Cause Analysis

### File: `src/kOS/Binding/MissionSettings.cs` (lines 28-59)

```csharp
shared.BindingMgr.AddSetter("TARGET", val =>
{
    if (shared.Vessel != FlightGlobals.ActiveVessel)
    {
        throw new KOSSituationallyInvalidException("TARGET can only be set for the Active Vessel");
    }
    var targetable = val as IKOSTargetable;
    if (targetable != null)
    {
        VesselUtils.SetTarget(targetable, shared.Vessel);
        return;
    }

    if (!string.IsNullOrEmpty(val.ToString().Trim()))   // Line 41
    {
        var body = VesselUtils.GetBodyByName(val.ToString());
        if (body != null)
        {
            VesselUtils.SetTarget(body, shared.Vessel);
            return;
        }

        var vessel = VesselUtils.GetVesselByName(val.ToString(), shared.Vessel);  // Line 50 - THROWS!
        if (vessel != null)
        {
            VesselUtils.SetTarget(vessel, shared.Vessel);
            return;
        }
    }
    //Target not found, if we have a target we clear it
    VesselUtils.UnsetTarget();  // Line 58 - NEVER REACHED
});
```

### File: `src/kOS/Utilities/VesselUtils.cs` (lines 180-187)

```csharp
public static Vessel GetVesselByName(string name, Vessel origin)
{
    var vessel = TryGetVesselByName(name, origin);  // Returns null if not found

    if (vessel == null)
    {
        throw new Exception("Vessel '" + name + "' not found");  // BUG: Should return null
    }

    return vessel;
}
```

### The Bug

1. `GetBodyByName()` correctly returns `null` when a body is not found (line 177 uses `FirstOrDefault`)
2. `GetVesselByName()` **throws an exception** instead of returning `null` when a vessel is not found
3. This exception prevents execution from reaching line 58 (`VesselUtils.UnsetTarget()`)

Note: There is already a `TryGetVesselByName()` method (line 170) that correctly returns `null`, but it is `private` and not used by `MissionSettings.cs`.

### Secondary Issue

For empty strings (`SET TARGET TO ""`), the condition `!string.IsNullOrEmpty(val.ToString().Trim())` should be `false`, which should skip the lookup block and fall through to `UnsetTarget()`. However, in testing, `HASTARGET` still returns `True` after this command. This suggests either:
- `UnsetTarget()` is not being called, or
- `UnsetTarget()` is not working correctly

## Suggested Fix

**Option A**: Make `GetVesselByName` return null instead of throwing (consistent with `GetBodyByName`):

```csharp
public static Vessel GetVesselByName(string name, Vessel origin)
{
    return TryGetVesselByName(name, origin);  // Already exists, just return it
}
```

**Option B**: Use `TryGetVesselByName` in `MissionSettings.cs`:

```csharp
// In MissionSettings.cs, change line 50 from:
var vessel = VesselUtils.GetVesselByName(val.ToString(), shared.Vessel);
// To:
var vessel = VesselUtils.TryGetVesselByName(val.ToString(), shared.Vessel);
```

(This would require making `TryGetVesselByName` public)

**Option C**: Add explicit clear target support:

```csharp
// At the start of the setter, before line 34:
if (val == null || (val is StringValue sv && string.IsNullOrEmpty(sv.ToString().Trim())))
{
    VesselUtils.UnsetTarget();
    return;
}
```

## Impact

- Scripts cannot clear targets programmatically
- Automation/testing frameworks must reload saves to clear targets
- The `UNSET TARGET` command also does not work (it removes a kOS variable, not the KSP target)

## Related Issues

- GitHub Issue #863: "Unsetting target"
- GitHub Issue #35: "No way to unset target from the script"
- GitHub Issue #2499: "UNSET breaks bound variables like GEAR, TARGET, etc."

## Reproduction Steps

1. Launch KSP with kOS installed
2. Load any vessel in flight
3. Open kOS terminal and run:
   ```
   SET TARGET TO BODY("Mun").
   PRINT HASTARGET.  // True
   SET TARGET TO "".
   PRINT HASTARGET.  // Still True - bug!
   ```

## Workaround

Currently there is no workaround within kOS. The only option is to:
1. Manually click to clear target in KSP UI, or
2. Reload the save file
