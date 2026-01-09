/**
 * Tiers resource - tool tiers with descriptions
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { allTools } from '../tool-registry.js';

const TIER_DESCRIPTIONS = [
  'launch, land, circularize, inclination, warp...',
  'match_velocities, adjust_apoapsis, ellipticize, crash_avoidance...',
  'get_target_info, clear_target, set_position_target...',
  'run_script, load_save, command...',
];

export function tiersResource(server: McpServer): void {
  server.resource(
    'tiers',
    'ksp://tiers',
    async () => {
      const tiers: Record<string, string | { description: string }>[] = [
        { _desc: TIER_DESCRIPTIONS[0] },
        { _desc: TIER_DESCRIPTIONS[1] },
        { _desc: TIER_DESCRIPTIONS[2] },
        { _desc: TIER_DESCRIPTIONS[3] },
      ];
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
