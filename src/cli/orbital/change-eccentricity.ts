#!/usr/bin/env node
/**
 * Change orbital eccentricity
 */

import * as daemon from '../../daemon/index.js';
import type { ManeuverResult } from '../../mechjeb/programs/maneuver.js';
import type { OrbitInfo } from '../../mechjeb/types.js';

async function main() {
  // Parse command line arguments
  const newEcc = parseFloat(process.argv[2]);
  const timeRef = (process.argv[3] || 'APOAPSIS').toUpperCase();

  if (isNaN(newEcc) || newEcc < 0 || newEcc >= 1) {
    console.error('Usage: npm run eccentricity <newEcc> [timeRef]');
    console.error('newEcc must be between 0 (circular) and 1 (parabolic)');
    console.error('Example: npm run eccentricity 0.5 APOAPSIS');
    process.exit(1);
  }

  console.log(`=== Change Eccentricity to ${newEcc} at ${timeRef} ===\n`);

  try {
    // Check current orbit using library
    console.log('1. Current orbit...');
    const orbit = await daemon.call<OrbitInfo>('orbitInfo');
    console.log(`   Eccentricity: ${orbit.eccentricity.toFixed(3)}`);
    console.log(`   Periapsis: ${(orbit.periapsis / 1000).toFixed(1)} km`);
    console.log(`   Apoapsis: ${(orbit.apoapsis / 1000).toFixed(1)} km\n`);

    // Create ECCENTRICITY node using library
    console.log(`2. Creating ECCENTRICITY node (${timeRef.toLowerCase()})...`);
    const result = await daemon.call<ManeuverResult>('changeEccentricity', {
      eccentricity: newEcc,
      timeRef,
    });

    if (!result.success) {
      console.log('   Failed to create ECCENTRICITY node');
      console.log(`   ${result.error || 'Operation error'}`);
      return;
    }

    console.log('   Node created!\n');

    // Show node details from result
    console.log('3. Node info...');
    console.log(`   ΔV: ${result.deltaV?.toFixed(1) || '?'} m/s in ${result.timeToNode?.toFixed(0) || '?'} seconds\n`);

    console.log('✅ Node created! Use "npm run execute-node" to execute.');

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  }
}

main().catch(console.error);
