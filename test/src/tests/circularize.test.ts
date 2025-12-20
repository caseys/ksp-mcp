/**
 * E2E test for CIRCULARIZE maneuver operation
 *
 * Tests that MechJeb can create a circularization maneuver node.
 */

import { ensureKspReady, getManeuverProgram, clearNodes, SAVES } from '../helpers/test-setup.js';

describe('CIRCULARIZE', () => {
  beforeAll(async () => {
    // Can chain after ascent - vessel is already in orbit, no reload needed
    await ensureKspReady(SAVES.ORBIT, { chainAfter: ['ascent'] });
  });

  beforeEach(async () => {
    await clearNodes();
  });

  describe('at apoapsis', () => {
    it('creates node', async () => {
      const maneuver = await getManeuverProgram();
      const result = await maneuver.circularize('APOAPSIS', { execute: false });

      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
      expect(result.deltaV).toBeGreaterThan(0);
    });
  });

  describe('at periapsis', () => {
    it('creates node', async () => {
      const maneuver = await getManeuverProgram();
      const result = await maneuver.circularize('PERIAPSIS', { execute: false });

      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
      expect(result.deltaV).toBeGreaterThan(0);
    });
  });
});
