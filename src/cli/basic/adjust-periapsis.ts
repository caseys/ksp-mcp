#!/usr/bin/env node
/**
 * Change periapsis altitude
 * Usage: npm run adjust-periapsis <altitude_km> [timeRef] [--no-execute]
 */

import * as daemon from '../daemon-client.js';
import type { OrchestratedResult } from '../../lib/programs/orchestrator.js';
import type { OrbitInfo } from '../../lib/types.js';

async function main() {
  const args = process.argv.slice(2);
  const noExecute = args.includes('--no-execute');
  const positionalArgs = args.filter(a => !a.startsWith('--'));

  const altitudeKm = positionalArgs[0] ? Number.parseFloat(positionalArgs[0]) : null;
  const timeRef = (positionalArgs[1]?.toUpperCase() || 'APOAPSIS');

  if (altitudeKm === null) {
    console.error('Usage: npm run adjust-periapsis <altitude_km> [APOAPSIS|PERIAPSIS] [--no-execute]');
    console.error('Example: npm run adjust-periapsis 80 APOAPSIS');
    process.exit(1);
  }

  const altitude = altitudeKm * 1000;

  console.log(`=== Change Periapsis ===\n`);
  console.log(`Target periapsis: ${altitudeKm} km`);
  console.log(`Execution point: ${timeRef}`);
  console.log(`Execute: ${noExecute ? 'NO (plan only)' : 'YES'}\n`);

  try {
    // Check current orbit
    console.log('1. Current orbit...');
    const orbit = await daemon.call<OrbitInfo>('orbitInfo');
    console.log(`   Periapsis: ${(orbit.periapsis / 1000).toFixed(1)} km`);
    console.log(`   Apoapsis: ${(orbit.apoapsis / 1000).toFixed(1)} km\n`);

    // Create and optionally execute periapsis change
    console.log(`2. ${noExecute ? 'Creating' : 'Executing'} CHANGEPE node...`);
    const result = await daemon.call<OrchestratedResult>('adjustPeriapsis', {
      altitude,
      timeRef,
      execute: !noExecute,
    });

    if (!result.success) {
      console.log('   Failed to create node');
      console.log(`   ${result.error || 'Note: Cannot raise Pe above current Ap (orbital mechanics)'}`);
      return;
    }

    console.log(`   ΔV: ${result.deltaV?.toFixed(1) || '?'} m/s\n`);

    if (result.executed) {
      console.log('✅ Periapsis change complete!');
    } else {
      console.log('✅ Node created! Use "npm run execute-node" to execute.');
    }

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  }
}

main().catch(console.error);
