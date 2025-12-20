#!/usr/bin/env node
/**
 * Run raw kOS command
 * Usage: npm run command "<kOS script>"
 * Example: npm run command "PRINT SHIP:NAME."
 */

import * as daemon from './daemon-client.js';

interface ExecuteResult {
  success: boolean;
  output?: string;
  error?: string;
}

async function main() {
  const command = process.argv[2];
  const timeout = Number.parseInt(process.argv[3] || '5000', 10);

  if (!command) {
    console.error('Usage: npm run command "<kOS script>" [timeout_ms]');
    console.error('Example: npm run command "PRINT SHIP:NAME."');
    process.exit(1);
  }

  try {
    const result = await daemon.call<ExecuteResult>('execute', { command, timeout });

    if (result.success) {
      console.log(result.output || '(no output)');
    } else {
      console.error('Error:', result.error);
      process.exit(1);
    }
  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main().catch(console.error);
