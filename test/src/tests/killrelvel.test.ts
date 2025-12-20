/**
 * E2E test for KILLRELVEL maneuver operation
 *
 * Tests that MechJeb can create a node to match velocity with target.
 * Uses test-rendezvous-kerbin-orbit save with test-station as target
 * for realistic rendezvous testing.
 */

import { ensureKspReady, getManeuverProgram, clearNodes, SAVES, TIMEOUTS } from '../helpers/test-setup.js';
import type { OrchestratedResult } from 'ksp-mcp/mechjeb';

describe('KILLRELVEL', () => {
  beforeAll(async () => {
    // Use rendezvous save - vessel in Kerbin orbit near test-station
    await ensureKspReady(SAVES.RENDEZVOUS);
  }, TIMEOUTS.KSP_STARTUP);

  describe('match velocity with test-station', () => {
    let killResult: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      killResult = await maneuver.killRelVel('CLOSEST_APPROACH', { target: 'test-station', targetType: 'vessel', execute: false });
    }, TIMEOUTS.MANEUVER_OPERATION);

    it('creates node', () => {
      expect(killResult.success).toBe(true);
      expect(killResult.deltaV).toBeDefined();
      expect(killResult.deltaV).toBeGreaterThan(0);
    });

    it('has reasonable delta-v for rendezvous', () => {
      // Rendezvous burns are typically small when vessels are in similar orbits
      expect(killResult.deltaV).toBeLessThan(500);
    });
  });

  describe('with X_FROM_NOW timing', () => {
    let killResult: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      killResult = await maneuver.killRelVel('X_FROM_NOW', { target: 'test-station', targetType: 'vessel', execute: false });
    }, TIMEOUTS.MANEUVER_OPERATION);

    it('creates node', () => {
      expect(killResult.success).toBe(true);
      expect(killResult.deltaV).toBeDefined();
    });
  });
});
