#!/usr/bin/env node
/**
 * List available kOS CPUs - thin wrapper around list-cpus handler
 * Usage: npm run list-cpus [host] [port]
 */

import { handleListCpus } from '../transport/list-cpus.js';
import { config } from '../config/index.js';

const host = process.argv[2] || config.kos.host;
const port = Number.parseInt(process.argv[3] || String(config.kos.port), 10);

async function main() {
  console.log('=== Available kOS CPUs ===\n');
  console.log(`Host: ${host}:${port}\n`);

  try {
    const cpus = await handleListCpus({ host, port });

    if (cpus.length === 0) {
      console.log('No CPUs found. Is KSP running with kOS telnet enabled?\n');
      process.exit(1);
    }

    console.log(`Found ${cpus.length} CPU(s):\n`);
    for (const cpu of cpus) {
      console.log(`  ${cpu.id}: ${cpu.vessel} (${cpu.tag || 'no tag'})`);
    }
    console.log();
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(console.error);
