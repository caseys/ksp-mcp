#!/usr/bin/env node
/**
 * Change orbital inclination
 * Usage: npm run change-inclination <target_degrees> [timeRef] [--no-execute]
 */

import * as daemon from '../daemon-client.js';
import type { OrchestratedResult } from '../../lib/programs/orchestrator.js';
import type { OrbitInfo } from '../../lib/types.js';

async function main() {
  // Parse arguments
  const args = process.argv.slice(2);
  const noExecute = args.includes('--no-execute');
  const positionalArgs = args.filter(a => !a.startsWith('--'));

  const newInclination = positionalArgs[0] ? Number.parseFloat(positionalArgs[0]) : null;
  const timeRef = (positionalArgs[1]?.toUpperCase() || 'EQ_NEAREST_AD');

  if (newInclination === null) {
    console.error('Usage: npm run change-inclination <degrees> [timeRef] [--no-execute]');
    console.error('Example: npm run change-inclination 0 EQ_NEAREST_AD');
    process.exit(1);
  }

  console.log(`=== Change Inclination ===\n`);
  console.log(`Target inclination: ${newInclination}°`);
  console.log(`Execution point: ${timeRef}`);
  console.log(`Execute: ${noExecute ? 'NO (plan only)' : 'YES'}\n`);

  try {
    // Check current orbit
    console.log('1. Current orbit...');
    const orbit = await daemon.call<OrbitInfo>('orbitInfo');
    console.log(`   Inclination: ${orbit.inclination.toFixed(2)}°`);
    console.log(`   Periapsis: ${(orbit.periapsis / 1000).toFixed(1)} km`);
    console.log(`   Apoapsis: ${(orbit.apoapsis / 1000).toFixed(1)} km\n`);

    // Create and optionally execute inclination change
    console.log(`2. ${noExecute ? 'Planning' : 'Executing'} inclination change...`);
    const result = await daemon.call<OrchestratedResult>('changeInclination', {
      newInclination,
      timeRef,
      execute: !noExecute,
    });

    if (!result.success) {
      console.log('   Failed');
      console.log(`   ${result.error || 'Operation error'}`);
      return;
    }

    console.log(`   ΔV: ${result.deltaV?.toFixed(1) || '?'} m/s\n`);

    if (result.executed) {
      console.log(`✅ Inclination changed to ${newInclination}°!`);
    } else {
      console.log('✅ Node created! Use "npm run execute-node" to execute.');
    }

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  }
}

main().catch(console.error);
