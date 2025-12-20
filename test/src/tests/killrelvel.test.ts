/**
 * E2E test for KILLRELVEL maneuver operation
 *
 * Tests that MechJeb can create a node to match velocity with target.
 * Most useful for rendezvous operations.
 */

import { ensureKspReady, getManeuverProgram, clearNodes, SAVES, TIMEOUTS } from '../helpers/test-setup.js';
import type { OrchestratedResult } from 'ksp-mcp/mechjeb';

describe('KILLRELVEL', () => {
  beforeAll(async () => {
    await ensureKspReady(SAVES.ORBIT);
  }, TIMEOUTS.KSP_STARTUP);

  describe('at closest approach to Mun', () => {
    let killResult: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      killResult = await maneuver.killRelVel('CLOSEST_APPROACH', { target: 'Mun', execute: false });
    }, TIMEOUTS.BURN_EXECUTION);

    it('creates node', () => {
      // deltaV will be large since we're matching a moon's orbital velocity
      expect(killResult.success).toBe(true);
      expect(killResult.deltaV).toBeDefined();
      expect(killResult.deltaV).toBeGreaterThan(0);
    });
  });

  describe('with X_FROM_NOW timing', () => {
    let killResult: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      killResult = await maneuver.killRelVel('X_FROM_NOW', { target: 'Mun', execute: false });
    }, TIMEOUTS.BURN_EXECUTION);

    it('creates node', () => {
      expect(killResult.success).toBe(true);
      expect(killResult.deltaV).toBeDefined();
    });
  });
});
