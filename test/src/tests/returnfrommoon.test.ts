/**
 * E2E test for RETURNFROMMOON maneuver operation
 *
 * Tests that MechJeb can create a node to return from a moon
 * to the parent body (e.g., Mun → Kerbin).
 * Uses test-in-munar-orbit save with vessel orbiting Mun.
 */

import { ensureKspReady, getManeuverProgram, clearNodes, SAVES, TIMEOUTS } from '../helpers/test-setup.js';
import type { OrchestratedResult } from 'ksp-mcp/mechjeb';

describe('RETURNFROMMOON', () => {
  beforeAll(async () => {
    // Use Mun orbit save - vessel orbiting Mun
    await ensureKspReady(SAVES.MUN_ORBIT);
  }, TIMEOUTS.KSP_STARTUP);

  describe('return to Kerbin with 80km periapsis', () => {
    let result: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      // Return to Kerbin with 80km periapsis (safe reentry altitude)
      result = await maneuver.returnFromMoon(80_000, { execute: false });
    }, TIMEOUTS.MANEUVER_OPERATION);

    it('creates return node', () => {
      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
    });

    it('requires delta-v for trans-Kerbin injection', () => {
      expect(result.deltaV).toBeGreaterThan(0);
    });

    it('has reasonable delta-v for Mun return', () => {
      // Trans-Kerbin injection from Mun is typically 200-400 m/s
      expect(result.deltaV).toBeLessThan(1000);
    });
  });

  describe('return with different periapsis targets', () => {
    let lowResult: OrchestratedResult;
    let highResult: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      // Low periapsis for aerobraking
      lowResult = await maneuver.returnFromMoon(35_000, { execute: false });
      await clearNodes();
      // High periapsis for orbital capture
      highResult = await maneuver.returnFromMoon(100_000, { execute: false });
    }, TIMEOUTS.MANEUVER_OPERATION);

    it('creates node for low periapsis', () => {
      expect(lowResult.success).toBe(true);
      expect(lowResult.deltaV).toBeGreaterThan(0);
    });

    it('creates node for high periapsis', () => {
      expect(highResult.success).toBe(true);
      expect(highResult.deltaV).toBeGreaterThan(0);
    });
  });
});
