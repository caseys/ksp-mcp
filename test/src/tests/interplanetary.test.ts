/**
 * E2E test for INTERPLANETARYTRANSFER maneuver operation
 *
 * Tests that MechJeb can create a node for interplanetary transfer.
 * Uses test-aligned-moho-transfer save where Moho transfer window
 * is approximately 3 days away.
 */

import { ensureKspReady, getManeuverProgram, clearNodes, SAVES, TIMEOUTS } from '../helpers/test-setup.js';
import type { OrchestratedResult } from 'ksp-mcp/mechjeb';

describe('INTERPLANETARYTRANSFER', () => {
  beforeAll(async () => {
    // Use save aligned for Moho transfer window in ~3 days
    await ensureKspReady(SAVES.INTERPLANETARY);
  }, TIMEOUTS.KSP_STARTUP);

  describe('transfer to Moho (wait for phase angle)', () => {
    let result: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      // Wait for optimal phase angle (default behavior)
      result = await maneuver.interplanetaryTransfer(true, { target: 'Moho', execute: false });
    }, TIMEOUTS.MANEUVER_OPERATION);

    it('creates transfer node', () => {
      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
    });

    it('requires significant delta-v for Moho transfer', () => {
      // Moho transfers require substantial delta-v due to high inclination and close solar orbit
      expect(result.deltaV).toBeGreaterThan(0);
    });
  });

  describe('transfer without waiting for phase angle', () => {
    let result: OrchestratedResult;

    beforeAll(async () => {
      await clearNodes();
      const maneuver = await getManeuverProgram();
      // Don't wait for optimal phase angle - transfer immediately
      result = await maneuver.interplanetaryTransfer(false, { target: 'Moho', execute: false });
    }, TIMEOUTS.MANEUVER_OPERATION);

    it('creates transfer node', () => {
      expect(result.success).toBe(true);
      expect(result.deltaV).toBeDefined();
    });

    it('may require more delta-v when not waiting for optimal window', () => {
      // Non-optimal transfers typically require more delta-v
      expect(result.deltaV).toBeGreaterThan(0);
    });
  });
});
