#!/usr/bin/env node
/**
 * Execute Hohmann transfer to target using ksp-mcp
 * Usage: npm run hohmann [capture]
 *   capture: optional, "true" or "false" (default: false)
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { ManeuverProgram } from '../../mechjeb/programs/maneuver.js';
import { getOrbitInfo } from '../../mechjeb/telemetry.js';

async function main() {
  // Get capture parameter from command line (default: false)
  const captureArg = process.argv[2]?.toLowerCase();
  const includeCapture = captureArg === 'true';

  console.log('=== Hohmann Transfer ===\n');
  console.log(`Capture burn: ${includeCapture ? 'YES' : 'NO (transfer only)'}\n`);

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

    // Set target first (setTarget includes confirmation)
    console.log('3. Setting target to Mun...');
    const maneuver = new ManeuverProgram(conn);
    const targetResult = await maneuver.setTarget('Mun', 'body');
    if (!targetResult.success) {
      console.log(`   ERROR: ${targetResult.error ?? 'Failed to set target'}`);
      return;
    }
    console.log(`   Target: ${targetResult.name} (${targetResult.type})\n`);

    // Create Hohmann transfer using library
    console.log('4. Creating transfer node...');
    const result = await maneuver.hohmannTransfer('COMPUTED', includeCapture);

    if (!result.success) {
      console.log('   Failed to create transfer nodes');
      console.log(`   ${result.error || 'Operation error'}`);
      return;
    }

    console.log('   Node created!\n');

    // Show node details from result
    console.log('5. First node info...');
    console.log(`   ΔV: ${result.deltaV?.toFixed(1) || '?'} m/s in ${result.timeToNode?.toFixed(0) || '?'} seconds\n`);

    // Check for encounter with target
    console.log('6. Checking for encounter with target...');
    const encounterCheck = await conn.execute(
      'IF HASNODE { ' +
      '  SET ORB TO NEXTNODE:ORBIT. ' +
      '  IF ORB:HASNEXTPATCH { ' +
      '    PRINT "Encounter: YES - " + ORB:NEXTPATCH:BODY:NAME. ' +
      '  } ELSE { ' +
      '    PRINT "Encounter: NO - transfer node does not create encounter". ' +
      '  } ' +
      '} ELSE { ' +
      '  PRINT "Encounter: ERROR - no node". ' +
      '}'
    );
    console.log(`   ${encounterCheck.output.trim()}\n`);

    console.log('✅ Node created! Use "npm run execute-node" to execute.');

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  } finally {
    await conn.disconnect();
    console.log('Disconnected.\n');
  }
}

main().catch(console.error);
