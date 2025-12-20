#!/usr/bin/env tsx
/**
 * Check parity between MCP tools and CLI scripts
 *
 * This script ensures every MCP tool has a corresponding CLI script with matching naming.
 *
 * Usage: npm run check:parity
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Tools that intentionally don't have CLI equivalents (internal/special purpose)
const EXCLUDED_TOOLS = new Set([
  // None currently - all tools should have CLI equivalents
]);

// Read and parse server.ts to extract MCP tool names
function getMcpTools(): string[] {
  const serverPath = join(projectRoot, 'src/server.ts');
  const content = readFileSync(serverPath, 'utf-8');

  // Match server.registerTool( followed by 'tool_name' on next line
  const toolRegex = /server\.registerTool\(\s*['"]([^'"]+)['"]/g;
  const tools: string[] = [];

  let match;
  while ((match = toolRegex.exec(content)) !== null) {
    tools.push(match[1]);
  }

  return tools;
}

// Read package.json and get all npm scripts
function getNpmScripts(): Set<string> {
  const packagePath = join(projectRoot, 'package.json');
  const content = JSON.parse(readFileSync(packagePath, 'utf-8'));
  return new Set(Object.keys(content.scripts || {}));
}

// Convert MCP tool name (snake_case) to CLI script name (kebab-case)
function mcpToCli(toolName: string): string {
  return toolName.replace(/_/g, '-');
}

// Main check function
function checkParity(): boolean {
  const mcpTools = getMcpTools();
  const npmScripts = getNpmScripts();

  console.log('=== MCP vs CLI Parity Check ===\n');
  console.log(`Found ${mcpTools.length} MCP tools`);
  console.log(`Found ${npmScripts.size} npm scripts\n`);

  const missing: string[] = [];
  const present: string[] = [];

  for (const tool of mcpTools) {
    if (EXCLUDED_TOOLS.has(tool)) {
      continue;
    }

    const expectedCli = mcpToCli(tool);

    if (npmScripts.has(expectedCli)) {
      present.push(`  ${tool} -> ${expectedCli}`);
    } else {
      missing.push(`  ${tool} -> ${expectedCli} (MISSING)`);
    }
  }

  if (present.length > 0) {
    console.log(`Matched (${present.length}):`);
    present.forEach(p => console.log(p));
    console.log('');
  }

  if (missing.length > 0) {
    console.log(`Missing CLI scripts (${missing.length}):`);
    missing.forEach(m => console.log(m));
    console.log('');
    console.log('To add missing CLI scripts:');
    console.log('1. Create src/cli/<script-name>.ts using library functions');
    console.log('2. Add npm script to package.json');
    console.log('');
    return false;
  }

  console.log('All MCP tools have corresponding CLI scripts!');
  return true;
}

// Run check
const success = checkParity();
process.exit(success ? 0 : 1);
