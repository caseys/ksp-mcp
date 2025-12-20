#!/usr/bin/env node
/**
 * Get launch ascent progress - thin wrapper around ascent library
 * Usage: npm run launch-ascent-status
 */

import * as daemon from '../../daemon-client.js';
import type { AscentProgress } from '../../../lib/types.js';

const phaseDescriptions: Record<string, string> = {
  prelaunch: 'On launchpad',
  launching: 'Initial launch',
  gravity_turn: 'Gravity turn in progress',
  coasting: 'Coasting to apoapsis',
  circularizing: 'Circularization burn',
  complete: 'In orbit!',
  unknown: 'Unknown phase',
};

async function main() {
  console.log('=== Launch Ascent Status ===\n');

  try {
    const progress = await daemon.call<AscentProgress>('getAscentProgress');

    console.log(`Phase: ${phaseDescriptions[progress.phase] || progress.phase}`);
    console.log(`MechJeb Ascent: ${progress.enabled ? 'ENABLED' : 'disabled'}`);
    console.log(`Altitude: ${(progress.altitude / 1000).toFixed(1)} km`);
    console.log(`Apoapsis: ${(progress.apoapsis / 1000).toFixed(1)} km`);
    console.log(`Periapsis: ${(progress.periapsis / 1000).toFixed(1)} km`);
    console.log(`Ship Status: ${progress.shipStatus}\n`);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(console.error);
