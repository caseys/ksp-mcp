#!/usr/bin/env node
/**
 * Circularize orbit at apoapsis or periapsis
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { ManeuverProgram } from '../../mechjeb/programs/maneuver.js';
import { getOrbitInfo } from '../../mechjeb/telemetry.js';

async function main() {
  // Get time reference from command line (default: APOAPSIS)
  const timeRef = process.argv[2]?.toUpperCase() || 'APOAPSIS';

  if (!['APOAPSIS', 'PERIAPSIS'].includes(timeRef)) {
    console.error('Usage: npm run circularize [APOAPSIS|PERIAPSIS]');
    process.exit(1);
  }

  console.log(`=== Circularize at ${timeRef} ===\n`);

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
    console.log(`   Periapsis: ${(orbit.periapsis / 1000).toFixed(1)} km`);
    console.log(`   Apoapsis: ${(orbit.apoapsis / 1000).toFixed(1)} km\n`);

    // Create circularize node using library
    console.log(`3. Creating circularize node (at ${timeRef.toLowerCase()})...`);
    const maneuver = new ManeuverProgram(conn);
    const result = await maneuver.circularize(timeRef);

    if (!result.success) {
      console.log('   Failed to create circularize node');
      console.log(`   ${result.error || 'Operation error'}`);
      return;
    }

    console.log('   Node created!\n');

    // Show node details from result
    console.log('4. Circularize node info...');
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
