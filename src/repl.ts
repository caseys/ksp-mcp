#!/usr/bin/env tsx

/**
 * Interactive REPL for kOS
 * Run with: npx tsx src/repl.ts
 */

import * as readline from 'readline';
import { KosConnection } from './transport/kos-connection.js';

async function main() {
  console.log('kOS REPL - Connecting...\n');

  const conn = new KosConnection();

  try {
    const state = await conn.connect();
    console.log(`Connected to ${state.vesselName} (CPU ${state.cpuId})`);
    console.log('Type kOS commands. Type "exit" or Ctrl+C to quit.\n');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'kOS> ',
    });

    rl.prompt();

    rl.on('line', async (line) => {
      const cmd = line.trim();

      if (cmd === 'exit' || cmd === 'quit') {
        console.log('Disconnecting...');
        await conn.disconnect();
        rl.close();
        process.exit(0);
      }

      if (cmd === '') {
        rl.prompt();
        return;
      }

      try {
        const result = await conn.execute(cmd, 10000);
        if (result.success) {
          // Extract just the output (after the command echo)
          const lines = result.output.split('\n');
          for (const line of lines) {
            // Skip lines that look like command echoes
            if (!line.includes(cmd.substring(0, 10))) {
              console.log(line);
            }
          }
        } else {
          console.log(`Error: ${result.error}`);
          if (result.output) console.log(result.output);
        }
      } catch (err) {
        console.log(`Error: ${err}`);
      }

      rl.prompt();
    });

    rl.on('close', async () => {
      console.log('\nDisconnecting...');
      await conn.disconnect();
      process.exit(0);
    });

  } catch (error) {
    console.error('Connection error:', error);
    process.exit(1);
  }
}

main();
