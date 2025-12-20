#!/usr/bin/env node
/**
 * Change longitude of ascending node (LAN)
 */

import * as daemon from '../../daemon/index.js';
import type { ManeuverResult } from '../../mechjeb/programs/maneuver.js';
import type { OrbitInfo } from '../../mechjeb/types.js';

async function main() {
  // Parse command line arguments
  const targetLanDegrees = parseFloat(process.argv[2]);
  const timeRef = (process.argv[3] || 'APOAPSIS').toUpperCase();

  if (isNaN(targetLanDegrees)) {
    console.error('Usage: npm run lan <targetLAN> [timeRef]');
    console.error('targetLAN: desired longitude of ascending node in degrees (-180 to 180)');
    console.error('timeRef: APOAPSIS (default), PERIAPSIS, or X_FROM_NOW');
    console.error('Example: npm run lan 0 APOAPSIS  # Ascending node at prime meridian');
    process.exit(1);
  }

  console.log(`=== Change Longitude of Ascending Node to ${targetLanDegrees}° at ${timeRef} ===\n`);

  try {
    // Check current orbit using library
    console.log('1. Current orbit...');
    const orbit = await daemon.call<OrbitInfo>('orbitInfo');
    console.log(`   Inclination: ${orbit.inclination.toFixed(2)}°`);
    console.log(`   LAN: ${orbit.lan.toFixed(2)}°`);
    console.log(`   Periapsis: ${(orbit.periapsis / 1000).toFixed(1)} km`);
    console.log(`   Apoapsis: ${(orbit.apoapsis / 1000).toFixed(1)} km\n`);

    // Check inclination (LAN operation recommends > 10°)
    if (orbit.inclination < 10) {
      console.log(`Warning: Inclination is ${orbit.inclination.toFixed(1)}° (< 10°). LAN changes may be inaccurate for low-inclination orbits.\n`);
    }

    // Create LAN node using library
    console.log(`2. Creating LAN node (${timeRef.toLowerCase()})...`);
    const result = await daemon.call<ManeuverResult>('changeAscendingNode', {
      lan: targetLanDegrees,
      timeRef,
    });

    if (!result.success) {
      console.log('   Failed to create LAN node');
      console.log(`   ${result.error || 'Operation error'}`);
      return;
    }

    console.log('   Node created!\n');

    // Show node details from result
    console.log('3. Node info...');
    console.log(`   ΔV: ${result.deltaV?.toFixed(1) || '?'} m/s in ${result.timeToNode?.toFixed(0) || '?'} seconds\n`);

    console.log('✅ Node created! Use "npm run execute-node" to execute.');
    console.log('\nNote: LAN rotates the orbital plane so the ascending node occurs at the specified longitude.');
    console.log(`      After executing, ascending node will be at ${targetLanDegrees}° longitude.`);
    console.log('      (Ascending node = where orbit crosses equator going northward)');

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  }
}

main().catch(console.error);
