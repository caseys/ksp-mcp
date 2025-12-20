#!/usr/bin/env node
/**
 * Get ship telemetry - thin wrapper around telemetry library
 * Usage: npm run telemetry
 */

import * as daemon from '../daemon-client.js';

async function main() {
  console.log('=== Ship Telemetry ===\n');

  try {
    const telemetry = await daemon.call<string>('telemetry');
    console.log(telemetry);
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(console.error);
