#!/usr/bin/env node
/**
 * Clear all maneuver nodes - thin wrapper around nodes library
 * Usage: npm run clear-nodes
 */

import * as daemon from '../daemon/index.js';
import type { ClearNodesResult } from '../mechjeb/programs/nodes.js';

async function main() {
  console.log('=== Clear Maneuver Nodes ===\n');

  try {
    const result = await daemon.call<ClearNodesResult>('clearNodes');

    if (result.success) {
      console.log(`✅ Cleared ${result.nodesCleared} node(s)\n`);
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
