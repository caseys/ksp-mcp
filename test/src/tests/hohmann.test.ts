/**
 * E2E test for HOHMANN transfer maneuver operation
 *
 * Tests that MechJeb can create Hohmann transfer nodes to reach a target.
 */

import { ensureKspReady, getManeuverProgram, clearNodes, SAVES, TIMEOUTS } from '../helpers/test-setup.js';
import type { OrchestratedResult } from 'ksp-mcp/mechjeb';

describe('HOHMANN', () => {
  beforeAll(async () => {
    await ensureKspReady(SAVES.ORBIT);
  }, TIMEOUTS.KSP_STARTUP);

  describe('transfer to Mun', () => {
    let transferResult: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      transferResult = await maneuver.hohmannTransfer('COMPUTED', true, { target: 'Mun', execute: false });
    }, TIMEOUTS.BURN_EXECUTION);

    it('creates transfer node', () => {
      expect(transferResult.success).toBe(true);
      expect(transferResult.deltaV).toBeDefined();
      expect(transferResult.deltaV).toBeGreaterThan(0);
    });
  });

  describe('without target', () => {
    let hasTargetBefore: boolean;
    let attemptResult: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      await maneuver.clearTarget();
      hasTargetBefore = await maneuver.hasTarget();
      attemptResult = await maneuver.hohmannTransfer('COMPUTED', false, { execute: false });
    }, TIMEOUTS.BURN_EXECUTION);

    it('verifies no target', () => {
      expect(hasTargetBefore).toBe(false);
    });

    it('fails to create transfer', () => {
      expect(attemptResult.success).toBe(false);
      expect(attemptResult.error).toContain('No target');
    });
  });
});
