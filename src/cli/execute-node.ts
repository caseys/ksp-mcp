#!/usr/bin/env node
/**
 * Execute the next maneuver node using MechJeb autopilot
 * Usage: npm run execute-node
 */

import * as daemon from './daemon-client.js';
import type { ExecuteNodeProgress, ExecuteNodeResult } from '../lib/programs/node/index.js';

async function main() {
  console.log('=== Execute Maneuver Node ===\n');

  try {
    // Check if a node exists
    console.log('1. Checking for maneuver node...');
    const progress = await daemon.call<ExecuteNodeProgress>('getNodeProgress');
    if (progress.nodesRemaining === 0) {
      console.log('   No maneuver node found\n');
      console.log('Cannot execute - no node available');
      process.exit(1);
    }
    console.log(`   ${progress.nodesRemaining} node(s) found\n`);

    // Get node info
    console.log('2. Node details...');
    console.log(`   ETA: ${progress.etaToNode} seconds\n`);

    // Execute node using library
    console.log('3. Executing node with MechJeb...');
    console.log('   (Monitoring execution...)\n');

    const result = await daemon.call<ExecuteNodeResult>('executeNode', {
      timeoutMs: 240_000,
      pollIntervalMs: 5000,
    });

    if (result.success) {
      console.log(`\n✅ ${result.nodesExecuted} node(s) executed successfully!\n`);
    } else {
      console.log(`\n⚠️  ${result.error || 'Execution issue'}\n`);
      console.log('Node may still be executing. Check game manually.');
    }

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(console.error);
