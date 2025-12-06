#!/usr/bin/env node
/**
 * Change orbital inclination
 * Usage: npm run change-inclination <target_degrees> [timeRef]
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { ManeuverProgram } from '../../mechjeb/programs/maneuver.js';
import { getOrbitInfo } from '../../mechjeb/telemetry.js';

async function main() {
  // Get target inclination from command line
  const targetInc = process.argv[2] ? parseFloat(process.argv[2]) : null;
  const timeRef = (process.argv[3]?.toUpperCase() || 'EQ_NEAREST_AD') as
    'EQ_ASCENDING' | 'EQ_DESCENDING' | 'EQ_NEAREST_AD' | 'EQ_HIGHEST_AD';

  if (targetInc === null) {
    console.error('Usage: npm run change-inclination <target_degrees> [EQ_ASCENDING|EQ_DESCENDING|EQ_NEAREST_AD|EQ_HIGHEST_AD]');
    console.error('Example: npm run change-inclination 0 EQ_NEAREST_AD');
    process.exit(1);
  }

  console.log(`=== Change Inclination ===\n`);
  console.log(`Target inclination: ${targetInc}°`);
  console.log(`Execution point: ${timeRef}\n`);

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
    console.log(`   Inclination: ${orbit.inclination.toFixed(2)} degrees`);
    console.log(`   Periapsis: ${(orbit.periapsis / 1000).toFixed(1)} km`);
    console.log(`   Apoapsis: ${(orbit.apoapsis / 1000).toFixed(1)} km\n`);

    // Create inclination change node using library
    console.log(`3. Creating CHANGEINCLINATION node (burn at ${timeRef.toLowerCase()})...`);
    const maneuver = new ManeuverProgram(conn);
    const result = await maneuver.changeInclination(targetInc, timeRef);

    if (!result.success) {
      console.log('   Failed to create node');
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
