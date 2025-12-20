#!/usr/bin/env node
/**
 * Run a kOS script file
 * Usage: npm run run-script -- /path/to/script.ks [timeout_ms]
 *
 * Examples:
 *   npm run run-script -- ./my-script.ks
 *   npm run run-script -- /absolute/path/script.ks 120000
 */

import * as path from 'node:path';
import * as daemon from './daemon-client.js';
import type { RunScriptResult } from '../lib/script/index.js';

const scriptPath = process.argv[2];
const timeout = Number.parseInt(process.argv[3] || '60000', 10);

if (!scriptPath) {
  console.error('Usage: npm run run-script -- <script-path> [timeout_ms]');
  console.error('');
  console.error('Examples:');
  console.error('  npm run run-script -- ./my-script.ks');
  console.error('  npm run run-script -- /path/to/script.ks 120000');
  process.exit(1);
}

// Resolve to absolute path
const absolutePath = path.isAbsolute(scriptPath)
  ? scriptPath
  : path.resolve(process.cwd(), scriptPath);

async function main() {
  console.log('=== Run kOS Script ===\n');
  console.log(`Script: ${absolutePath}`);
  console.log(`Timeout: ${timeout}ms\n`);

  try {
    console.log('Running script...');
    const result = await daemon.call<RunScriptResult>('runScript', {
      sourcePath: absolutePath,
      timeout,
      cleanup: true,
    });

    if (result.success) {
      console.log(`\n✅ Script completed in ${((result.executionTime || 0) / 1000).toFixed(1)}s\n`);
      console.log('Output:');
      console.log(result.output.join('\n'));
    } else {
      console.error(`\n❌ Script failed: ${result.error}\n`);
      console.log('Output:');
      console.log(result.output.join('\n'));
      process.exit(1);
    }

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(console.error);
