#!/usr/bin/env node
/**
 * Circularize orbit at apoapsis or periapsis
 * Usage: npm run circularize [APOAPSIS|PERIAPSIS] [--no-execute]
 */

import * as daemon from '../daemon-client.js';
import type { OrchestratedResult } from '../../lib/programs/orchestrator.js';
import type { OrbitInfo } from '../../lib/types.js';

async function main() {
  // Parse arguments
  const args = process.argv.slice(2);
  const noExecute = args.includes('--no-execute');
  const timeRefArg = args.find(a => !a.startsWith('--'))?.toUpperCase();
  const timeRef = timeRefArg || 'APOAPSIS';

  if (timeRefArg && !['APOAPSIS', 'PERIAPSIS'].includes(timeRef)) {
    console.error('Usage: npm run circularize [APOAPSIS|PERIAPSIS] [--no-execute]');
    process.exit(1);
  }

  console.log(`=== Circularize at ${timeRef} ===\n`);
  console.log(`Execute: ${noExecute ? 'NO (plan only)' : 'YES'}\n`);

  try {
    // Check current orbit
    console.log('1. Current orbit...');
    const orbit = await daemon.call<OrbitInfo>('orbitInfo');
    console.log(`   Periapsis: ${(orbit.periapsis / 1000).toFixed(1)} km`);
    console.log(`   Apoapsis: ${(orbit.apoapsis / 1000).toFixed(1)} km\n`);

    // Create and optionally execute circularize node
    console.log(`2. ${noExecute ? 'Creating' : 'Executing'} circularize maneuver...`);
    const result = await daemon.call<OrchestratedResult>('circularize', {
      timeRef,
      execute: !noExecute,
    });

    if (!result.success) {
      console.log('   Failed to circularize');
      console.log(`   ${result.error || 'Operation error'}`);
      return;
    }

    console.log(`   ΔV: ${result.deltaV?.toFixed(1) || '?'} m/s\n`);

    if (result.executed) {
      console.log('✅ Circularization complete!');
    } else {
      console.log('✅ Node created! Use "npm run execute-node" to execute.');
    }

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  }
}

main().catch(console.error);
