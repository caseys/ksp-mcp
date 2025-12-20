#!/usr/bin/env node
/**
 * Get current target info - thin wrapper around daemon handler
 * Usage: npm run get-target
 */

import * as daemon from './daemon-client.js';
import type { GetTargetInfo } from '../lib/programs/maneuver.js';

async function main() {
  console.log('=== Get Target ===\n');

  try {
    const info = await daemon.call<GetTargetInfo>('getTarget');

    if (info.hasTarget) {
      console.log(info.details ?? `Target: ${info.name}\n`);
    } else {
      console.log('No target set.\n');
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(console.error);
