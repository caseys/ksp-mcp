/**
 * E2E test for CHANGEECCENTRICITY maneuver operation
 *
 * Tests that MechJeb can create a node to change orbital eccentricity
 * (0 = circular, higher = more elliptical).
 */

import { ensureKspReady, getManeuverProgram, clearNodes, SAVES, TIMEOUTS } from '../helpers/test-setup.js';
import type { OrchestratedResult } from 'ksp-mcp/mechjeb';

describe('CHANGEECCENTRICITY', () => {
  beforeAll(async () => {
    await ensureKspReady(SAVES.ORBIT);
  }, TIMEOUTS.KSP_STARTUP);

  describe('increase eccentricity (more elliptical)', () => {
    let result: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      // Make orbit more elliptical (from near-circular)
      result = await maneuver.changeEccentricity(0.3, 'APOAPSIS', { execute: false });
    }, TIMEOUTS.MANEUVER_OPERATION);

    it('creates node', () => {
      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
    });

    it('requires delta-v to change eccentricity', () => {
      expect(result.deltaV).toBeGreaterThan(0);
    });
  });

  describe('circularize (eccentricity near 0)', () => {
    let result: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      // Make orbit more circular
      result = await maneuver.changeEccentricity(0.01, 'APOAPSIS', { execute: false });
    }, TIMEOUTS.MANEUVER_OPERATION);

    it('creates node', () => {
      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
    });

    it('may require minimal delta-v if already near-circular', () => {
      // If already circular, this might be near 0
      expect(result.deltaV).toBeDefined();
    });
  });

  describe('moderate eccentricity', () => {
    let result: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      result = await maneuver.changeEccentricity(0.15, 'PERIAPSIS', { execute: false });
    }, TIMEOUTS.MANEUVER_OPERATION);

    it('creates node at periapsis', () => {
      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
    });
  });
});
