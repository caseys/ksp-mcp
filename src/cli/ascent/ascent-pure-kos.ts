#!/usr/bin/env tsx

/**
 * Pure kOS Ascent to 100km Orbit (No MechJeb required)
 *
 * This script performs a basic gravity turn ascent:
 * 1. Launch vertically
 * 2. Start gravity turn at ~1km
 * 3. Gradually pitch over following prograde
 * 4. Coast to apoapsis
 * 5. Circularize at apoapsis
 */

import { KosConnection } from '../../transport/kos-connection.js';

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const TARGET_ALTITUDE = 100000;  // 100km

  console.log('=== Pure kOS Ascent to 100km Orbit ===\n');

  const conn = new KosConnection();

  try {
    console.log('Connecting to kOS...');
    const state = await conn.connect();
    console.log(`Connected to: ${state.vesselName}\n`);
    await delay(500);

    // Check current status
    let result = await conn.execute('PRINT SHIP:STATUS.');
    console.log('Status:', result.output);

    const status = result.output.toLowerCase();
    if (!status.includes('prelaunch') && !status.includes('landed')) {
      console.log('Ship is not on the ground. This script is for launch.');
      await conn.disconnect();
      return;
    }

    console.log('\n--- Uploading ascent script to kOS ---');

    // Upload the ascent script as a series of commands
    // We'll use a simpler approach: send commands directly

    // Step 1: Setup
    console.log('Setting up launch parameters...');
    await conn.execute('SET targetApo TO 100000.');
    await conn.execute('SET turnStart TO 1000.');
    await conn.execute('SET turnEnd TO 45000.');
    await conn.execute('SAS OFF.');
    await conn.execute('RCS OFF.');
    await delay(300);

    // Step 2: Launch
    console.log('\n--- LAUNCHING ---');
    await conn.execute('LOCK THROTTLE TO 1.');
    await conn.execute('LOCK STEERING TO HEADING(90, 90).');  // Point up, heading east
    await delay(500);

    await conn.execute('STAGE.');  // Ignite engines
    console.log('Engine ignition!');
    await delay(1000);

    await conn.execute('STAGE.');  // Release clamps
    console.log('Liftoff!');

    // Step 3: Wait for turn altitude
    console.log('\n--- Ascending to turn altitude ---');
    let altitude = 0;
    while (altitude < 1000) {
      await delay(2000);
      result = await conn.execute('PRINT ROUND(ALTITUDE).');
      const match = result.output.match(/\d+/);
      if (match) altitude = parseInt(match[0]);
      console.log(`Altitude: ${altitude}m`);
    }

    // Step 4: Begin gravity turn
    console.log('\n--- Starting gravity turn ---');

    // Pitch program: gradually pitch over based on altitude
    // At 1km: 85°, at 10km: 45°, at 45km: 5°
    await conn.execute(`
      LOCK pitch TO 90 - (90 * (ALTITUDE - ${1000}) / (${45000} - ${1000})).
    `.trim());
    await conn.execute('LOCK STEERING TO HEADING(90, MAX(5, MIN(85, pitch))).');
    console.log('Following pitch program...');

    // Step 5: Monitor ascent until apoapsis reaches target
    console.log('\n--- Ascending to target apoapsis ---');
    let apoapsis = 0;
    while (apoapsis < TARGET_ALTITUDE) {
      await delay(3000);

      result = await conn.execute('PRINT ROUND(ALTITUDE/1000) + "km APO:" + ROUND(APOAPSIS/1000) + "km".');
      console.log(result.output.replace(/PRINT[^.]*\./, '').trim());

      result = await conn.execute('PRINT APOAPSIS.');
      const apoMatch = result.output.match(/[\d.]+/);
      if (apoMatch) apoapsis = parseFloat(apoMatch[0]);

      // Throttle down as we approach target
      if (apoapsis > TARGET_ALTITUDE * 0.9) {
        await conn.execute('LOCK THROTTLE TO 0.5.');
      }
      if (apoapsis > TARGET_ALTITUDE * 0.95) {
        await conn.execute('LOCK THROTTLE TO 0.1.');
      }
    }

    // Step 6: Cut throttle and coast to apoapsis
    console.log('\n--- Coasting to apoapsis ---');
    await conn.execute('LOCK THROTTLE TO 0.');
    await conn.execute('LOCK STEERING TO PROGRADE.');
    console.log('Engine cutoff. Coasting...');

    // Wait until near apoapsis
    let eta = 999;
    while (eta > 30) {
      await delay(5000);
      result = await conn.execute('PRINT "ETA APO: " + ROUND(ETA:APOAPSIS) + "s".');
      console.log(result.output.replace(/PRINT[^.]*\./, '').trim());

      result = await conn.execute('PRINT ETA:APOAPSIS.');
      const etaMatch = result.output.match(/[\d.]+/);
      if (etaMatch) eta = parseFloat(etaMatch[0]);
    }

    // Step 7: Circularization burn
    console.log('\n--- Circularization burn ---');
    await conn.execute('LOCK STEERING TO PROGRADE.');
    await delay(2000);

    // Calculate required delta-v for circular orbit
    // dV = sqrt(mu/r) - current_velocity (approximately)
    await conn.execute('LOCK THROTTLE TO 1.');
    console.log('Burning prograde...');

    // Burn until periapsis is above atmosphere
    let periapsis = -1000000;
    while (periapsis < 70000) {
      await delay(1000);
      result = await conn.execute('PRINT "APO:" + ROUND(APOAPSIS/1000) + "km PER:" + ROUND(PERIAPSIS/1000) + "km".');
      console.log(result.output.replace(/PRINT[^.]*\./, '').trim());

      result = await conn.execute('PRINT PERIAPSIS.');
      const perMatch = result.output.match(/-?[\d.]+/);
      if (perMatch) periapsis = parseFloat(perMatch[0]);
    }

    // Fine-tune
    await conn.execute('LOCK THROTTLE TO 0.1.');
    while (periapsis < 90000) {
      await delay(500);
      result = await conn.execute('PRINT PERIAPSIS.');
      const perMatch = result.output.match(/-?[\d.]+/);
      if (perMatch) periapsis = parseFloat(perMatch[0]);
    }

    // Cut engine
    await conn.execute('LOCK THROTTLE TO 0.');
    await conn.execute('UNLOCK STEERING.');
    await conn.execute('UNLOCK THROTTLE.');
    await conn.execute('SAS ON.');

    console.log('\n=== ORBIT ACHIEVED! ===');
    result = await conn.execute('PRINT "Final orbit: APO=" + ROUND(APOAPSIS/1000) + "km PER=" + ROUND(PERIAPSIS/1000) + "km".');
    console.log(result.output);

    await conn.disconnect();
    console.log('\nDone!');

  } catch (error) {
    console.error('\nError:', error);
    try {
      await conn.execute('LOCK THROTTLE TO 0.');
      await conn.execute('SAS ON.');
    } catch { /* ignore */ }
    await conn.disconnect();
    process.exit(1);
  }
}

main();
