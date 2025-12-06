#!/usr/bin/env npx tsx
/**
 * Daemon CLI
 *
 * Manage the kOS connection daemon.
 *
 * Usage:
 *   npx tsx src/cli/daemon-cli.ts status
 *   npx tsx src/cli/daemon-cli.ts ping
 *   npx tsx src/cli/daemon-cli.ts shutdown
 *   npx tsx src/cli/daemon-cli.ts exec "PRINT ALTITUDE."
 */

import * as daemon from '../daemon/index.js';

const command = process.argv[2];
const args = process.argv.slice(3);

async function main() {
  switch (command) {
    case 'status':
      console.log('Checking daemon status...');
      if (!daemon.isDaemonRunning()) {
        console.log('Daemon: NOT RUNNING');
      } else {
        const result = await daemon.status();
        console.log('Daemon: RUNNING');
        console.log('Connected:', result.connected ? 'yes' : 'no');
        if (result.connected) {
          console.log('Vessel:', result.vessel);
          console.log('CPU:', result.cpuId, `(${result.cpuTag})`);
        }
      }
      break;

    case 'ping':
      console.log('Pinging daemon...');
      try {
        const start = Date.now();
        const result = await daemon.ping();
        const elapsed = Date.now() - start;
        console.log(`Response: ${result.output} (${elapsed}ms)`);
      } catch (err) {
        console.log('No response (daemon not running)');
      }
      break;

    case 'shutdown':
      console.log('Shutting down daemon...');
      try {
        await daemon.shutdown();
        console.log('Daemon shutdown');
      } catch {
        console.log('Daemon not running');
      }
      break;

    case 'connect':
      console.log('Connecting to kOS...');
      const cpuLabel = args[0];
      const connectResult = await daemon.connect({ cpuLabel });
      if (connectResult.success) {
        console.log(`Connected to ${connectResult.vessel} (CPU ${connectResult.cpuId}: ${connectResult.cpuTag})`);
      } else {
        console.error('Failed:', connectResult.error);
        process.exit(1);
      }
      break;

    case 'disconnect':
      console.log('Disconnecting from kOS...');
      await daemon.disconnect();
      console.log('Disconnected');
      break;

    case 'exec':
    case 'execute':
      const cmd = args[0];
      if (!cmd) {
        console.error('Usage: daemon-cli exec "PRINT 1."');
        process.exit(1);
      }
      const execResult = await daemon.execute(cmd);
      if (execResult.success) {
        if (execResult.output) {
          console.log(execResult.output);
        }
      } else {
        console.error('Error:', execResult.error);
        process.exit(1);
      }
      break;

    default:
      console.log(`
kOS Daemon CLI

Commands:
  status              Check if daemon is running and connection status
  ping                Ping daemon (spawns if not running)
  shutdown            Stop the daemon
  connect [label]     Connect to kOS (optional CPU label)
  disconnect          Disconnect from kOS
  exec "command"      Execute a kOS command

Examples:
  daemon-cli status
  daemon-cli exec "PRINT SHIP:ALTITUDE."
  daemon-cli connect guidance
  daemon-cli shutdown
`);
      break;
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
