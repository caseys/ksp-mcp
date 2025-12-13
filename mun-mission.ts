#!/usr/bin/env tsx
/**
 * Mun Mission - Transfer from Kerbin orbit to Munar orbit
 */

import { KosConnection } from './src/transport/kos-connection.js';
import { MechJebClient } from './src/mechjeb/mechjeb-client.js';

async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const conn = new KosConnection();

  try {
    console.log('=== Mun Mission ===\n');

    // Connect
    console.log('1. Connecting to kOS...');
    const state = await conn.connect();
    console.log(`   Connected to: ${state.vesselName}\n`);

    const mj = new MechJebClient(conn);

    // Check current orbit
    console.log('2. Checking current orbit...');
    const orbitResult = await conn.execute(
      'PRINT "APO:" + ROUND(APOAPSIS/1000). PRINT "PER:" + ROUND(PERIAPSIS/1000).'
    );
    console.log(`   ${orbitResult.output.replace(/\n/g, ' ').trim()}\n`);

    // Set target to Mun
    console.log('3. Setting target to Mun...');
    await conn.execute('SET TARGET TO MUN.');
    const targetResult = await conn.execute('PRINT TARGET:NAME.');
    console.log(`   Target: ${targetResult.output.trim()}\n`);

    // Create Hohmann transfer
    console.log('4. Creating Hohmann transfer node...');
    const hohmannResult = await mj.maneuver.hohmannTransfer('COMPUTED', false);
    console.log(`   Result: ${hohmannResult ? 'Node created!' : 'Failed to create node'}\n`);

    if (!hohmannResult) {
      throw new Error('Failed to create Hohmann transfer node');
    }

    // Get node info
    const nodeResult = await conn.execute(
      'PRINT "Node dV:" + ROUND(NEXTNODE:DELTAV:MAG, 1) + "m/s". ' +
      'PRINT "ETA:" + ROUND(NEXTNODE:ETA) + "s".'
    );
    console.log(`   ${nodeResult.output.replace(/\n/g, ' ').trim()}\n`);

    // Execute the node
    console.log('5. Executing transfer burn...');
    const execResult = await mj.node.executeNext({ autowarp: true });
    console.log(`   Execution started: ${execResult}\n`);

    // Wait for execution
    console.log('6. Waiting for burn to complete...');
    let burning = true;
    while (burning) {
      await delay(5000);
      const statusResult = await conn.execute(
        'PRINT "ENABLED:" + ADDONS:MJ:NODE:ENABLED. PRINT "HASNODE:" + HASNODE.'
      );
      const enabled = statusResult.output.includes('ENABLED:True');
      const hasNode = statusResult.output.includes('HASNODE:True');

      if (!enabled && !hasNode) {
        burning = false;
        console.log('   Burn complete!\n');
      } else {
        console.log('   Burning...');
      }
    }

    // Check for Mun encounter
    console.log('7. Checking for Mun encounter...');
    const encounterResult = await conn.execute(
      'IF ORBIT:HASNEXTPATCH { PRINT "Encounter: " + ORBIT:NEXTPATCH:BODY:NAME. } ELSE { PRINT "No encounter yet". }'
    );
    console.log(`   ${encounterResult.output.trim()}\n`);

    // Wait for SOI change then circularize
    console.log('8. Waiting for Mun SOI...');
    console.log('   (This will take a while - warping...)\n');

    let inMunSOI = false;
    while (!inMunSOI) {
      await delay(10000);
      const bodyResult = await conn.execute('PRINT SHIP:BODY:NAME.');
      if (bodyResult.output.includes('Mun')) {
        inMunSOI = true;
        console.log('   Entered Mun SOI!\n');
      } else {
        console.log('   Still in Kerbin SOI, warping...');
        await conn.execute('SET WARPMODE TO "RAILS". SET WARP TO 4.');
      }
    }

    // Stop warp
    await conn.execute('SET WARP TO 0.');
    await delay(2000);

    // Create circularization node at periapsis
    console.log('9. Creating capture burn node...');
    const circResult = await mj.maneuver.circularize('PERIAPSIS');
    console.log(`   Result: ${circResult ? 'Node created!' : 'Failed'}\n`);

    // Execute capture burn
    console.log('10. Executing capture burn...');
    await mj.node.executeNext({ autowarp: true });

    // Wait for completion
    burning = true;
    while (burning) {
      await delay(3000);
      const statusResult = await conn.execute('PRINT ADDONS:MJ:NODE:ENABLED.');
      if (!statusResult.output.includes('True')) {
        burning = false;
      }
    }

    // Final orbit check
    console.log('\n=== MISSION COMPLETE ===');
    const finalOrbit = await conn.execute(
      'PRINT "Body: " + SHIP:BODY:NAME. ' +
      'PRINT "APO: " + ROUND(APOAPSIS/1000) + "km". ' +
      'PRINT "PER: " + ROUND(PERIAPSIS/1000) + "km".'
    );
    console.log(finalOrbit.output);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await conn.disconnect();
    console.log('\nDisconnected.');
  }
}

main();
