#!/usr/bin/env tsx

/**
 * Manual test script for kOS connection
 * Run with: npx tsx src/test-connection.ts
 */

import { KosConnection } from '../transport/kos-connection.js';

function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('Testing kOS connection...\n');

  const conn = new KosConnection();

  try {
    console.log('Connecting...');
    const state = await conn.connect();
    console.log('Connected!', state);

    // Small delay for terminal to settle
    await delay(500);

    console.log('\n--- Test 1: Simple print ---');
    const result = await conn.execute('PRINT "Hello from ksp-mcp!".');
    console.log('Output:', result.output);
    console.log('Success:', result.success);

    await delay(300);

    console.log('\n--- Test 2: Get ship name ---');
    const shipResult = await conn.execute('PRINT SHIP:NAME.');
    console.log('Output:', shipResult.output);

    await delay(300);

    console.log('\n--- Test 3: Get altitude ---');
    const altResult = await conn.execute('PRINT "ALT: " + ROUND(ALTITUDE).');
    console.log('Output:', altResult.output);

    await delay(300);

    console.log('\n--- Test 4: Get orbit info ---');
    const orbitResult = await conn.execute('PRINT "APO: " + ROUND(APOAPSIS) + " PER: " + ROUND(PERIAPSIS).');
    console.log('Output:', orbitResult.output);

    console.log('\n--- Disconnecting ---');
    await conn.disconnect();
    console.log('Done!');
  } catch (error) {
    console.error('Error:', error);
    await conn.disconnect();
  }
}

main();
