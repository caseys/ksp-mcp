/**
 * Tiers resource - tool tiers with descriptions
 *
 * Positive tiers (1, 2) are LLM-ready tools registered with MCP.
 * Negative tiers (-1, -2, -3) are hidden from LLM but still available internally.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { allTools } from '../tool-registry.js';

const TIER_DESCRIPTIONS: Record<number, string> = {
  1: 'Core Mission: launch, land, transfer, circularize, time_warp',
  2: 'Utility: status, targeting, saves, scripting, node execution',
  [-1]: 'Low-level Orbital: underlying maneuver implementations',
  [-2]: 'Landing Config: landing position and prediction tools',
  [-3]: 'Internal Operations: abort, continue, disconnect',
};

export function tiersResource(server: McpServer): void {
  server.resource(
    'tiers',
    'ksp://tiers',
    async () => {
      // Group tools by tier
      const tierGroups = new Map<number, Record<string, { description: string }>>();

      for (const tool of allTools) {
        const tier = tool.tier || 1;
        if (!tierGroups.has(tier)) {
          tierGroups.set(tier, {});
        }
        tierGroups.get(tier)![tool.name] = { description: tool.description };
      }

      // Sort tiers: positive first (ascending), then negative (descending)
      // eslint-disable-next-line unicorn/no-array-sort
      const sortedTiers = [...tierGroups.keys()].sort((a, b) => {
        if (a > 0 && b > 0) return a - b;  // Both positive: 1, 2
        if (a <= 0 && b <= 0) return b - a; // Both negative: -1, -2, -3
        return a > 0 ? -1 : 1;  // Positive before negative
      });

      // Build output array
      const result = sortedTiers.map(tier => ({
        _tier: tier,
        _desc: TIER_DESCRIPTIONS[tier] || `Tier ${tier}`,
        ...tierGroups.get(tier),
      }));

      return {
        contents: [{
          uri: 'ksp://tiers',
          mimeType: 'application/json',
          text: JSON.stringify(result, null, 2),
        }],
      };
    }
  );
}
