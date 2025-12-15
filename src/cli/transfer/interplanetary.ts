#!/usr/bin/env node
/**
 * Create interplanetary transfer to target body
 * Usage: npm run interplanetary <target> [waitForPhaseAngle]
 * Example: npm run interplanetary Duna true
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { ManeuverProgram } from '../../mechjeb/programs/maneuver.js';
import { interplanetaryTransfer } from '../../mechjeb/programs/transfer/index.js';

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
    console.log('3. Current position...');
    const stateResult = await conn.execute(
      'PRINT "Orbiting: " + SHIP:BODY:NAME. ' +
      'PRINT "Altitude: " + ROUND(SHIP:ALTITUDE / 1000, 1) + " km".'
    );
    console.log(`   ${stateResult.output.trim()}\n`);

    // Create interplanetary transfer node using library
    console.log('4. Creating interplanetary transfer node...');
    const result = await interplanetaryTransfer(conn, waitForPhaseAngle);

    if (!result.success) {
      console.log('   Failed to create transfer node');
      console.log(`   ${result.error || 'Operation error'}`);
      console.log('   Requirements:');
      console.log('   - Must be in orbit around a moon/planet (not atmosphere)');
      console.log('   - Target must orbit the same parent as current orbit\'s parent');
      console.log('   - Cannot transfer directly from Kerbin to its moons (use HOHMANN)');
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
