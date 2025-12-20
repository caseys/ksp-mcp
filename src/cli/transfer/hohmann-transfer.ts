#!/usr/bin/env node
/**
 * Execute Hohmann transfer to target
 * Usage: npm run hohmann-transfer [target] [--capture] [--no-execute]
 *   target: Target body name (default: Mun)
 *   --capture: Include capture burn
 *   --no-execute: Plan only, don't execute
 */

import * as daemon from '../daemon-client.js';
import type { OrchestratedResult } from '../../lib/programs/orchestrator.js';
import type { OrbitInfo } from '../../lib/types.js';

async function main() {
  // Parse arguments
  const args = process.argv.slice(2);
  const capture = args.includes('--capture');
  const noExecute = args.includes('--no-execute');
  const targetName = args.find(a => !a.startsWith('--')) || 'Mun';

  console.log('=== Hohmann Transfer ===\n');
  console.log(`Target: ${targetName}`);
  console.log(`Capture burn: ${capture ? 'YES' : 'NO (transfer only)'}`);
  console.log(`Execute: ${noExecute ? 'NO (plan only)' : 'YES'}\n`);

  try {
    // Check current orbit
    console.log('1. Current orbit...');
    const orbit = await daemon.call<OrbitInfo>('orbitInfo');
    console.log(`   Periapsis: ${(orbit.periapsis / 1000).toFixed(1)} km`);
    console.log(`   Apoapsis: ${(orbit.apoapsis / 1000).toFixed(1)} km\n`);

    // Execute Hohmann transfer with target setting and optional execution
    console.log(`2. ${noExecute ? 'Planning' : 'Executing'} Hohmann transfer to ${targetName}...`);
    const result = await daemon.call<OrchestratedResult>('hohmannTransfer', {
      target: targetName,
      capture,
      execute: !noExecute,
    });

    if (!result.success) {
      console.log('   Failed to create transfer');
      console.log(`   ${result.error || 'Operation error'}`);
      return;
    }

    console.log(`   ΔV: ${result.deltaV?.toFixed(1) || '?'} m/s\n`);

    if (result.executed) {
      console.log(`✅ Transfer to ${targetName} complete!`);
    } else {
      console.log('✅ Node created! Use "npm run execute-node" to execute.');
    }

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  }
}

main().catch(console.error);
