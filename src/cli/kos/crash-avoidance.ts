#!/usr/bin/env node
/**
 * Emergency burn to raise periapsis - thin wrapper around crashAvoidance library
 * Usage: npm run crash-avoidance [targetPe] [timeoutMs]
 *
 * Examples:
 *   npm run crash-avoidance              # Default: 10km periapsis, 5min timeout
 *   npm run crash-avoidance 20000        # Target 20km periapsis
 *   npm run crash-avoidance 10000 60000  # 10km, 1min timeout
 */

import * as daemon from '../daemon-client.js';
import type { CrashAvoidanceResult } from '../../lib/kos/crash-avoidance.js';

const targetPeriapsis = Number.parseInt(process.argv[2] || '10000', 10);
const timeoutMs = Number.parseInt(process.argv[3] || '300000', 10);

async function main() {
  console.log('=== Crash Avoidance ===\n');
  console.log(`Target periapsis: ${targetPeriapsis}m`);
  console.log(`Timeout: ${timeoutMs}ms\n`);

  try {
    console.log('Starting emergency burn...\n');

    const result = await daemon.call<CrashAvoidanceResult>('crashAvoidance', {
      targetPeriapsis,
      timeoutMs,
    });

    if (result.success) {
      console.log(`\n✅ Crash avoided!`);
      console.log(`   Pe: ${result.initialPeriapsis?.toFixed(0)}m → ${result.finalPeriapsis?.toFixed(0)}m`);
      console.log(`   ΔV used: ${result.deltaVUsed?.toFixed(1)} m/s`);
      console.log(`   Stages used: ${result.stagesUsed}\n`);
    } else {
      console.log(`\n❌ ${result.error}\n`);
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(console.error);
