#!/usr/bin/env node
/**
 * Change longitude of periapsis
 */

import * as daemon from '../../daemon/index.js';
import type { ManeuverResult } from '../../mechjeb/programs/maneuver.js';
import type { OrbitInfo } from '../../mechjeb/types.js';

async function main() {
  // Parse command line arguments
  const targetLongDegrees = parseFloat(process.argv[2]);
  const timeRef = (process.argv[3] || 'APOAPSIS').toUpperCase();

  if (isNaN(targetLongDegrees)) {
    console.error('Usage: npm run longitude <targetLongitude> [timeRef]');
    console.error('targetLongitude: desired longitude of periapsis in degrees (-180 to 180)');
    console.error('timeRef: APOAPSIS (default) or PERIAPSIS');
    console.error('Example: npm run longitude -74.5 APOAPSIS  # Periapsis over KSC longitude');
    process.exit(1);
  }

  console.log(`=== Change Longitude of Periapsis to ${targetLongDegrees}° at ${timeRef} ===\n`);

  try {
    // Check current orbit using library
    console.log('1. Current orbit...');
    const orbit = await daemon.call<OrbitInfo>('orbitInfo');
    console.log(`   Periapsis: ${(orbit.periapsis / 1000).toFixed(1)} km`);
    console.log(`   Apoapsis: ${(orbit.apoapsis / 1000).toFixed(1)} km\n`);

    // Create LONGITUDE node using library
    console.log(`2. Creating LONGITUDE node (${timeRef.toLowerCase()})...`);
    const result = await daemon.call<ManeuverResult>('changePeriapsisLongitude', {
      longitude: targetLongDegrees,
      timeRef,
    });

    if (!result.success) {
      console.log('   Failed to create LONGITUDE node');
      console.log(`   ${result.error || 'Operation error'}`);
      return;
    }

    console.log('   Node created!\n');

    // Show node details from result
    console.log('3. Node info...');
    console.log(`   ΔV: ${result.deltaV?.toFixed(1) || '?'} m/s in ${result.timeToNode?.toFixed(0) || '?'} seconds\n`);

    console.log('✅ Node created! Use "npm run execute-node" to execute.');
    console.log('\nNote: LONGITUDE rotates the orbit so periapsis occurs at the specified longitude.');
    console.log(`      After executing, periapsis will be at ${targetLongDegrees}° longitude.`);

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  }
}

main().catch(console.error);
