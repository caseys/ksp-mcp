#!/usr/bin/env npx tsx
/**
 * Load a KSP quicksave via kOS KUNIVERSE
 * Replaces LoadSaveKSP.scpt with a single kOS command
 *
 * Usage: npm run load-save -- [save-name]
 */

import * as daemon from '../../daemon/index.js';

const saveName = process.argv[2] || 'test-in-orbit';

async function main() {
  console.log(`Loading save: ${saveName}`);
  await daemon.execute(`KUNIVERSE:QUICKLOADFROM("${saveName}").`);
  console.log('✅ Quickload initiated');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
