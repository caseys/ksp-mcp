#!/usr/bin/env node
/**
 * Course correction maneuver
 * Usage: npm run course-correct [target_pe_km] [--no-execute]
 */

import * as daemon from '../daemon-client.js';
import type { OrchestratedResult } from '../../lib/programs/orchestrator.js';
import type { GetTargetInfo } from '../../lib/programs/maneuver.js';

interface ExecuteResult {
  success: boolean;
  output?: string;
  error?: string;
}

async function main() {
  const args = process.argv.slice(2);
  const noExecute = args.includes('--no-execute');
  const positionalArg = args.find(a => !a.startsWith('--'));

  const targetPeKm = positionalArg ? Number.parseFloat(positionalArg) : 50;
  const targetDistance = targetPeKm * 1000;

  console.log(`=== Course Correction ===\n`);
  console.log(`Target periapsis: ${targetPeKm} km`);
  console.log(`Execute: ${noExecute ? 'NO (plan only)' : 'YES'}\n`);

  try {
    // Check if we have a target
    console.log('1. Checking target...');
    const targetInfo = await daemon.call<GetTargetInfo>('getTarget');
    if (!targetInfo.hasTarget) {
      console.log('   No target set. Set a target first.');
      return;
    }
    console.log(`   Target: ${targetInfo.name}\n`);

    // Check current trajectory
    console.log('2. Current trajectory...');
    const trajResult = await daemon.call<ExecuteResult>('execute', {
      command:
        'IF SHIP:ORBIT:HASNEXTPATCH { ' +
        '  PRINT "Current Pe at target: " + ROUND(SHIP:ORBIT:NEXTPATCH:PERIAPSIS/1000, 1) + " km". ' +
        '} ELSE { PRINT "No encounter with target". }',
    });
    console.log(`   ${trajResult.output?.trim() || 'Unknown'}\n`);

    // Create and optionally execute course correction
    console.log(`3. ${noExecute ? 'Creating' : 'Executing'} course correction node...`);
    const result = await daemon.call<OrchestratedResult>('courseCorrection', {
      targetDistance,
      execute: !noExecute,
    });

    if (!result.success) {
      console.log('   Failed to create node');
      console.log(`   ${result.error || 'Operation error'}`);
      return;
    }

    console.log(`   ΔV: ${result.deltaV?.toFixed(1) || '?'} m/s\n`);

    if (result.executed) {
      console.log('✅ Course correction complete!');
    } else {
      console.log('✅ Node created! Use "npm run execute-node" to execute.');
    }

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  }
}

main().catch(console.error);
