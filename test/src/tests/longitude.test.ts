/**
 * E2E test for LONGITUDE (Argument of Periapsis) maneuver operation
 *
 * Tests that MechJeb can create a node to change orbital longitude of periapsis.
 */

import { ensureKspReady, getManeuverProgram, clearNodes, SAVES } from '../helpers/test-setup.js';

describe('LONGITUDE', () => {
  beforeAll(async () => {
    await ensureKspReady(SAVES.ORBIT);
  });

  beforeEach(async () => {
    await clearNodes();
  });

  describe('change to 45 degrees', () => {
    it('creates node at apoapsis', async () => {
      const maneuver = await getManeuverProgram();
      const result = await maneuver.changeLongitude(45, 'APOAPSIS', { execute: false });

      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
      expect(result.deltaV).toBeGreaterThan(0);
    });
  });

  describe('change to 270 degrees', () => {
    it('creates node at periapsis', async () => {
      const maneuver = await getManeuverProgram();
      const result = await maneuver.changeLongitude(270, 'PERIAPSIS', { execute: false });

      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
    });
  });
});
