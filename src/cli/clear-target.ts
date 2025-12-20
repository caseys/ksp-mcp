#!/usr/bin/env node
/**
 * Clear current target - thin wrapper around daemon handler
 * Usage: npm run clear-target
 */

import * as daemon from './daemon-client.js';
import type { ClearTargetResult } from '../lib/programs/maneuver.js';

async function main() {
  console.log('=== Clear Target ===\n');

  try {
    const result = await daemon.call<ClearTargetResult>('clearTarget');

    if (result.cleared) {
      console.log('✅ Target cleared.\n');
    } else {
      console.log(result.warning ?? '✅ Clear command sent.\n');
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(console.error);
