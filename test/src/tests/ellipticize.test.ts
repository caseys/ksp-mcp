/**
 * E2E test for ELLIPTICIZE maneuver operation
 *
 * Tests that MechJeb can create a maneuver node to reshape orbit to specific Pe/Ap.
 */

import { ensureKspReady, getManeuverProgram, clearNodes, SAVES } from '../helpers/test-setup.js';

describe('ELLIPTICIZE', () => {
  beforeAll(async () => {
    await ensureKspReady(SAVES.ORBIT);
  });

  beforeEach(async () => {
    await clearNodes();
  });

  describe('to 80km x 120km', () => {
    it('creates node at apoapsis', async () => {
      const maneuver = await getManeuverProgram();
      const result = await maneuver.ellipticize(80000, 120000, 'APOAPSIS', { execute: false });

      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
      expect(result.deltaV).toBeGreaterThan(0);
    });
  });
});
