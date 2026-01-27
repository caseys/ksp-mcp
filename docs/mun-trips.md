# Mun Landing Campaign Notes

## Mission Goal
Land multiple ships on the Mun near the 'land-here' target vessel.

---

## Mission 1

### Result: CRASH

### Timeline
1. **Launch**: 85km orbit - clean
2. **Transfer**: Impact trajectory (-158km Pe) - RCS fine-tune didn't work (error stayed at -198km through 15 bursts)
3. **Course Correct**: 3 burns to get 94km Pe
   - RCS bursts ineffective (-36km error stayed constant)
   - Engine bursts worked (82km → 4km error reduction)
4. **Warp to SOI**: Clean
5. **Target**: Set 'land-here'
6. **Landing**:
   - Lowered orbit from 94km to 50km (2 burns)
   - Plane change executed (10 m/s → 2 m/s)
   - Deorbit and braking clean
   - Final descent at 24m, 9 m/s descent rate
   - **CRASHED** - tool showed "LANDED" prediction but ship was destroyed
   - Likely cause: descent rate too high (9 m/s) or touchdown detection failed

### Issues Discovered

1. **CRITICAL: `np:STARTTIME` kOS error** - Fixed during mission
   - `OrbitInfo` doesn't have `STARTTIME` suffix
   - Changed to `SHIP:ORBIT:NEXTPATCHETA` in shared.ts

2. **RCS fine-tune bursts ineffective**
   - Error stays constant through all 15 RCS bursts
   - Engine bursts DO work (error decreases each burst)
   - Root cause: RCS may not be actually firing or direction is wrong

3. **Transfer always produces impact trajectory**
   - Hohmann transfer to Mun consistently results in -150km to -200km periapsis
   - Requires course_correct to fix every time
   - Fine-tune phase runs but doesn't improve (see #2)

4. **CRITICAL: Final descent crash**
   - Ship crashed despite tool showing 24m altitude, 9 m/s descent
   - MechJeb prediction showed "LANDED" but vessel was destroyed
   - 9 m/s is too fast for safe touchdown (should be < 5 m/s)
   - Need to investigate why MechJeb didn't slow descent properly

---

## Mission 2

### Launch Phase
