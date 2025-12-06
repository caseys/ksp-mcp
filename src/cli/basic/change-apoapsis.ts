#!/usr/bin/env node
/**
 * Change apoapsis altitude
 * Usage: npm run change-apoapsis <altitude_km> [timeRef]
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { ManeuverProgram } from '../../mechjeb/programs/maneuver.js';
import { getOrbitInfo } from '../../mechjeb/telemetry.js';

async function main() {
  // Get altitude from command line (convert km to meters)
  const altitudeKm = process.argv[2] ? parseFloat(process.argv[2]) : null;
  const timeRef = (process.argv[3]?.toUpperCase() || 'PERIAPSIS') as 'APOAPSIS' | 'PERIAPSIS';

  if (altitudeKm === null) {
    console.error('Usage: npm run change-apoapsis <altitude_km> [APOAPSIS|PERIAPSIS]');
    console.error('Example: npm run change-apoapsis 250 PERIAPSIS');
    process.exit(1);
  }

  const altitudeMeters = altitudeKm * 1000;

  console.log(`=== Change Apoapsis ===\n`);
  console.log(`Target apoapsis: ${altitudeKm} km`);
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
    console.log(`   Periapsis: ${(orbit.periapsis / 1000).toFixed(1)} km`);
    console.log(`   Apoapsis: ${(orbit.apoapsis / 1000).toFixed(1)} km\n`);

    // Create apoapsis change node using library
    console.log(`3. Creating CHANGEAP node (burn at ${timeRef.toLowerCase()})...`);
    const maneuver = new ManeuverProgram(conn);
    const result = await maneuver.adjustApoapsis(altitudeMeters, timeRef);

    if (!result.success) {
      console.log('   Failed to create node');
      console.log(`   ${result.error || 'Note: Cannot lower Ap below current Pe (orbital mechanics)'}`);
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
