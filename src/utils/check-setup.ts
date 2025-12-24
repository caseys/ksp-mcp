/**
 * Check KSP setup for ksp-mcp requirements
 *
 * Verifies:
 * - KSP_DIR environment variable is set
 * - Required addons are installed in GameData
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED_ADDONS = [
  { name: 'kOS', path: 'kOS', required: true },
  { name: 'MechJeb2', path: 'MechJeb2', required: true },
  { name: 'kOS.MechJeb2.Addon', path: 'kOS.MechJeb2.Addon', required: true },
];

const OPTIONAL_ADDONS = [
  { name: 'KSP-AutoLoad', path: 'KSP-AutoLoad', required: false },
];

function checkSetup(): void {
  const kspDir = process.env.KSP_DIR;
  let hasWarnings = false;

  console.log('\n🚀 ksp-mcp Setup Check\n');

  // Check KSP_DIR
  if (!kspDir) {
    console.log('⚠️  KSP_DIR environment variable not set');
    console.log('   Set it to your KSP installation path:\n');
    if (process.platform === 'win32') {
      console.log('   Windows (PowerShell):');
      console.log(String.raw`   $env:KSP_DIR = "C:\Program Files\Steam\steamapps\common\Kerbal Space Program"`);
      console.log('   # Or set permanently via System Properties > Environment Variables\n');
    } else {
      console.log('   macOS/Linux (add to ~/.bashrc or ~/.zshrc):');
      console.log('   export KSP_DIR="/path/to/Kerbal Space Program"\n');
    }
    console.log('   Addon check skipped.\n');
    printRerunInstructions();
    return;
  }

  if (!existsSync(kspDir)) {
    console.log(`⚠️  KSP_DIR path does not exist: ${kspDir}\n`);
    printRerunInstructions();
    return;
  }

  console.log(`✓ KSP_DIR: ${kspDir}\n`);

  const gameDataPath = join(kspDir, 'GameData');

  // Check required addons
  console.log('Required Addons:');
  for (const addon of REQUIRED_ADDONS) {
    const addonPath = join(gameDataPath, addon.path);
    if (existsSync(addonPath)) {
      console.log(`  ✓ ${addon.name}`);
    } else {
      console.log(`  ✗ ${addon.name} - NOT FOUND`);
      hasWarnings = true;
    }
  }

  // Check optional addons
  console.log('\nOptional Addons:');
  for (const addon of OPTIONAL_ADDONS) {
    const addonPath = join(gameDataPath, addon.path);
    if (existsSync(addonPath)) {
      console.log(`  ✓ ${addon.name}`);
    } else {
      console.log(`  - ${addon.name} - not installed`);
    }
  }

  console.log('');

  if (hasWarnings) {
    console.log('⚠️  Some required addons are missing.');
    console.log('   Install them to use all ksp-mcp features.\n');
  } else {
    console.log('✓ All required addons installed!\n');
  }

  printRerunInstructions();
}

function printRerunInstructions(): void {
  console.log('To rerun this check: npx ksp-mcp-check');
  console.log('Or: npm exec ksp-mcp-check\n');
}

checkSetup();
