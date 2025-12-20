/**
 * E2E test for CHANGEPE maneuver operation
 *
 * Tests that MechJeb can create a maneuver node to change periapsis.
 */

import { ensureKspReady, getManeuverProgram, clearNodes, SAVES } from '../helpers/test-setup.js';

describe('CHANGEPE', () => {
  beforeAll(async () => {
    await ensureKspReady(SAVES.ORBIT);
  });

  beforeEach(async () => {
    await clearNodes();
  });

  describe('lower to 75km', () => {
    it('creates node at apoapsis', async () => {
      const maneuver = await getManeuverProgram();
      const result = await maneuver.adjustPeriapsis(75000, 'APOAPSIS', { execute: false });

      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
      expect(result.deltaV).toBeGreaterThan(0);
    });
  });

  describe('raise to 100km', () => {
    it('creates node at apoapsis', async () => {
      const maneuver = await getManeuverProgram();
      const result = await maneuver.adjustPeriapsis(100000, 'APOAPSIS', { execute: false });

      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
      // Note: On a ~110km circular orbit, raising Pe to 100km will have minimal dV
    });
  });
});
