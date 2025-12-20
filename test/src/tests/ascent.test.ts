/**
 * E2E test for ascent guidance
 *
 * Tests that MechJeb can launch a vessel to orbit using ascent guidance.
 * This test uses the launchpad save and requires more time.
 *
 * Test modes:
 * - Quick mode (default): Passes when ship leaves the launchpad
 * - Full mode (FULL_TEST=true): Waits for stable orbit to be achieved
 */

import { ensureKspReady, getAscentProgram, recordTestSuccess, SAVES, TIMEOUTS } from '../helpers/test-setup.js';

// Check for full test mode
const runFullTests = process.env.FULL_TEST === 'true';

describe('ASCENT', () => {
  beforeAll(async () => {
    // Use launchpad save for ascent tests
    // MUST use forceReload - always reload save, because vessel state changes from pad to orbit
    await ensureKspReady(SAVES.LAUNCHPAD, { forceReload: true });
  }, TIMEOUTS.KSP_STARTUP);

  describe('quick mode - liftoff only', () => {
    it('launches off the pad', async () => {
      const ascent = await getAscentProgram();

      const handle = await ascent.launchToOrbit({
        altitude: 100000,
        inclination: 0
      });

      expect(handle).toBeDefined();
      expect(handle.targetAltitude).toBe(100000);

      // Quick mode: just verify liftoff (altitude > 100m or phase changes)
      const result = await handle.waitForLiftoff();

      expect(result.success).toBe(true);

      // Record 'ascent-liftoff' (not 'ascent') - maneuver tests won't chain
      // because vessel is mid-ascent, not in stable orbit
      recordTestSuccess('ascent-liftoff');
    }, TIMEOUTS.LAUNCH_LIFTOFF);
  });

  // Full mode: skip by default, enable with FULL_TEST=true
  (runFullTests ? describe : describe.skip)('full mode - orbit achieved', () => {
    it('reaches stable orbit', async () => {
      const ascent = await getAscentProgram();

      const handle = await ascent.launchToOrbit({
        altitude: 100000,
        inclination: 0
      });

      expect(handle).toBeDefined();
      expect(handle.targetAltitude).toBe(100000);

      // Full mode: wait for orbit (periapsis > atmosphere + 10km)
      const result = await handle.waitForCompletion();

      expect(result.success).toBe(true);

      // Record success - allows circularize to chain without reload
      recordTestSuccess('ascent');
    }, TIMEOUTS.BURN_EXECUTION);
  });
});
