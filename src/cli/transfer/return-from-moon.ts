#!/usr/bin/env node
/**
 * Return from moon to parent body (e.g., Mun -> Kerbin)
 */

import * as daemon from '../daemon-client.js';
import type { ManeuverResult } from '../../lib/programs/maneuver.js';
import type { OrbitInfo } from '../../lib/types.js';

interface ExecuteResult {
  success: boolean;
  output?: string;
  error?: string;
}

async function main() {
  // Get target periapsis from command line (default: 100km = 100000m)
  const targetPeriapsis = process.argv[2] ? Number.parseInt(process.argv[2]) : 100_000;

  console.log(`=== Return from Moon ===\n`);
  console.log(`Target periapsis: ${targetPeriapsis / 1000} km\n`);

  try {
    // Check current body
    console.log('1. Current location...');
    const bodyResult = await daemon.call<ExecuteResult>('execute', {
      command:
        'PRINT "Orbiting: " + SHIP:BODY:NAME. ' +
        'PRINT "Parent body: " + SHIP:BODY:BODY:NAME.',
    });
    console.log(`   ${bodyResult.output?.trim() || 'Unknown'}\n`);

    // Check current orbit using library
    console.log('2. Current orbit...');
    const orbit = await daemon.call<OrbitInfo>('orbitInfo');
    console.log(`   Periapsis: ${(orbit.periapsis / 1000).toFixed(1)} km`);
    console.log(`   Apoapsis: ${(orbit.apoapsis / 1000).toFixed(1)} km\n`);

    // Create return node using library
    console.log('3. Creating return from moon node...');
    const result = await daemon.call<ManeuverResult>('returnFromMoon', {
      targetPeriapsis,
    });

    if (!result.success) {
      console.log('   Failed to create return node');
      console.log(`   ${result.error || 'Operation error'}`);
      return;
    }

    console.log('   Node created!\n');

    // Show node details from result
    console.log('4. Return node info...');
    console.log(`   ΔV: ${result.deltaV?.toFixed(1) || '?'} m/s in ${result.timeToNode?.toFixed(0) || '?'} seconds\n`);

    // Verify target orbit around parent body
    console.log('5. Verifying target orbit at parent body...');
    const verifyResult = await daemon.call<ExecuteResult>('execute', {
      command:
        'IF HASNODE { ' +
        '  SET O TO NEXTNODE:ORBIT. ' +
        '  SET PARENT TO SHIP:BODY:BODY. ' +
        '  PRINT "Target body: " + O:BODY:NAME. ' +
        '  IF O:HASNEXTPATCH { ' +
        '    SET NEXT TO O:NEXTPATCH. ' +
        '    PRINT "Next patch body: " + NEXT:BODY:NAME. ' +
        '    PRINT "Next patch periapsis: " + ROUND(NEXT:PERIAPSIS / 1000, 1) + " km". ' +
        '  } ELSE { ' +
        '    PRINT "No patch found (may need to check prediction after burn)". ' +
        '  } ' +
        '} ELSE { ' +
        '  PRINT "No node available". ' +
        '}',
    });
    console.log(`   ${verifyResult.output?.trim() || 'Unknown'}\n`);

    console.log('Node created! Use "npm run execute-node" to execute the return burn.\n');

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  }
}

main().catch(console.error);
