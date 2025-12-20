/**
 * E2E test for MATCHPLANES maneuver operation
 *
 * Tests that MechJeb can create a node to match orbital planes with target.
 * Uses test-rendezvous-kerbin-orbit save with test-station as target
 * for realistic rendezvous testing.
 */

import { ensureKspReady, getManeuverProgram, clearNodes, SAVES, TIMEOUTS } from '../helpers/test-setup.js';
import type { OrchestratedResult } from 'ksp-mcp/mechjeb';

describe('MATCHPLANES', () => {
  beforeAll(async () => {
    // Use rendezvous save - vessel in Kerbin orbit near test-station
    await ensureKspReady(SAVES.RENDEZVOUS);
  }, TIMEOUTS.KSP_STARTUP);

  describe('match plane with test-station', () => {
    let matchResult: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      matchResult = await maneuver.matchPlane('REL_NEAREST_AD', { target: 'test-station', targetType: 'vessel', execute: false });
    }, TIMEOUTS.MANEUVER_OPERATION);

    it('creates node', () => {
      expect(matchResult.success).toBe(true);
      expect(matchResult.deltaV).toBeDefined();
    });

    it('has reasonable delta-v for plane change', () => {
      // Plane changes are typically small when vessels are in similar orbits
      // but can be larger if inclinations differ significantly
      expect(matchResult.deltaV).toBeLessThan(1000);
    });
  });

  describe('with different timing references', () => {
    let ascendingResult: OrchestratedResult;
    let descendingResult: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      ascendingResult = await maneuver.matchPlane('REL_ASCENDING', { target: 'test-station', targetType: 'vessel', execute: false });
      await clearNodes();
      descendingResult = await maneuver.matchPlane('REL_DESCENDING', { target: 'test-station', targetType: 'vessel', execute: false });
    }, TIMEOUTS.MANEUVER_OPERATION);

    it('creates node at ascending node', () => {
      expect(ascendingResult.success).toBe(true);
      expect(ascendingResult.deltaV).toBeDefined();
    });

    it('creates node at descending node', () => {
      expect(descendingResult.success).toBe(true);
      expect(descendingResult.deltaV).toBeDefined();
    });
  });
});
