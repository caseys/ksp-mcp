#!/usr/bin/env node
/**
 * Match velocities with target (kill relative velocity)
 * Usage: npm run match-velocities [target] [timeRef] [--no-execute]
 * Examples:
 *   npm run match-velocities                           # Uses current target, auto-executes
 *   npm run match-velocities MUN                       # Targets Mun, auto-executes
 *   npm run match-velocities "Vessel Name"             # Targets specific vessel
 *   npm run match-velocities MUN CLOSEST_APPROACH      # Explicit timeRef
 *   npm run match-velocities -- --no-execute           # Create node only, don't execute
 */

import * as daemon from '../daemon-client.js';
import type { OrchestratedResult } from '../../lib/programs/orchestrator.js';
import type { SetTargetResult, GetTargetInfo } from '../../lib/programs/maneuver.js';

interface ExecuteResult {
  success: boolean;
  output?: string;
  error?: string;
}

async function main() {
  // Parse args (skip --no-execute for positional parsing)
  const args = process.argv.slice(2).filter(a => a !== '--no-execute');
  const targetName = args[0];
  const timeRef = (args[1]?.toUpperCase() || 'CLOSEST_APPROACH') as
    'CLOSEST_APPROACH' | 'X_FROM_NOW';
  const shouldExecute = !process.argv.includes('--no-execute');

  console.log(`=== Match Velocities with Target ===\n`);
  if (targetName) console.log(`Target: ${targetName}`);
  console.log(`Execution point: ${timeRef}`);
  console.log(`Auto-execute: ${shouldExecute}\n`);

  try {
    // Set or verify target
    console.log('1. Setting/verifying target...');

    if (targetName) {
      const targetResult = await daemon.call<SetTargetResult>('setTarget', {
        name: targetName,
        type: 'auto',
      });
      if (!targetResult.success) {
        console.log(`   ERROR: ${targetResult.error ?? 'Failed to set target'}`);
        return;
      }
      console.log(`   Target set to: ${targetResult.name} (${targetResult.type})\n`);
    } else {
      const targetInfo = await daemon.call<GetTargetInfo>('getTarget');
      if (!targetInfo.hasTarget) {
        console.log('   No target set! Provide target name or use "npm run set-target" first.');
        return;
      }
      console.log(`   Using current target: ${targetInfo.name}\n`);
    }

    // Check relative velocity
    console.log('2. Current relative velocity...');
    const relVelResult = await daemon.call<ExecuteResult>('execute', {
      command:
        'SET RELVEL TO TARGET:VELOCITY:ORBIT - SHIP:VELOCITY:ORBIT. ' +
        'PRINT "Relative velocity: " + ROUND(RELVEL:MAG, 1) + " m/s".',
    });
    console.log(`   ${relVelResult.output?.trim() || 'Unknown'}\n`);

    // Create match velocities node using orchestrator
    console.log(`3. ${shouldExecute ? 'Executing' : 'Creating'} match velocities maneuver (at ${timeRef.toLowerCase().replace('_', ' ')})...`);
    const result = await daemon.call<OrchestratedResult>('matchVelocities', {
      timeRef,
      execute: shouldExecute,
    });

    if (!result.success) {
      console.log('   Failed to create match velocities node');
      console.log(`   ${result.error || 'Operation error'}`);
      return;
    }

    // Show node details
    console.log(`   ΔV: ${result.deltaV?.toFixed(1) || '?'} m/s\n`);

    if (result.executed) {
      console.log('✅ Match velocities executed!\n');

      // Final verification
      console.log('4. Final relative velocity...');
      const finalRelVel = await daemon.call<ExecuteResult>('execute', {
        command:
          'SET RELVEL TO TARGET:VELOCITY:ORBIT - SHIP:VELOCITY:ORBIT. ' +
          'PRINT "Relative velocity: " + ROUND(RELVEL:MAG, 1) + " m/s".',
      });
      console.log(`   ${finalRelVel.output?.trim() || 'Unknown'}\n`);
    } else {
      console.log('✅ Node created! Use "npm run execute-node" to execute.\n');
    }

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  }
}

main().catch(console.error);
