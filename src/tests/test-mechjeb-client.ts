#!/usr/bin/env tsx

/**
 * Test the MechJebClient interface
 *
 * Usage: npx tsx src/test-mechjeb-client.ts [--launch]
 *
 * Without --launch: Just tests discovery and telemetry
 * With --launch: Actually launches to 100km orbit
 */

import { KosConnection } from '../transport/kos-connection.js';
import { MechJebClient } from '../mechjeb/index.js';

async function main() {
  const doLaunch = process.argv.includes('--launch');

  console.log('=== MechJeb Client Test ===\n');

  // Connect to kOS
  const conn = new KosConnection({ cpuLabel: 'guidance' });

  try {
    console.log('Connecting to kOS (CPU: guidance)...');
    const state = await conn.connect();
    console.log(`Connected to: ${state.vesselName}\n`);

    // Create MechJeb client
    const mj = new MechJebClient(conn);

    // Test availability
    console.log('--- Checking MechJeb ---');
    const available = await mj.isAvailable();
    console.log(`MechJeb available: ${available}`);

    if (!available) {
      console.log('\nMechJeb is not available on this vessel.');
      console.log('Make sure:');
      console.log('  1. MechJeb part is on the vessel');
      console.log('  2. Only ONE MechJeb core is active');
      console.log('  3. kOS.MechJeb2.Addon is installed');
      console.log('  4. MechJeb2 DEV build is installed');
      await conn.disconnect();
      return;
    }

    // Discover modules
    console.log('\n--- Discovering Modules ---');
    const modules = await mj.discoverModules();
    console.log(`Version: ${modules.version ?? 'unknown'}`);
    console.log(`Has Ascent: ${modules.hasAscent}`);
    console.log(`Has Landing: ${modules.hasLanding}`);
    console.log(`Has Maneuver: ${modules.hasManeuver}`);
    console.log(`Has Rendezvous: ${modules.hasRendezvous}`);
    console.log(`All suffixes: ${modules.allSuffixes.join(', ')}`);

    // Test telemetry
    console.log('\n--- Testing Telemetry ---');

    console.log('\nQuick status:');
    const quick = await mj.getQuickStatus();
    console.log(`  Altitude: ${Math.round(quick.altitude)}m`);
    console.log(`  Apoapsis: ${Math.round(quick.apoapsis)}m`);
    console.log(`  Periapsis: ${Math.round(quick.periapsis)}m`);
    console.log(`  Speed: ${Math.round(quick.speed)}m/s`);

    console.log('\nMechJeb info:');
    const info = await mj.getInfo();
    console.log(`  Surface TWR: ${info.surfaceTWR.toFixed(2)}`);
    console.log(`  Max Thrust: ${Math.round(info.maxThrust)}kN`);
    console.log(`  Acceleration: ${info.acceleration.toFixed(2)}m/s²`);

    // Explore actual API paths
    console.log('\n--- Exploring API Paths ---');

    // Check if ASCENTGUIDANCE is the correct path
    console.log('\nTrying ASCENTGUIDANCE path:');
    try {
      const agResult = await conn.execute('PRINT ADDONS:MJ:ASCENTGUIDANCE:SUFFIXNAMES.', 3000);
      console.log(`  ASCENTGUIDANCE suffixes available`);
      // Parse and show first few
      const agSuffixes = agResult.output.match(/\["value"\]\s*=\s*"([^"]+)"/g);
      if (agSuffixes) {
        console.log(`  First 5: ${agSuffixes.slice(0, 5).map(s => s.replace(/.*"(\w+)".*/, '$1')).join(', ')}`);
      }
    } catch (e) {
      console.log(`  ASCENTGUIDANCE path failed`);
    }

    // Check if ASCENT is also valid
    console.log('\nTrying ASCENT path:');
    try {
      const aResult = await conn.execute('PRINT ADDONS:MJ:ASCENT:SUFFIXNAMES.', 3000);
      console.log(`  ASCENT suffixes available`);
    } catch (e) {
      console.log(`  ASCENT path not available`);
    }

    // Check INFO path
    console.log('\nTrying INFO path:');
    try {
      const infoResult = await conn.execute('PRINT ADDONS:MJ:INFO:SUFFIXNAMES.', 3000);
      console.log(`  INFO suffixes available`);
      const infoSuffixes = infoResult.output.match(/\["value"\]\s*=\s*"([^"]+)"/g);
      if (infoSuffixes) {
        console.log(`  First 5: ${infoSuffixes.slice(0, 5).map(s => s.replace(/.*"(\w+)".*/, '$1')).join(', ')}`);
      }
    } catch (e) {
      console.log(`  INFO path failed`);
    }

    // Launch test (only if --launch flag)
    if (doLaunch) {
      console.log('\n--- LAUNCHING TO ORBIT ---');
      console.log('Target: 100km circular orbit, 0° inclination\n');

      const handle = await mj.ascent.launchToOrbit({
        altitude: 100000,
        inclination: 0,
        autoStage: true
      });

      console.log(`Launch handle: ${handle.id}`);
      console.log('Monitoring progress...\n');

      const result = await handle.waitForCompletion(3000);

      console.log('\n--- RESULT ---');
      console.log(`Success: ${result.success}`);
      console.log(`Aborted: ${result.aborted}`);
      console.log(`Final orbit: ${Math.round(result.finalOrbit.apoapsis / 1000)}km x ${Math.round(result.finalOrbit.periapsis / 1000)}km`);
    } else {
      console.log('\n--- Skipping launch (use --launch to actually launch) ---');
    }

    await conn.disconnect();
    console.log('\nDisconnected.');

  } catch (error) {
    console.error('\nError:', error);
    await conn.disconnect();
    process.exit(1);
  }
}

main();
