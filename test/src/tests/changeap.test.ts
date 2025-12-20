/**
 * E2E test for CHANGEAP maneuver operation
 *
 * Tests that MechJeb can create a maneuver node to change apoapsis.
 */

import { ensureKspReady, getManeuverProgram, clearNodes, SAVES } from '../helpers/test-setup.js';

describe('CHANGEAP', () => {
  beforeAll(async () => {
    await ensureKspReady(SAVES.ORBIT);
  });

  beforeEach(async () => {
    await clearNodes();
  });

  describe('raise to 150km', () => {
    it('creates node at periapsis', async () => {
      const maneuver = await getManeuverProgram();
      const result = await maneuver.adjustApoapsis(150000, 'PERIAPSIS', { execute: false });

      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
      expect(result.deltaV).toBeGreaterThan(0);
    });
  });

  describe('lower to 90km', () => {
    it('creates node at apoapsis', async () => {
      const maneuver = await getManeuverProgram();
      const result = await maneuver.adjustApoapsis(90000, 'APOAPSIS', { execute: false });

      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
      expect(result.deltaV).toBeGreaterThan(0);
    });
  });
});
