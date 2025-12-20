/**
 * E2E test for CHANGESEMIMAJORAXIS maneuver operation
 *
 * Tests that MechJeb can create a node to change the semi-major axis
 * of the orbit (affects orbital period).
 */

import { ensureKspReady, getManeuverProgram, clearNodes, SAVES, TIMEOUTS } from '../helpers/test-setup.js';
import type { OrchestratedResult } from 'ksp-mcp/mechjeb';

describe('CHANGESEMIMAJORAXIS', () => {
  beforeAll(async () => {
    await ensureKspReady(SAVES.ORBIT);
  }, TIMEOUTS.KSP_STARTUP);

  describe('increase semi-major axis', () => {
    let result: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      // Increase SMA to 750km (from ~700km circular orbit)
      result = await maneuver.changeSemiMajorAxis(750_000, 'APOAPSIS', { execute: false });
    }, TIMEOUTS.MANEUVER_OPERATION);

    it('creates node', () => {
      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
    });

    it('requires positive delta-v to increase SMA', () => {
      expect(result.deltaV).toBeGreaterThan(0);
    });
  });

  describe('decrease semi-major axis', () => {
    let result: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      // Decrease SMA to 650km
      result = await maneuver.changeSemiMajorAxis(650_000, 'PERIAPSIS', { execute: false });
    }, TIMEOUTS.MANEUVER_OPERATION);

    it('creates node', () => {
      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
    });

    it('requires delta-v to decrease SMA', () => {
      expect(result.deltaV).toBeGreaterThan(0);
    });
  });

  describe('at different time references', () => {
    let apoapsisResult: OrchestratedResult;
    let periapsisResult: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      apoapsisResult = await maneuver.changeSemiMajorAxis(800_000, 'APOAPSIS', { execute: false });
      await clearNodes();
      periapsisResult = await maneuver.changeSemiMajorAxis(800_000, 'PERIAPSIS', { execute: false });
    }, TIMEOUTS.MANEUVER_OPERATION);

    it('creates node at apoapsis', () => {
      expect(apoapsisResult.success).toBe(true);
    });

    it('creates node at periapsis', () => {
      expect(periapsisResult.success).toBe(true);
    });
  });
});
