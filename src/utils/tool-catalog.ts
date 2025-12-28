#!/usr/bin/env node
/**
 * Tool Catalog - Output all MCP tools with descriptions and arguments
 */

import { allTools } from '../lib/tool-registry.js';

for (const tool of allTools) {
  console.log(`\n## ${tool.name}`);
  console.log(tool.description);

  const params = Object.entries(tool.inputSchema);
  if (params.length > 0) {
    console.log('\nArguments:');
    for (const [name, schema] of params) {
      const desc = schema.description ?? '(no description)';
      console.log(`  - ${name}: ${desc}`);
    }
  }
}
