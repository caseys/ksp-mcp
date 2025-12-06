#!/usr/bin/env node
/**
 * Change semi-major axis of orbit
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { changeSemiMajorAxis } from '../../mechjeb/programs/basic/index.js';
import { getOrbitInfo } from '../../mechjeb/telemetry.js';

async function main() {
  // Parse command line arguments
  const newSma_km = parseFloat(process.argv[2]);
  const timeRef = (process.argv[3] || 'APOAPSIS').toUpperCase();

  if (isNaN(newSma_km)) {
    console.error('Usage: npm run semimajor <newSma_km> [timeRef]');
    console.error('Example: npm run semimajor 800 APOAPSIS');
    process.exit(1);
  }

  console.log(`=== Change Semi-Major Axis to ${newSma_km} km at ${timeRef} ===\n`);

  const conn = new KosConnection({
    cpuLabel: 'guidance',
  });

  try {
    console.log('1. Connecting to kOS...');
    await conn.connect();
    console.log('   Connected!\n');

    // Check current orbit using library
    console.log('2. Current orbit...');
    const orbit = await getOrbitInfo(conn);
    // Calculate current semi-major axis from pe/ap
    const bodyRadius = 600000; // Kerbin radius in meters
    const currentSma = (orbit.periapsis + orbit.apoapsis) / 2 + bodyRadius;
    console.log(`   Semi-major axis: ${(currentSma / 1000).toFixed(1)} km`);
    console.log(`   Periapsis: ${(orbit.periapsis / 1000).toFixed(1)} km`);
    console.log(`   Apoapsis: ${(orbit.apoapsis / 1000).toFixed(1)} km\n`);

    // Create SEMIMAJOR node using library
    console.log(`3. Creating SEMIMAJOR node (${timeRef.toLowerCase()})...`);
    const newSma_m = newSma_km * 1000;
    const result = await changeSemiMajorAxis(conn, newSma_m, timeRef);

    if (!result.success) {
      console.log('   Failed to create SEMIMAJOR node');
      console.log(`   ${result.error || 'Operation error'}`);
      return;
    }

    console.log('   Node created!\n');

    // Show node details from result
    console.log('4. Node info...');
    console.log(`   ΔV: ${result.deltaV?.toFixed(1) || '?'} m/s in ${result.timeToNode?.toFixed(0) || '?'} seconds\n`);

    console.log('✅ Node created! Use "npm run execute-node" to execute.');

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  } finally {
    await conn.disconnect();
    console.log('Disconnected.\n');
  }
}

main().catch(console.error);
