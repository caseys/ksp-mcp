/**
 * Status resource - ship telemetry and operation progress
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ResourceContext } from './types.js';
import { getStatus, getOperationProgress, formatOperationProgress, type ShipTelemetryOptions, type ShipTelemetry } from '../mechjeb/telemetry.js';

const TELEMETRY_OPTIONS: ShipTelemetryOptions = {
  timeoutMs: 3000,
};

export function statusResource(server: McpServer, context: ResourceContext): void {
  server.resource(
    'status',
    'ksp://status',
    async () => {
      const conn = context.getConnection();

      // If not connected, return immediately - never trigger a connection attempt
      // from a read-only resource. Tools handle their own connection via ensureConnected().
      if (!conn.isConnected()) {
        const notConnected: ShipTelemetry = {
          connected: false,
          reason: 'Not connected to kOS. Use a tool (e.g. status, launch) to connect.',
          availableTargets: { moons: [], planets: [], vessels: [] },
          formatted: '=== kOS Not Connected ===\nUse a tool to establish connection.',
        };
        return {
          contents: [{
            uri: 'ksp://status',
            mimeType: 'application/json',
            text: JSON.stringify(notConnected, null, 2),
          }],
        };
      }

      const status = await getStatus(conn, TELEMETRY_OPTIONS);
      if (status.formatted) {
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
