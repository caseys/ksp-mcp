#!/usr/bin/env node
/**
 * Time warp CLI - thin wrapper around warp library
 * Usage:
 *   npm run warp node [leadTime]   - Warp to next maneuver node (default 60s before)
 *   npm run warp soi [leadTime]    - Warp to next SOI change
 *   npm run warp periapsis         - Warp to periapsis
 *   npm run warp apoapsis          - Warp to apoapsis
 *   npm run warp <seconds>         - Warp forward by N seconds
 */

import { KosConnection } from '../../transport/kos-connection.js';
import { warpTo, warpForward, WarpTarget } from '../../mechjeb/programs/warp.js';

async function main() {
  const target = process.argv[2] || 'node';
  const param = process.argv[3] ? parseFloat(process.argv[3]) : 60;

  console.log('=== Time Warp ===\n');

  const conn = new KosConnection({ cpuLabel: 'guidance' });

  try {
    console.log('1. Connecting to kOS...');
    await conn.connect();
    console.log('   Connected!\n');

    // Check if target is a number (warp forward by seconds)
    const seconds = parseFloat(target);
    if (!isNaN(seconds)) {
      console.log(`2. Warping forward ${seconds} seconds...`);
      const result = await warpForward(conn, seconds);
      if (result.success) {
        console.log(`\n✅ Warped forward ${seconds}s`);
        console.log(`   Body: ${result.body}, Alt: ${(result.altitude || 0) / 1000} km\n`);
      } else {
        console.log(`\n❌ ${result.error}\n`);
      }
      return;
    }

    // Validate target
    const validTargets: WarpTarget[] = ['node', 'soi', 'periapsis', 'apoapsis'];
    const normalizedTarget = target.toLowerCase() === 'pe' ? 'periapsis'
      : target.toLowerCase() === 'ap' ? 'apoapsis'
      : target.toLowerCase() as WarpTarget;

    if (!validTargets.includes(normalizedTarget)) {
      console.log(`Unknown target: ${target}`);
      console.log('Valid: node, soi, periapsis (pe), apoapsis (ap), or <seconds>\n');
      return;
    }

    console.log(`2. Warping to ${normalizedTarget} (${param}s lead time)...`);
    const result = await warpTo(conn, normalizedTarget, { leadTime: param });

    if (result.success) {
      console.log(`\n✅ Warped to ${normalizedTarget}`);
      console.log(`   Body: ${result.body}, Alt: ${(result.altitude || 0) / 1000} km\n`);
    } else {
      console.log(`\n❌ ${result.error}\n`);
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
