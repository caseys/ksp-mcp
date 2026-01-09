/**
 * Status resource - ship telemetry and operation progress
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ResourceContext } from './types.js';
import { getStatus, getOperationProgress, formatOperationProgress, type ShipTelemetryOptions } from '../mechjeb/telemetry.js';

const TELEMETRY_OPTIONS: ShipTelemetryOptions = {
  timeoutMs: 3000,
};

export function statusResource(server: McpServer, context: ResourceContext): void {
  server.resource(
    'status',
    'ksp://status',
    async () => {
      const conn = context.getConnection();
      const status = await getStatus(conn.isConnected() ? conn : undefined, TELEMETRY_OPTIONS);
      if (conn.isConnected() && status.formatted) {
        const opProgress = await getOperationProgress(conn);
        if (opProgress) {
          status.formatted = formatOperationProgress(opProgress) + '\n\n' + status.formatted;
        }
      }
      return {
        contents: [{
          uri: 'ksp://status',
          mimeType: 'application/json',
          text: JSON.stringify(status, null, 2),
        }],
      };
    }
  );
}
