#!/usr/bin/env node
/**
 * Set target in KSP via kOS
 * Usage: npm run set-target <name> [type]
 * Examples:
 *   npm run set-target Mun           # Auto-detect (tries body first)
 *   npm run set-target Mun body      # Explicitly set body
 *   npm run set-target "Station 1" vessel  # Set vessel by name
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { ManeuverProgram } from '../../mechjeb/programs/maneuver.js';

async function main() {
  const targetName = process.argv[2];
  const targetType = process.argv[3]?.toLowerCase() || 'auto';

  if (!targetName) {
    console.error('Error: Target name required');
    console.error('Usage: npm run set-target <name> [type]');
    console.error('  type: auto (default), body, vessel');
    process.exit(1);
  }

  console.log(`=== Set Target ===\n`);
  console.log(`Target: ${targetName}`);
  console.log(`Type: ${targetType}\n`);

  const conn = new KosConnection({
    cpuLabel: 'guidance',
  });

  try {
    console.log('1. Connecting to kOS...');
    await conn.connect();
    console.log('   Connected!\n');

    console.log('2. Setting target...');
    const maneuver = new ManeuverProgram(conn);

    // setTarget now includes built-in confirmation polling
    const result = await maneuver.setTarget(targetName, targetType as 'auto' | 'body' | 'vessel');

    if (!result.success) {
      console.log(`   ERROR: ${result.error ?? 'Target not found'}\n`);
      process.exit(1);
    }

    console.log(`   Target confirmed: ${result.name} (${result.type})\n`);

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    await conn.disconnect();
    console.log('Disconnected.\n');
  }
}

main().catch(console.error);
