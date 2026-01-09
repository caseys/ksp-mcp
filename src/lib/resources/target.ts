/**
 * Target resource - current target info
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ResourceContext } from './types.js';
import { ManeuverOrchestrator } from '../mechjeb/orchestrator.js';

export function targetResource(server: McpServer, context: ResourceContext): void {
  server.resource(
    'target',
    'ksp://target',
    async () => {
      try {
        const conn = await context.ensureConnected();
        const orchestrator = new ManeuverOrchestrator(conn);
        const info = await orchestrator.getTargetInfo();
        return {
          contents: [{
            uri: 'ksp://target',
            mimeType: 'application/json',
            text: JSON.stringify(info, null, 2),
          }],
        };
      } catch (error) {
        return {
          contents: [{
            uri: 'ksp://target',
            mimeType: 'application/json',
            text: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              hasTarget: false,
            }, null, 2),
          }],
        };
      }
    }
  );
}
