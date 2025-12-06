#!/usr/bin/env node
/**
 * Set both periapsis and apoapsis with ELLIPTICIZE
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { ellipticize } from '../../mechjeb/programs/basic/index.js';
import { getOrbitInfo } from '../../mechjeb/telemetry.js';

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

  const conn = new KosConnection({
    cpuLabel: 'guidance',
  });

  try {
    console.log('1. Connecting to kOS...');
    await conn.connect();
    console.log('   Connected!\n');

    // Check current orbit using library
    console.log('2. Current orbit...');
    const orbit = await getOrbitInfo(conn);
    console.log(`   Periapsis: ${(orbit.periapsis / 1000).toFixed(1)} km`);
    console.log(`   Apoapsis: ${(orbit.apoapsis / 1000).toFixed(1)} km\n`);

    // Create ELLIPTICIZE node using library
    console.log(`3. Creating ELLIPTICIZE node (${timeRef.toLowerCase()})...`);
    const newPeA_m = newPeA_km * 1000;
    const newApA_m = newApA_km * 1000;
    const result = await ellipticize(conn, newPeA_m, newApA_m, timeRef);

    if (!result.success) {
      console.log('   Failed to create ELLIPTICIZE node');
      console.log(`   ${result.error || 'Operation error'}`);
      return;
    }

    console.log('   Node created!\n');

    // Show node details from result
    console.log('4. Node info...');
    console.log(`   ΔV: ${result.deltaV?.toFixed(1) || '?'} m/s in ${result.timeToNode?.toFixed(0) || '?'} seconds\n`);

    console.log('✅ Node created! Use "npm run execute-node" to execute.');

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  } finally {
    await conn.disconnect();
    console.log('Disconnected.\n');
  }
}

main().catch(console.error);
