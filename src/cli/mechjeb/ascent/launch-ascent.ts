#!/usr/bin/env tsx

/**
 * MechJeb Ascent to 100km Orbit
 *
 * This script:
 * 1. Connects to kOS and waits for MechJeb to be ready
 * 2. Configures MechJeb ascent guidance for 100km orbit
 * 3. Engages the autopilot and launches
 * 4. Monitors progress until orbit is achieved
 */

import * as daemon from '../../daemon-client.js';
import type { AscentResult } from '../../../lib/types.js';

interface ExecuteResult {
  success: boolean;
  output?: string;
  error?: string;
}

async function main() {
  const TARGET_ALTITUDE = 100_000;  // 100km
  const TARGET_INCLINATION = 0;    // Equatorial

  console.log('=== MechJeb Ascent to 100km Orbit ===\n');

  try {
    // Check current status
    console.log('1. Checking vessel status...');
    const result = await daemon.call<ExecuteResult>('execute', {
      command: 'PRINT SHIP:STATUS.',
    });
    const status = result.output?.toLowerCase() || '';

    if (!status.includes('prelaunch') && !status.includes('landed')) {
      throw new Error('Ship must be on launchpad (PRELAUNCH or LANDED status)');
    }
    console.log('   Ship is on the launchpad. Preparing for ascent...\n');

    // Launch to orbit using library
    // This handles MechJeb initialization, configuration, and launch
    console.log(`2. Launching to ${TARGET_ALTITUDE / 1000}km orbit...`);
    console.log('   (MechJeb is in control - this may take several minutes)\n');

    const ascentResult = await daemon.call<AscentResult>('launchAscent', {
      altitude: TARGET_ALTITUDE,
      inclination: TARGET_INCLINATION,
      autoStage: true,
      autoWarp: true,
    });

    if (ascentResult.success) {
      console.log('\n=== ORBIT ACHIEVED! ===');
      console.log(`Final orbit: APO=${Math.round(ascentResult.finalOrbit.apoapsis/1000)}km PER=${Math.round(ascentResult.finalOrbit.periapsis/1000)}km`);
    } else if (ascentResult.aborted) {
      console.log('\n=== ASCENT ABORTED ===');
    } else {
      console.log('\n=== ASCENT FAILED ===');
      console.log(`Final orbit: APO=${Math.round(ascentResult.finalOrbit.apoapsis/1000)}km PER=${Math.round(ascentResult.finalOrbit.periapsis/1000)}km`);
    }

    console.log('\n--- Complete ---');

  } catch (error) {
    console.error('\nError:', error instanceof Error ? error.message : String(error));
    // Try to safe the vessel
    try {
      await daemon.call('execute', { command: 'UNLOCK THROTTLE.' });
      await daemon.call('execute', { command: 'SAS ON.' });
    } catch { /* ignore */ }
    process.exit(1);
  }
}

main();
