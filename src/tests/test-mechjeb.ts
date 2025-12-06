#!/usr/bin/env tsx

/**
 * Test MechJeb availability and ascent guidance API
 * Uses ADDONS:MJ syntax from kOS.MechJeb2.Addon
 */

import { KosConnection } from '../transport/kos-connection.js';

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('Testing MechJeb via kOS...\n');

  const conn = new KosConnection({ cpuId: 2 });  // CPU 2 = guidance

  try {
    console.log('Connecting to CPU 2 (guidance)...');
    const state = await conn.connect();
    console.log(`Connected to ${state.vesselName}\n`);

    await delay(500);

    // Check if MechJeb addon is available
    console.log('--- Checking MechJeb availability ---');
    let result = await conn.execute('PRINT ADDONS:MJ:AVAILABLE.');
    console.log('ADDONS:MJ:AVAILABLE:', result.output);

    await delay(300);

    // Try to access MechJeb core
    console.log('\n--- Checking MechJeb core ---');
    result = await conn.execute('PRINT ADDONS:MJ:CORE.');
    console.log('ADDONS:MJ:CORE:', result.output);

    await delay(300);

    // Get vessel info from MechJeb
    console.log('\n--- MechJeb Vessel Info ---');
    result = await conn.execute('PRINT ADDONS:MJ:VESSEL:SPEEDSURFACE.');
    console.log('Surface Speed:', result.output);

    result = await conn.execute('PRINT ADDONS:MJ:VESSEL:ALTITUDETRUE.');
    console.log('Altitude:', result.output);

    await delay(300);

    // Check ascent guidance
    console.log('\n--- Checking Ascent Module ---');
    result = await conn.execute('PRINT ADDONS:MJ:ASCENT.');
    console.log('ASCENT:', result.output);

    // Try to get ascent settings
    result = await conn.execute('PRINT ADDONS:MJ:ASCENT:DESIREDORBITALTITUDE.');
    console.log('Target Altitude:', result.output);

    console.log('\n--- Disconnecting ---');
    await conn.disconnect();
    console.log('Done!');

  } catch (error) {
    console.error('Error:', error);
    await conn.disconnect();
  }
}

main();
