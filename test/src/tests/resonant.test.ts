/**
 * E2E test for RESONANTORBIT maneuver operation
 *
 * Tests that MechJeb can create a node to establish a resonant orbit
 * (useful for satellite deployment constellations).
 */

import { ensureKspReady, getManeuverProgram, clearNodes, SAVES } from '../helpers/test-setup.js';

describe('RESONANTORBIT', () => {
  beforeAll(async () => {
    await ensureKspReady(SAVES.ORBIT);
  });

  beforeEach(async () => {
    await clearNodes();
  });

  describe('2:1 resonance', () => {
    it('creates node at apoapsis', async () => {
      const maneuver = await getManeuverProgram();
      const result = await maneuver.resonantOrbit(2, 1, 'APOAPSIS', { execute: false });

      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
      expect(result.deltaV).toBeGreaterThan(0);
    });
  });

  describe('3:2 resonance', () => {
    it('creates node at periapsis', async () => {
      const maneuver = await getManeuverProgram();
      const result = await maneuver.resonantOrbit(3, 2, 'PERIAPSIS', { execute: false });

      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
      expect(result.deltaV).toBeGreaterThan(0);
    });
  });

  describe('4:3 resonance (fine spacing)', () => {
    it('creates node at apoapsis', async () => {
      const maneuver = await getManeuverProgram();
      const result = await maneuver.resonantOrbit(4, 3, 'APOAPSIS', { execute: false });

      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
    });
  });
});
