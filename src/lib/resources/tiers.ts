/**
 * Tiers resource - tool tiers with descriptions
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { allTools } from '../tool-registry.js';

export function tiersResource(server: McpServer): void {
  server.resource(
    'tiers',
    'ksp://tiers',
    async () => {
      const tiers: Record<string, { description: string }>[] = [{}, {}, {}, {}];
      for (const tool of allTools) {
        const tierIndex = (tool.tier || 1) - 1;
        if (tierIndex >= 0 && tierIndex < 4) {
          tiers[tierIndex][tool.name] = { description: tool.description };
        }
      }
      return {
        contents: [{
          uri: 'ksp://tiers',
          mimeType: 'application/json',
          text: JSON.stringify(tiers, null, 2),
        }],
      };
    }
  );
}
