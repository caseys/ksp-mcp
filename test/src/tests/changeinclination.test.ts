/**
 * E2E test for CHANGEINCLINATION maneuver operation
 *
 * Tests that MechJeb can create a maneuver node to change orbital inclination.
 */

import { ensureKspReady, getManeuverProgram, clearNodes, SAVES } from '../helpers/test-setup.js';

describe('CHANGEINCLINATION', () => {
  beforeAll(async () => {
    await ensureKspReady(SAVES.ORBIT);
  });

  beforeEach(async () => {
    await clearNodes();
  });

  describe('to 0 degrees (equatorial)', () => {
    it('creates node at nearest equatorial node', async () => {
      const maneuver = await getManeuverProgram();
      const result = await maneuver.changeInclination(0, 'EQ_NEAREST_AD', { execute: false });

      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
      // May have small or zero dV if already close to equatorial
      expect(result.deltaV).toBeGreaterThanOrEqual(0);
    });
  });

  describe('to 10 degrees', () => {
    it('creates node at nearest equatorial node', async () => {
      const maneuver = await getManeuverProgram();
      const result = await maneuver.changeInclination(10, 'EQ_NEAREST_AD', { execute: false });

      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
      expect(result.deltaV).toBeGreaterThan(0);
    });
  });
});
