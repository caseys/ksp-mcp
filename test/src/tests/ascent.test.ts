/**
 * E2E test for ascent guidance
 *
 * Tests that MechJeb can launch a vessel to orbit using ascent guidance.
 * This test uses the launchpad save and requires more time.
 */

import { ensureKspReady, getAscentProgram, recordTestSuccess, SAVES, TIMEOUTS } from '../helpers/test-setup.js';

describe('ASCENT', () => {
  beforeAll(async () => {
    // Use launchpad save for ascent tests
    // MUST use forceReload - always reload save, because vessel state changes from pad to orbit
    await ensureKspReady(SAVES.LAUNCHPAD, { forceReload: true });
  }, TIMEOUTS.KSP_STARTUP);

  describe('to 100km equatorial orbit', () => {
    // Single long-running operation - cannot be split into separate it() blocks
    it('launches and reaches orbit', async () => {
      const ascent = await getAscentProgram();

      const handle = await ascent.launchToOrbit({
        altitude: 100000,
        inclination: 0
      });

      expect(handle).toBeDefined();
      expect(handle.targetAltitude).toBe(100000);

      const result = await handle.waitForCompletion();

      expect(result.success).toBe(true);

      // Record success - allows circularize to chain without reload
      recordTestSuccess('ascent');
    }, TIMEOUTS.BURN_EXECUTION);
  });
});
