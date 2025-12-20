#!/usr/bin/env node
/**
 * Get kOS connection status - thin wrapper around daemon status
 * Usage: npm run status
 */

import * as daemon from '../daemon/index.js';

async function main() {
  console.log('=== kOS Connection Status ===\n');

  try {
    const status = await daemon.status();

    if (status.connected) {
      console.log(`Connected: ✅`);
      console.log(`CPU ID: ${status.cpuId ?? 'unknown'}`);
      console.log(`Vessel: ${status.vessel ?? 'unknown'}\n`);
    } else {
      console.log('Connected: ❌');
      console.log('Daemon not connected to kOS\n');
    }
  } catch (error) {
    console.log('Connected: ❌');
    console.log(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

main().catch(console.error);
