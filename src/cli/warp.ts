#!/usr/bin/env node
/**
 * Time warp CLI - thin wrapper around daemon handlers
 * Usage:
 *   npm run warp node [leadTime]   - Warp to next maneuver node (default 60s before)
 *   npm run warp soi [leadTime]    - Warp to next SOI change
 *   npm run warp periapsis         - Warp to periapsis
 *   npm run warp apoapsis          - Warp to apoapsis
 *   npm run warp <seconds>         - Warp forward by N seconds
 */

import * as daemon from '../daemon/index.js';
import type { WarpResult, WarpTarget } from '../mechjeb/programs/warp.js';

async function main() {
  const target = process.argv[2] || 'node';
  const param = process.argv[3] ? parseFloat(process.argv[3]) : 60;

  console.log('=== Time Warp ===\n');

  try {
    // Check if target is a number (warp forward by seconds)
    const seconds = parseFloat(target);
    if (!isNaN(seconds)) {
      console.log(`1. Warping forward ${seconds} seconds...`);
      const result = await daemon.call<WarpResult>('warpForward', { seconds });
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

    console.log(`1. Warping to ${normalizedTarget} (${param}s lead time)...`);
    const result = await daemon.call<WarpResult>('warpTo', {
      target: normalizedTarget,
      leadTime: param,
    });

    if (result.success) {
      console.log(`\n✅ Warped to ${normalizedTarget}`);
      console.log(`   Body: ${result.body}, Alt: ${(result.altitude || 0) / 1000} km\n`);
    } else {
      console.log(`\n❌ ${result.error}\n`);
    }

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(console.error);
