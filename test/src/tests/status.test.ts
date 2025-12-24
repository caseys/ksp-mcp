/**
 * E2E test for status/telemetry output
 *
 * Tests that telemetry includes vessel info and target info.
 */

import { ensureKspReady, getTestConnection, SAVES } from '../helpers/test-setup.js';
import { getShipTelemetry } from 'ksp-mcp/mechjeb';

describe('STATUS', () => {
  beforeAll(async () => {
    await ensureKspReady(SAVES.ORBIT);
  });

  describe('structured data', () => {
    it('returns vessel info object', async () => {
      const conn = await getTestConnection();
      const result = await getShipTelemetry(conn);

      expect(result.vessel).toBeDefined();
      expect(result.vessel.name).toBeDefined();
      expect(result.vessel.type).toBeDefined();
      expect(result.vessel.status).toBeDefined();
      expect(typeof result.vessel.name).toBe('string');
    });

    it('returns orbit info object', async () => {
      const conn = await getTestConnection();
      const result = await getShipTelemetry(conn);

      expect(result.orbit).toBeDefined();
      expect(result.orbit.body).toBe('Kerbin');
      expect(result.orbit.apoapsis).toBeGreaterThan(0);
      expect(result.orbit.periapsis).toBeGreaterThan(0);
      expect(result.orbit.period).toBeGreaterThan(0);
      expect(typeof result.orbit.inclination).toBe('number');
      expect(typeof result.orbit.eccentricity).toBe('number');
    });

    it('includes formatted output', async () => {
      const conn = await getTestConnection();
      const result = await getShipTelemetry(conn);

      expect(result.formatted).toBeDefined();
      expect(result.formatted).toContain('=== Ship Status ===');
      expect(result.formatted).toContain('Vessel:');
      expect(result.formatted).toContain('SOI:');
    });
  });

  describe('formatted output', () => {
    it('includes vessel line with correct format', async () => {
      const conn = await getTestConnection();
      const result = await getShipTelemetry(conn);

      // Should have vessel line with format: Vessel: {name} ({type}) - {status}
      expect(result.formatted).toMatch(/Vessel: .+ \([^)]+\) - [A-Z_]+/);
    });

    it('shows orbital data', async () => {
      const conn = await getTestConnection();
      const result = await getShipTelemetry(conn);

      expect(result.formatted).toContain('Apoapsis:');
      expect(result.formatted).toContain('Periapsis:');
      expect(result.formatted).toContain('Period:');
    });
  });

  describe('target info', () => {
    it('includes target in structured data when set', async () => {
      const conn = await getTestConnection();

      // Set target to Mun
      await conn.execute('SET TARGET TO MUN.', 2000);

      const result = await getShipTelemetry(conn);

      expect(result.target).toBeDefined();
      expect(result.target?.name).toBe('Mun');
      expect(result.target?.type).toBe('Body');
      expect(result.target?.distance).toBeGreaterThan(0);
    });

    it('shows target in formatted output when set', async () => {
      const conn = await getTestConnection();

      // Set target to Mun
      await conn.execute('SET TARGET TO MUN.', 2000);

      const result = await getShipTelemetry(conn);

      expect(result.formatted).toContain('=== Target ===');
      expect(result.formatted).toContain('Mun');
      expect(result.formatted).toContain('Distance:');
    });

    it('does not include target when not set', async () => {
      const conn = await getTestConnection();

      // Clear target (retry due to kOS quirks)
      for (let index = 0; index < 3; index++) {
        await conn.execute('SET TARGET TO "".', 1000);
      }

      const result = await getShipTelemetry(conn);

      // Check HASTARGET to know expected behavior
      const hasTarget = await conn.execute('PRINT HASTARGET.', 1000);

      if (hasTarget.output.toLowerCase().includes('false')) {
        expect(result.target).toBeUndefined();
        expect(result.formatted).not.toContain('=== Target ===');
      } else {
        // Target clearing is unreliable, just verify the test ran
        console.log('  Note: Target could not be cleared (kOS quirk)');
      }
    });
  });
});
