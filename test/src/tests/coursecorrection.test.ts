/**
 * E2E test for COURSECORRECTION maneuver operation
 *
 * Tests that MechJeb can create a course correction node during
 * an interplanetary/interlunar transfer.
 *
 * Uses test-in-transit-to-mun save where vessel is already on
 * an intercept trajectory with Mun.
 */

import { ensureKspReady, getManeuverProgram, clearNodes, SAVES, TIMEOUTS } from '../helpers/test-setup.js';
import type { OrchestratedResult } from 'ksp-mcp/mechjeb';

describe('COURSECORRECTION', () => {
  beforeAll(async () => {
    // Use transit save - vessel already on intercept trajectory to Mun
    await ensureKspReady(SAVES.TRANSIT_MUN);
  }, TIMEOUTS.KSP_STARTUP);

  describe('fine-tune Mun approach', () => {
    let correctionResult: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      // Target should already be Mun from the save, but set it explicitly
      await maneuver.setTarget('Mun');
      correctionResult = await maneuver.courseCorrection(50000, { execute: false });
    }, TIMEOUTS.MANEUVER_OPERATION);

    it('creates course correction node', () => {
      expect(correctionResult.success).toBe(true);
      expect(correctionResult.deltaV).toBeDefined();
    });

    it('has reasonable delta-v for mid-course correction', () => {
      // Mid-course corrections are typically small (<100 m/s)
      expect(correctionResult.deltaV).toBeGreaterThan(0);
      expect(correctionResult.deltaV).toBeLessThan(500);
    });
  });

  describe('adjust to different periapsis', () => {
    let lowResult: OrchestratedResult;
    let highResult: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      lowResult = await maneuver.courseCorrection(20000, { execute: false });
      await clearNodes();
      highResult = await maneuver.courseCorrection(100000, { execute: false });
    }, TIMEOUTS.MANEUVER_OPERATION);

    it('creates node for low periapsis', () => {
      expect(lowResult.success).toBe(true);
    });

    it('creates node for high periapsis', () => {
      expect(highResult.success).toBe(true);
    });
  });
});
