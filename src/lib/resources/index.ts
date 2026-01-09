/**
 * MCP Resources
 *
 * Registers all MCP resources with the server.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ResourceContext } from './types.js';
import { statusResource } from './status.js';
import { targetsResource } from './targets.js';
import { targetResource } from './target.js';
import { savesResource } from './saves.js';
import { tiersResource } from './tiers.js';

export type { ResourceContext } from './types.js';

export function registerAllResources(server: McpServer, context: ResourceContext): void {
  statusResource(server, context);
  targetsResource(server, context);
  targetResource(server, context);
  savesResource(server, context);
  tiersResource(server);
}
