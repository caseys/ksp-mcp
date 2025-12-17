#!/usr/bin/env node
/**
 * Change orbital inclination
 * Usage: npm run change-inclination <target_degrees> [timeRef] [--no-execute]
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { ManeuverOrchestrator } from '../../mechjeb/programs/orchestrator.js';
import { getOrbitInfo } from '../../mechjeb/telemetry.js';

async function main() {
  // Parse arguments
  const args = process.argv.slice(2);
  const noExecute = args.includes('--no-execute');
  const positionalArgs = args.filter(a => !a.startsWith('--'));

  const targetInc = positionalArgs[0] ? parseFloat(positionalArgs[0]) : null;
  const timeRef = (positionalArgs[1]?.toUpperCase() || 'EQ_NEAREST_AD') as
    'EQ_ASCENDING' | 'EQ_DESCENDING' | 'EQ_NEAREST_AD' | 'EQ_HIGHEST_AD';

  if (targetInc === null) {
    console.error('Usage: npm run change-inclination <degrees> [timeRef] [--no-execute]');
    console.error('Example: npm run change-inclination 0 EQ_NEAREST_AD');
    process.exit(1);
  }

  console.log(`=== Change Inclination ===\n`);
  console.log(`Target inclination: ${targetInc}°`);
  console.log(`Execution point: ${timeRef}`);
  console.log(`Execute: ${noExecute ? 'NO (plan only)' : 'YES'}\n`);

  const conn = new KosConnection({ cpuLabel: 'guidance' });

  try {
    console.log('1. Connecting to kOS...');
    await conn.connect();
    console.log('   Connected!\n');

    // Check current orbit
    console.log('2. Current orbit...');
    const orbit = await getOrbitInfo(conn);
    console.log(`   Inclination: ${orbit.inclination.toFixed(2)}°`);
    console.log(`   Periapsis: ${(orbit.periapsis / 1000).toFixed(1)} km`);
    console.log(`   Apoapsis: ${(orbit.apoapsis / 1000).toFixed(1)} km\n`);

    // Create and optionally execute inclination change
    console.log(`3. ${noExecute ? 'Planning' : 'Executing'} inclination change...`);
    const orchestrator = new ManeuverOrchestrator(conn);
    const result = await orchestrator.changeInclination(targetInc, timeRef, { execute: !noExecute });

    if (!result.success) {
      console.log('   Failed');
      console.log(`   ${result.error || 'Operation error'}`);
      return;
    }

    console.log(`   ΔV: ${result.deltaV?.toFixed(1) || '?'} m/s\n`);

    if (result.executed) {
      console.log(`✅ Inclination changed to ${targetInc}°!`);
    } else {
      console.log('✅ Node created! Use "npm run execute-node" to execute.');
    }

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  } finally {
    await conn.disconnect();
    console.log('Disconnected.\n');
  }
}

main().catch(console.error);
