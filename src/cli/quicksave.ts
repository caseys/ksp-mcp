#!/usr/bin/env node
/**
 * Create a KSP quicksave - thin wrapper around daemon handler
 * Usage: npm run quicksave [name]
 */

import * as daemon from './daemon-client.js';
import type { QuicksaveResult } from '../lib/kuniverse.js';

const saveName = process.argv[2] || 'quicksave';

async function main() {
  console.log('=== Create Quicksave ===\n');
  console.log(`Save name: ${saveName}\n`);

  try {
    const result = await daemon.call<QuicksaveResult>('quicksave', { saveName });

    if (result.success) {
      console.log(`✅ Saved: ${result.saveName}\n`);
    } else {
      console.log(`❌ ${result.error}\n`);
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(console.error);
