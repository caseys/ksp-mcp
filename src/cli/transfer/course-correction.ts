#!/usr/bin/env node
/**
 * Course correction maneuver
 * Usage: npm run course-correction [target_pe_km]
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { ManeuverProgram } from '../../mechjeb/programs/maneuver.js';

async function main() {
  // Get target periapsis from command line (convert km to meters)
  const targetPeKm = process.argv[2] ? parseFloat(process.argv[2]) : 50;
  const targetPeMeters = targetPeKm * 1000;

  console.log(`=== Course Correction ===\n`);
  console.log(`Target periapsis: ${targetPeKm} km\n`);

  const conn = new KosConnection({
    cpuLabel: 'guidance',
  });

  try {
    console.log('1. Connecting to kOS...');
    await conn.connect();
    console.log('   Connected!\n');

    // Check if we have a target
    console.log('2. Checking target...');
    const maneuver = new ManeuverProgram(conn);
    const target = await maneuver.getTarget();
    if (!target) {
      console.log('   No target set. Set a target first.');
      return;
    }
    console.log(`   Target: ${target}\n`);

    // Check current trajectory
    console.log('3. Current trajectory...');
    const trajResult = await conn.execute(
      'IF SHIP:ORBIT:HASNEXTPATCH { ' +
      '  PRINT "Current Pe at target: " + ROUND(SHIP:ORBIT:NEXTPATCH:PERIAPSIS/1000, 1) + " km". ' +
      '} ELSE { PRINT "No encounter with target". }'
    );
    console.log(`   ${trajResult.output.trim()}\n`);

    // Create course correction node using library
    console.log(`4. Creating course correction node...`);
    const result = await maneuver.courseCorrection(targetPeMeters);

    if (!result.success) {
      console.log('   Failed to create node');
      console.log(`   ${result.error || 'Operation error'}`);
      return;
    }

    console.log('   Node created!\n');

    // Show node details from result
    console.log('5. Maneuver node info...');
    console.log(`   ΔV: ${result.deltaV?.toFixed(1) || '?'} m/s in ${result.timeToNode?.toFixed(0) || '?'} seconds\n`);

    // Verify resulting trajectory
    console.log('6. Target trajectory after burn...');
    const verifyResult = await conn.execute(
      'IF HASNODE AND NEXTNODE:ORBIT:HASNEXTPATCH { ' +
      '  SET O TO NEXTNODE:ORBIT:NEXTPATCH. ' +
      '  PRINT "Target Pe at destination: " + ROUND(O:PERIAPSIS / 1000, 1) + " km". ' +
      '} ELSE { ' +
      '  PRINT "Cannot verify trajectory". ' +
      '}'
    );
    console.log(`   ${verifyResult.output.trim()}\n`);

    console.log('✅ Node created! Use "npm run execute-node" to execute.\n');

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  } finally {
    await conn.disconnect();
    console.log('Disconnected.\n');
  }
}

main().catch(console.error);
