/**
 * Saves resource - list quicksaves
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ResourceContext } from './types.js';
import { listQuicksaves } from '../kos/kuniverse.js';

export function savesResource(server: McpServer, context: ResourceContext): void {
  server.resource(
    'saves',
    'ksp://saves',
    async () => {
      try {
        const conn = await context.ensureConnected();
        const result = await listQuicksaves(conn);
        return {
          contents: [{
            uri: 'ksp://saves',
            mimeType: 'application/json',
            text: JSON.stringify({
              success: result.success,
              saves: result.saves,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          contents: [{
            uri: 'ksp://saves',
            mimeType: 'application/json',
            text: JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              saves: [],
            }, null, 2),
          }],
        };
      }
    }
  );
}
