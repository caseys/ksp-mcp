#!/usr/bin/env node
/**
 * Create interplanetary transfer to target body
 * Usage: npm run interplanetary <target> [waitForPhaseAngle]
 * Example: npm run interplanetary Duna true
 */

import * as daemon from '../../daemon-client.js';
import type { ManeuverResult } from '../../../lib/mechjeb/maneuver.js';
import type { SetTargetResult } from '../../../lib/mechjeb/maneuver.js';

interface ExecuteResult {
  success: boolean;
  output?: string;
  error?: string;
}

async function main() {
  const targetName = process.argv[2];
  const waitStr = process.argv[3]?.toLowerCase() || 'true';
  const waitForPhaseAngle = waitStr === 'true' || waitStr === '1';

  if (!targetName) {
    console.error('Usage: npm run interplanetary <target> [waitForPhaseAngle]');
    console.error('Example: npm run interplanetary Duna true');
    console.error('         npm run interplanetary Eeloo false  (ASAP mode)');
    console.error('waitForPhaseAngle: true=optimal window, false=ASAP (suboptimal)');
    process.exit(1);
  }

  console.log(`=== Interplanetary Transfer ===\n`);
  console.log(`Target: ${targetName}`);
  console.log(`Wait for phase angle: ${waitForPhaseAngle}\n`);

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
    console.log('2. Current position...');
    const stateResult = await daemon.call<ExecuteResult>('execute', {
      command:
        'PRINT "Orbiting: " + SHIP:BODY:NAME. ' +
        'PRINT "Altitude: " + ROUND(SHIP:ALTITUDE / 1000, 1) + " km".',
    });
    console.log(`   ${stateResult.output?.trim() || 'Unknown'}\n`);

    // Create interplanetary transfer node using library
    console.log('3. Creating interplanetary transfer node...');
    const result = await daemon.call<ManeuverResult>('interplanetaryTransfer', {
      waitForPhaseAngle,
    });

    if (!result.success) {
      console.log('   Failed to create transfer node');
      console.log(`   ${result.error || 'Operation error'}`);
      console.log('   Requirements:');
      console.log('   - Must be in orbit around a moon/planet (not atmosphere)');
      console.log("   - Target must orbit the same parent as current orbit's parent");
      console.log('   - Cannot transfer directly from Kerbin to its moons (use HOHMANN)');
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
