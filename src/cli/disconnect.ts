#!/usr/bin/env node
/**
 * Disconnect from kOS - thin wrapper
 * Usage: npm run disconnect
 *
 * Note: This is mainly useful for daemon mode. Direct CLI connections
 * auto-disconnect after each command anyway.
 */

import * as daemon from '../daemon/index.js';

async function main() {
  console.log('=== Disconnect from kOS ===\n');

  try {
    await daemon.disconnect();
    console.log('✅ Disconnected successfully.\n');
  } catch (error) {
    // If daemon isn't running, that's fine - we're disconnected anyway
    console.log('✅ Not connected (or daemon not running).\n');
  }
}

main().catch(console.error);
