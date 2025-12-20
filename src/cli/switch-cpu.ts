#!/usr/bin/env node
/**
 * Switch to a different kOS CPU - thin wrapper around CPU preference
 * Usage:
 *   npm run switch-cpu 2           # Switch to CPU ID 2
 *   npm run switch-cpu guidance    # Switch to CPU with label "guidance"
 *   npm run switch-cpu --clear     # Clear preference, revert to auto-select
 */

import { setCpuPreference, getCpuPreference } from '../transport/connection-tools.js';
import * as daemon from './daemon-client.js';

const arg = process.argv[2];

async function main() {
  console.log('=== Switch kOS CPU ===\n');

  if (!arg) {
    // Show current preference
    const pref = getCpuPreference();
    if (pref) {
      const desc = pref.cpuLabel ? `label="${pref.cpuLabel}"` : `id=${pref.cpuId}`;
      console.log(`Current preference: ${desc}\n`);
    } else {
      console.log('No preference set (auto-select).\n');
    }
    return;
  }

  if (arg === '--clear' || arg === 'clear') {
    setCpuPreference(null);
    try {
      await daemon.disconnect();
    } catch {
      // Daemon may not be running
    }
    console.log('✅ CPU preference cleared. Will auto-select on next connection.\n');
    return;
  }

  // Check if numeric ID or label
  const numericId = Number.parseInt(arg, 10);
  if (isNaN(numericId)) {
    setCpuPreference({ cpuLabel: arg });
    console.log(`✅ Switched to CPU label "${arg}"\n`);
  } else {
    setCpuPreference({ cpuId: numericId });
    console.log(`✅ Switched to CPU ID ${numericId}\n`);
  }

  // Disconnect daemon so it reconnects with new preference
  try {
    await daemon.disconnect();
  } catch {
    // Daemon may not be running
  }
}

main().catch(console.error);
