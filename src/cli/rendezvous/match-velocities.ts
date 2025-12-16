#!/usr/bin/env node
/**
 * Match velocities with target vessel
 * This command creates the node AND auto-executes it
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { ManeuverProgram } from '../../mechjeb/programs/maneuver.js';
import { killRelativeVelocity } from '../../mechjeb/programs/rendezvous/index.js';
import { executeNode } from '../../mechjeb/programs/node/index.js';

async function main() {
  console.log('=== Match Velocities with Target ===\n');

  const conn = new KosConnection({
    cpuLabel: 'guidance',
  });

  try {
    console.log('1. Connecting to kOS...');
    await conn.connect();
    console.log('   Connected!\n');

    // Verify target is set
    console.log('2. Verifying target...');
    const maneuver = new ManeuverProgram(conn);
    const target = await maneuver.getTarget();
    if (!target) {
      console.log('   No target set! Use "npm run set-target" first.');
      return;
    }
    console.log(`   Target: ${target}\n`);

    // Check relative velocity
    console.log('3. Current relative velocity...');
    const relVelResult = await conn.execute(
      'SET RELVEL TO TARGET:VELOCITY:ORBIT - SHIP:VELOCITY:ORBIT. ' +
      'PRINT "Relative velocity: " + ROUND(RELVEL:MAG, 1) + " m/s".'
    );
    console.log(`   ${relVelResult.output.trim()}\n`);

    // Create match velocities node using library
    console.log('4. Creating match velocities node (at closest approach)...');
    const nodeResult = await killRelativeVelocity(conn, 'CLOSEST_APPROACH');

    if (!nodeResult.success) {
      console.log('   Failed to create match velocities node');
      console.log(`   ${nodeResult.error || 'Operation error'}`);
      return;
    }

    console.log('   Node created!\n');

    // Show node details
    console.log('5. Match velocities node info...');
    console.log(`   ΔV: ${nodeResult.deltaV?.toFixed(1) || '?'} m/s in ${nodeResult.timeToNode?.toFixed(0) || '?'} seconds\n`);

    // Execute node using library
    console.log('6. Executing node with MechJeb...');
    console.log('   (Monitoring execution...)\n');

    const execResult = await executeNode(conn, { timeoutMs: 240000, pollIntervalMs: 5000 });

    if (execResult.success) {
      console.log('✅ Match velocities executed!\n');
    } else {
      console.log(`   Execution issue: ${execResult.error || 'Unknown error'}\n`);
    }

    // Final verification
    console.log('7. Final relative velocity...');
    const finalRelVel = await conn.execute(
      'SET RELVEL TO TARGET:VELOCITY:ORBIT - SHIP:VELOCITY:ORBIT. ' +
      'PRINT "Relative velocity: " + ROUND(RELVEL:MAG, 1) + " m/s".'
    );
    console.log(`   ${finalRelVel.output.trim()}\n`);

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  } finally {
    await conn.disconnect();
    console.log('Disconnected.\n');
  }
}

main().catch(console.error);
