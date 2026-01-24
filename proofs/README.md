# New World Architecture Proofs

These kOS scripts validate the key assumptions of the event-driven architecture.
Run them manually in KSP to verify the architecture will work before investing in full implementation.

## Test Order (by criticality)

### 1. Trigger Persistence (CRITICAL)
**If this fails, the entire architecture is invalid.**

```
RUNPATH("0:/proofs/proof1_install_trigger").
// Now run any other script or just wait
RUNPATH("0:/proofs/proof1_check_trigger").
```

Expected: Should print "PASS: Trigger persisted and fired!"

### 2. Chained RUNPATH (CRITICAL)
**If this fails, we can't chain status script after actions.**

```
RUNPATH("0:/proofs/proof2_chained_runpath").
```

Expected: Should print both "Script A executed" and "Script B executed" in order.

### 3. Ready Marker Detection (IMPORTANT)
**Tests terminal output for TypeScript parsing.**

```
RUNPATH("0:/proofs/proof3_ready_marker").
```

Expected: Should print JSON then `[MCP READY]>` on separate lines.

### 4. MOVEPATH Atomicity (IMPORTANT)
**Tests if file rename is atomic for state safety.**

```
RUNPATH("0:/proofs/proof4_movepath").
```

Expected: Should show file exists only after MOVEPATH, not during write.

### 5. Trigger Timing During WAIT (INFORMATIONAL)
**Understanding when triggers fire helps design.**

```
RUNPATH("0:/proofs/proof5_trigger_timing").
```

Expected: Shows when triggers fire relative to WAIT statements.

## Deployment

Copy the `proofs/` folder to your KSP archive:
```bash
cp -r proofs/*.ks "/path/to/KSP/Ships/Script/proofs/"
```

Or use the MCP command tool to deploy them.
