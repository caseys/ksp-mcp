#!/usr/bin/env node
/**
 * Execute Hohmann transfer to target
 * Usage: npm run hohmann [target] [--capture] [--no-execute]
 *   target: Target body name (default: Mun)
 *   --capture: Include capture burn
 *   --no-execute: Plan only, don't execute
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { ManeuverOrchestrator } from '../../mechjeb/programs/orchestrator.js';
import { getOrbitInfo } from '../../mechjeb/telemetry.js';

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

  const conn = new KosConnection({ cpuLabel: 'guidance' });

  try {
    console.log('1. Connecting to kOS...');
    await conn.connect();
    console.log('   Connected!\n');

    // Check current orbit
    console.log('2. Current orbit...');
    const orbit = await getOrbitInfo(conn);
    console.log(`   Periapsis: ${(orbit.periapsis / 1000).toFixed(1)} km`);
    console.log(`   Apoapsis: ${(orbit.apoapsis / 1000).toFixed(1)} km\n`);

    // Execute Hohmann transfer with target setting and optional execution
    console.log(`3. ${noExecute ? 'Planning' : 'Executing'} Hohmann transfer to ${targetName}...`);
    const orchestrator = new ManeuverOrchestrator(conn);
    const result = await orchestrator.hohmannTransfer('COMPUTED', capture, {
      target: targetName,
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
  } finally {
    await conn.disconnect();
    console.log('Disconnected.\n');
  }
}

main().catch(console.error);
