#!/usr/bin/env node
/**
 * Abort launch ascent guidance - thin wrapper around ascent library
 * Usage: npm run launch-ascent-abort
 */

import * as daemon from '../../daemon-client.js';

async function main() {
  console.log('=== Abort Launch Ascent ===\n');

  try {
    await daemon.call('abortAscent');
    console.log('✅ Ascent guidance disabled.\n');
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(console.error);
