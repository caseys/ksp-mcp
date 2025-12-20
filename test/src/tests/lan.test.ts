/**
 * E2E test for LAN (Longitude of Ascending Node) maneuver operation
 *
 * Tests that MechJeb can create a node to change orbital plane LAN.
 */

import { ensureKspReady, getManeuverProgram, clearNodes, SAVES } from '../helpers/test-setup.js';

describe('LAN', () => {
  beforeAll(async () => {
    await ensureKspReady(SAVES.ORBIT);
  });

  beforeEach(async () => {
    await clearNodes();
  });

  describe('change to 90 degrees', () => {
    it('creates node at apoapsis', async () => {
      const maneuver = await getManeuverProgram();
      const result = await maneuver.changeLAN(90, 'APOAPSIS', { execute: false });

      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
      expect(result.deltaV).toBeGreaterThan(0);
    });
  });

  describe('change to 180 degrees', () => {
    it('creates node at periapsis', async () => {
      const maneuver = await getManeuverProgram();
      const result = await maneuver.changeLAN(180, 'PERIAPSIS', { execute: false });

      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
    });
  });
});
