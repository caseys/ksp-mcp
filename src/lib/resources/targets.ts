/**
 * Targets resource - list available moons, planets, and vessels
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ResourceContext } from './types.js';
import { ManeuverOrchestrator } from '../mechjeb/orchestrator.js';

export function targetsResource(server: McpServer, context: ResourceContext): void {
  server.resource(
    'targets',
    'ksp://targets',
    async () => {
      try {
        const conn = await context.ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const result = await orchestrator.listTargets();
        return {
          contents: [{
            uri: 'ksp://targets',
            mimeType: 'application/json',
            text: JSON.stringify({
              moons: result.moons,
              planets: result.planets,
              vessels: result.vessels,
              formatted: result.formatted,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          contents: [{
            uri: 'ksp://targets',
            mimeType: 'application/json',
            text: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              moons: [],
              planets: [],
              vessels: [],
            }, null, 2),
          }],
        };
      }
    }
  );
}
