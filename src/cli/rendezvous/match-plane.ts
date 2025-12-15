#!/usr/bin/env node
/**
 * Match orbital plane with target
 * Usage: npm run match-plane <target> [timeRef]
 * Example: npm run match-plane "Target Ship" REL_NEAREST_AD
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { ManeuverProgram } from '../../mechjeb/programs/maneuver.js';
import { matchPlane } from '../../mechjeb/programs/rendezvous/index.js';
import { getOrbitInfo } from '../../mechjeb/telemetry.js';

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

  const conn = new KosConnection({
    cpuLabel: 'guidance',
  });

  try {
    console.log('1. Connecting to kOS...');
    await conn.connect();
    console.log('   Connected!\n');

    // Set target using library (setTarget includes confirmation)
    console.log('2. Setting target...');
    const maneuver = new ManeuverProgram(conn);
    const targetResult = await maneuver.setTarget(targetName, 'body');
    if (!targetResult.success) {
      console.log(`   ERROR: ${targetResult.error ?? 'Failed to set target'}`);
      return;
    }
    console.log(`   Target: ${targetResult.name} (${targetResult.type})\n`);

    // Show current state
    console.log('3. Current orbit...');
    const orbit = await getOrbitInfo(conn);
    console.log(`   Inclination: ${orbit.inclination.toFixed(2)} degrees\n`);

    // Create plane match node using library
    console.log('4. Creating plane match node...');
    const result = await matchPlane(conn, timeRef);

    if (!result.success) {
      console.log('   Failed to create plane match node');
      console.log(`   ${result.error || 'Note: Target must be in same sphere of influence'}`);
      return;
    }

    console.log('   Node created!\n');

    // Show node details from result
    console.log('5. Maneuver node info...');
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
