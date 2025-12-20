#!/usr/bin/env node
/**
 * Set both periapsis and apoapsis with ELLIPTICIZE
 */

import * as daemon from '../../daemon/index.js';
import type { OrchestratedResult } from '../../mechjeb/programs/orchestrator.js';
import type { OrbitInfo } from '../../mechjeb/types.js';

async function main() {
  // Parse command line arguments
  const newPeA_km = parseFloat(process.argv[2]);
  const newApA_km = parseFloat(process.argv[3]);
  const timeRef = (process.argv[4] || 'APOAPSIS').toUpperCase();

  if (isNaN(newPeA_km) || isNaN(newApA_km)) {
    console.error('Usage: npm run ellipticize <newPeA_km> <newApA_km> [timeRef]');
    console.error('Example: npm run ellipticize 80 120 APOAPSIS');
    process.exit(1);
  }

  console.log(`=== ELLIPTICIZE: Pe ${newPeA_km} km, Ap ${newApA_km} km at ${timeRef} ===\n`);

  try {
    // Check current orbit using library
    console.log('1. Current orbit...');
    const orbit = await daemon.call<OrbitInfo>('orbitInfo');
    console.log(`   Periapsis: ${(orbit.periapsis / 1000).toFixed(1)} km`);
    console.log(`   Apoapsis: ${(orbit.apoapsis / 1000).toFixed(1)} km\n`);

    // Create ELLIPTICIZE node using library
    console.log(`2. Creating ELLIPTICIZE node (${timeRef.toLowerCase()})...`);
    const newPeA_m = newPeA_km * 1000;
    const newApA_m = newApA_km * 1000;
    const result = await daemon.call<OrchestratedResult>('ellipticize', {
      periapsis: newPeA_m,
      apoapsis: newApA_m,
      timeRef,
      execute: false,
    });

    if (!result.success) {
      console.log('   Failed to create ELLIPTICIZE node');
      console.log(`   ${result.error || 'Operation error'}`);
      return;
    }

    console.log('   Node created!\n');

    // Show node details from result
    console.log('3. Node info...');
    console.log(`   ΔV: ${result.deltaV?.toFixed(1) || '?'} m/s in ${result.timeToNode?.toFixed(0) || '?'} seconds\n`);

    console.log('✅ Node created! Use "npm run execute-node" to execute.');

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  }
}

main().catch(console.error);
