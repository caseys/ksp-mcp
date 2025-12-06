#!/usr/bin/env node
/**
 * Execute the next maneuver node using MechJeb autopilot
 * Usage: npm run execute-node
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { executeNode, getNodeProgress } from '../../mechjeb/programs/node/index.js';

async function main() {
  console.log('=== Execute Maneuver Node ===\n');

  const conn = new KosConnection({
    cpuLabel: 'guidance',
  });

  try {
    console.log('1. Connecting to kOS...');
    await conn.connect();
    console.log('   Connected!\n');

    // Check if a node exists
    console.log('2. Checking for maneuver node...');
    const progress = await getNodeProgress(conn);
    if (progress.nodesRemaining === 0) {
      console.log('   No maneuver node found\n');
      console.log('Cannot execute - no node available');
      process.exit(1);
    }
    console.log(`   ${progress.nodesRemaining} node(s) found\n`);

    // Get node info
    console.log('3. Node details...');
    console.log(`   ETA: ${progress.etaToNode} seconds\n`);

    // Execute node using library
    console.log('4. Executing node with MechJeb...');
    console.log('   (Monitoring execution...)\n');

    const result = await executeNode(conn, 240000, 5000);

    if (result.success) {
      console.log(`\n✅ ${result.nodesExecuted} node(s) executed successfully!\n`);
    } else {
      console.log(`\n⚠️  ${result.error || 'Execution issue'}\n`);
      console.log('Node may still be executing. Check game manually.');
    }

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    await conn.disconnect();
    console.log('Disconnected.\n');
  }
}

main().catch(console.error);
