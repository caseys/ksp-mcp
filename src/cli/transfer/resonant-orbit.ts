#!/usr/bin/env node
/**
 * Create resonant orbit for satellite constellations
 * Usage: npm run resonant-orbit <numerator> <denominator> [timeRef]
 * Example: npm run resonant-orbit 2 3 APOAPSIS  (2:3 resonance)
 *
 * Creates an orbit where period = (numerator/denominator) * current period.
 * Useful for deploying satellite constellations at evenly spaced intervals.
 */

import * as daemon from '../daemon-client.js';
import type { OrchestratedResult } from '../../lib/programs/orchestrator.js';
import type { OrbitInfo } from '../../lib/types.js';

async function main() {
  const numerator = process.argv[2] ? Number.parseInt(process.argv[2]) : null;
  const denominator = process.argv[3] ? Number.parseInt(process.argv[3]) : null;
  const timeRef = (process.argv[4]?.toUpperCase() || 'APOAPSIS') as string;

  if (numerator === null || denominator === null || isNaN(numerator) || isNaN(denominator)) {
    console.error('Usage: npm run resonant-orbit <numerator> <denominator> [timeRef]');
    console.error('Example: npm run resonant-orbit 2 3 APOAPSIS');
    console.error('Creates orbit where period = (numerator/denominator) * current period');
    process.exit(1);
  }

  console.log(`=== Resonant Orbit ===\n`);
  console.log(`Resonance ratio: ${numerator}:${denominator}`);
  console.log(`Execution point: ${timeRef}\n`);

  try {
    // Show current orbital period using library
    console.log('1. Current orbit...');
    const orbit = await daemon.call<OrbitInfo>('orbitInfo');
    console.log(`   Period: ${orbit.period.toFixed(0)} seconds\n`);

    // Create resonant orbit node using library
    console.log('2. Creating resonant orbit node...');
    const result = await daemon.call<OrchestratedResult>('resonantOrbit', {
      numerator,
      denominator,
      timeRef,
      execute: false,
    });

    if (!result.success) {
      console.log('   Failed to create resonant orbit node');
      console.log(`   ${result.error || 'Operation error'}`);
      return;
    }

    console.log('   Node created!\n');

    // Show node details from result
    console.log('3. Maneuver node info...');
    console.log(`   ΔV: ${result.deltaV?.toFixed(1) || '?'} m/s in ${result.timeToNode?.toFixed(0) || '?'} seconds\n`);

    console.log('✅ Node created! Use "npm run execute-node" to execute.\n');

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  }
}

main().catch(console.error);
