/**
 * Types for MCP resource handlers
 */

import type { KosConnection } from '../../transport/kos-connection.js';

export interface ResourceContext {
  getConnection: () => KosConnection;
  ensureConnected: () => Promise<KosConnection>;
}
