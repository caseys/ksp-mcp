#!/usr/bin/env node
/**
 * Match orbital plane with target
 * Usage: npm run match-plane <target> [timeRef]
 * Example: npm run match-plane "Target Ship" REL_NEAREST_AD
 */

import * as daemon from '../../daemon-client.js';
import type { ManeuverResult } from '../../../lib/mechjeb/maneuver.js';
import type { SetTargetResult } from '../../../lib/mechjeb/maneuver.js';
import type { OrbitInfo } from '../../../lib/types.js';

async function main() {
  const targetName = process.argv[2];
  const timeRef = (process.argv[3]?.toUpperCase() || 'REL_NEAREST_AD') as string;

  if (!targetName) {
    console.error('Usage: npm run match-plane <target> [timeRef]');
    console.error('Example: npm run match-plane "Mun" REL_NEAREST_AD');
    console.error('TimeRef options: REL_NEAREST_AD, REL_HIGHEST_AD, REL_ASCENDING, REL_DESCENDING');
    process.exit(1);
  }

  console.log(`=== Match Orbital Plane ===\n`);
  console.log(`Target: ${targetName}`);
  console.log(`Node selection: ${timeRef}\n`);

  try {
    // Set target using library (setTarget includes confirmation)
    console.log('1. Setting target...');
    const targetResult = await daemon.call<SetTargetResult>('setTarget', {
      name: targetName,
      type: 'body',
    });
    if (!targetResult.success) {
      console.log(`   ERROR: ${targetResult.error ?? 'Failed to set target'}`);
      return;
    }
    console.log(`   Target: ${targetResult.name} (${targetResult.type})\n`);

    // Show current state
    console.log('2. Current orbit...');
    const orbit = await daemon.call<OrbitInfo>('orbitInfo');
    console.log(`   Inclination: ${orbit.inclination.toFixed(2)} degrees\n`);

    // Create plane match node using library
    console.log('3. Creating plane match node...');
    const result = await daemon.call<ManeuverResult>('matchPlanes', {
      timeRef,
    });

    if (!result.success) {
      console.log('   Failed to create plane match node');
      console.log(`   ${result.error || 'Note: Target must be in same sphere of influence'}`);
      return;
    }

    console.log('   Node created!\n');

    // Show node details from result
    console.log('4. Maneuver node info...');
    console.log(`   ΔV: ${result.deltaV?.toFixed(1) || '?'} m/s in ${result.timeToNode?.toFixed(0) || '?'} seconds\n`);

    console.log('✅ Node created! Use "npm run execute-node" to execute.\n');

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  }
}

main().catch(console.error);
