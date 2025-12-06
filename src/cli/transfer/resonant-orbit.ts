#!/usr/bin/env node
/**
 * Create resonant orbit for satellite constellations
 * Usage: npm run resonant-orbit <numerator> <denominator> [timeRef]
 * Example: npm run resonant-orbit 2 3 APOAPSIS  (2:3 resonance)
 *
 * Creates an orbit where period = (numerator/denominator) * current period.
 * Useful for deploying satellite constellations at evenly spaced intervals.
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { resonantOrbit } from '../../mechjeb/programs/transfer/index.js';
import { getOrbitInfo } from '../../mechjeb/telemetry.js';

async function main() {
  const numerator = process.argv[2] ? parseInt(process.argv[2]) : null;
  const denominator = process.argv[3] ? parseInt(process.argv[3]) : null;
  const timeRef = (process.argv[4]?.toUpperCase() || 'APOAPSIS') as string;

  if (numerator === null || denominator === null || isNaN(numerator) || isNaN(denominator)) {
    console.error('Usage: npm run resonant-orbit <numerator> <denominator> [timeRef]');
    console.error('Example: npm run resonant-orbit 2 3 APOAPSIS');
    console.error('Creates orbit where period = (numerator/denominator) * current period');
    process.exit(1);
  }

  console.log(`=== Resonant Orbit ===\n`);
  console.log(`Resonance ratio: ${numerator}:${denominator}`);
  console.log(`Execution point: ${timeRef}\n`);

  const conn = new KosConnection({
    cpuLabel: 'guidance',
  });

  try {
    console.log('1. Connecting to kOS...');
    await conn.connect();
    console.log('   Connected!\n');

    // Show current orbital period using library
    console.log('2. Current orbit...');
    const orbit = await getOrbitInfo(conn);
    console.log(`   Period: ${orbit.period.toFixed(0)} seconds\n`);

    // Create resonant orbit node using library
    console.log('3. Creating resonant orbit node...');
    const result = await resonantOrbit(conn, numerator, denominator, timeRef);

    if (!result.success) {
      console.log('   Failed to create resonant orbit node');
      console.log(`   ${result.error || 'Operation error'}`);
      return;
    }

    console.log('   Node created!\n');

    // Show node details from result
    console.log('4. Maneuver node info...');
    console.log(`   ΔV: ${result.deltaV?.toFixed(1) || '?'} m/s in ${result.timeToNode?.toFixed(0) || '?'} seconds\n`);

    console.log('✅ Node created! Use "npm run execute-node" to execute.\n');

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  } finally {
    await conn.disconnect();
    console.log('Disconnected.\n');
  }
}

main().catch(console.error);
