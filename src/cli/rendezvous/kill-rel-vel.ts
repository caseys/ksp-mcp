#!/usr/bin/env node
/**
 * Kill relative velocity with target
 * Usage: npm run kill-rel-vel [target] [timeRef]
 * Examples:
 *   npm run kill-rel-vel                    # Uses Mun as target
 *   npm run kill-rel-vel "Vessel Name"      # Targets specific vessel
 *   npm run kill-rel-vel MUN CLOSEST_APPROACH
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { ManeuverProgram } from '../../mechjeb/programs/maneuver.js';
import { killRelativeVelocity } from '../../mechjeb/programs/rendezvous/index.js';

async function main() {
  const targetName = process.argv[2] || 'MUN';
  const timeRef = (process.argv[3]?.toUpperCase() || 'CLOSEST_APPROACH') as
    'CLOSEST_APPROACH' | 'X_FROM_NOW';

  console.log(`=== Kill Relative Velocity ===\n`);
  console.log(`Target: ${targetName}`);
  console.log(`Execution point: ${timeRef}\n`);

  const conn = new KosConnection({
    cpuLabel: 'guidance',
  });

  try {
    console.log('1. Connecting to kOS...');
    await conn.connect();
    console.log('   Connected!\n');

    // Set target using library ('auto' tries body first, then vessel)
    console.log(`2. Setting target to ${targetName}...`);
    const maneuver = new ManeuverProgram(conn);
    const targetResult = await maneuver.setTarget(targetName, 'auto');

    if (!targetResult.success) {
      console.log(`   ERROR: ${targetResult.error ?? 'Failed to set target'}`);
      return;
    }
    console.log(`   Target set to: ${targetResult.name} (${targetResult.type})\n`);

    // Check relative velocity
    console.log('3. Checking relative velocity...');
    const relVelResult = await conn.execute(
      'SET RELVEL TO TARGET:VELOCITY:ORBIT - SHIP:VELOCITY:ORBIT. ' +
      'PRINT "Relative velocity: " + ROUND(RELVEL:MAG, 1) + " m/s".'
    );
    console.log(`   ${relVelResult.output.trim()}\n`);

    // Create kill relative velocity node using library
    console.log(`4. Creating KILLRELVEL node (burn at ${timeRef.toLowerCase()})...`);
    const result = await killRelativeVelocity(conn, timeRef);

    if (!result.success) {
      console.log('   Failed to create node');
      console.log(`   ${result.error || 'Operation error'}`);
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
