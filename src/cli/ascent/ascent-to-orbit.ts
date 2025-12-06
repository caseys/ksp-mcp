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

import { KosConnection } from '../../transport/kos-connection.js';
import { AscentProgram } from '../../mechjeb/programs/ascent.js';

async function main() {
  const TARGET_ALTITUDE = 100000;  // 100km
  const TARGET_INCLINATION = 0;    // Equatorial

  console.log('=== MechJeb Ascent to 100km Orbit ===\n');

  const conn = new KosConnection();

  try {
    // Connect to kOS
    console.log('1. Connecting to kOS...');
    const state = await conn.connect();
    console.log(`   Connected to: ${state.vesselName}\n`);

    // Check current status
    console.log('2. Checking vessel status...');
    const result = await conn.execute('PRINT SHIP:STATUS.');
    const status = result.output.toLowerCase();

    if (!status.includes('prelaunch') && !status.includes('landed')) {
      throw new Error('Ship must be on launchpad (PRELAUNCH or LANDED status)');
    }
    console.log('   Ship is on the launchpad. Preparing for ascent...\n');

    // Create ascent program using library
    console.log('3. Initializing MechJeb...');
    const ascent = new AscentProgram(conn);

    // Launch to orbit using library
    // This handles MechJeb initialization, configuration, and launch
    console.log(`4. Launching to ${TARGET_ALTITUDE / 1000}km orbit...\n`);
    const handle = await ascent.launchToOrbit({
      altitude: TARGET_ALTITUDE,
      inclination: TARGET_INCLINATION,
      autoStage: true,
      autoWarp: true
    });

    // Monitor progress until orbit is achieved
    console.log('5. Monitoring ascent (MechJeb is in control)...');
    console.log('   (Press Ctrl+C to stop monitoring)\n');

    const ascentResult = await handle.waitForCompletion();

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
      await conn.execute('UNLOCK THROTTLE.');
      await conn.execute('SAS ON.');
    } catch { /* ignore */ }
    process.exit(1);
  } finally {
    await conn.disconnect();
    console.log('Disconnected from kOS.');
  }
}

main();
