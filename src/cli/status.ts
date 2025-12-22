#!/usr/bin/env node
/**
 * Get ship status (orbit, nodes, encounters)
 * Usage: npm run status
 */

import * as daemon from './daemon-client.js';

async function main() {
  try {
    const telemetry = await daemon.call<string>('status');
    console.log(telemetry);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main().catch(console.error);
