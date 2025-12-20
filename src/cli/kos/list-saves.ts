#!/usr/bin/env node
/**
 * List available KSP quicksaves - thin wrapper around daemon handler
 * Usage: npm run list-saves
 */

import * as daemon from '../daemon-client.js';
import type { ListSavesResult } from '../../lib/kos/kuniverse.js';

async function main() {
  console.log('=== Available Quicksaves ===\n');

  try {
    const result = await daemon.call<ListSavesResult>('listSaves');

    if (!result.success) {
      console.log(`Error: ${result.error}\n`);
      process.exit(1);
    }

    if (result.saves.length === 0) {
      console.log('No quicksaves found.\n');
    } else {
      console.log(`Found ${result.saves.length} save(s):\n`);
      for (const save of result.saves) {
        console.log(`  - ${save}`);
      }
      console.log();
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(console.error);
