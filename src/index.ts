#!/usr/bin/env node
/**
 * ksp-mcp CLI Entry Point
 *
 * Starts the MCP server with configurable transport:
 * - stdio (default): For Claude Desktop and local tools
 * - http: For network access using Streamable HTTP transport
 *
 * @example
 * ```bash
 * # Default: stdio transport
 * ksp-mcp
 *
 * # Network: Streamable HTTP transport
 * ksp-mcp --transport http --port 3000 --host 0.0.0.0
 * ```
 */

import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './service/http-server.js';

// =============================================================================
// Library API Re-exports (for direct imports from 'ksp-mcp')
// =============================================================================

// Core Connection
export { KosConnection } from './transport/kos-connection.js';
export type {
  ConnectionState,
  CommandResult,
  KosConnectionOptions,
} from './transport/kos-connection.js';

// Transport Layer
export type { Transport } from './transport/transport.js';
export { BaseTransport } from './transport/transport.js';
export { SocketTransport } from './transport/socket-transport.js';
export { TmuxTransport } from './transport/tmux-transport.js';

// MechJeb Interface
export * from './lib/index.js';

// Configuration
export { config } from './config/index.js';
export type { Config } from './config/index.js';

// MCP Server
export { createServer } from './service/http-server.js';

// Tool Handlers (for direct use without MCP)
export { handleListCpus } from './transport/list-cpus.js';
export type { CpuInfo } from './transport/list-cpus.js';

export {
  handleConnect,
  handleDisconnect,
  handleExecute,
  handleStatus,
  getConnection,
  ensureConnected,
  waitForKosReady,
  isKosReady,
} from './transport/connection-tools.js';
export type { EnsureConnectedOptions, WaitForKosOptions } from './transport/connection-tools.js';

// Monitoring
export { KosMonitor, globalKosMonitor } from './utils/kos-monitor.js';
export type { MonitorStatus, LoopDetection } from './utils/kos-monitor.js';

// Workarounds Configuration
export {
  setWorkaroundsEnabled,
  areWorkaroundsEnabled,
} from './config/workarounds.js';

// =============================================================================
// CLI Entry Point (only runs when executed directly, not when imported)
// =============================================================================

import { fileURLToPath } from 'node:url';
const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  // Parse CLI arguments
  const { values } = parseArgs({
    options: {
      transport: {
        type: 'string',
        short: 't',
        default: 'stdio',
      },
      port: {
        type: 'string',
        short: 'p',
        default: '3000',
      },
      host: {
        type: 'string',
        short: 'h',
        default: '127.0.0.1',
      },
      stateless: {
        type: 'boolean',
        default: false,
      },
      help: {
        type: 'boolean',
      },
    },
    allowPositionals: false,
  });

  function showHelp() {
    console.log(`
ksp-mcp - MCP server for KSP automation via kOS and MechJeb

Usage:
  ksp-mcp [options]

Options:
  -t, --transport <type>  Transport type: stdio (default), http
  -p, --port <port>       Port for HTTP transport (default: 3000)
  -h, --host <host>       Host for HTTP transport (default: 127.0.0.1)
  --stateless             Run HTTP in stateless mode (no sessions)
  --help                  Show this help

Examples:
  # Start with stdio transport (for Claude Desktop)
  ksp-mcp

  # Start with Streamable HTTP transport for network access
  ksp-mcp --transport http --port 3000

  # Listen on all interfaces
  ksp-mcp --transport http --host 0.0.0.0 --port 3000

  # Stateless mode (each request is independent)
  ksp-mcp --transport http --stateless
`);
  }

  async function startHttpServer(host: string, port: number, stateless: boolean) {
    const http = await import('node:http');

    // Track sessions -> transports for stateful mode
    const sessions = new Map<string, {
      transport: StreamableHTTPServerTransport;
      server: ReturnType<typeof createServer>;
    }>();

    const httpServer = http.createServer(async (req, res) => {
      // CORS headers for cross-origin access
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, Mcp-Protocol-Version');
      res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host}`);

      // Health check endpoint
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          transport: 'streamable-http',
          sessions: sessions.size,
          stateless
        }));
        return;
      }

      // MCP endpoint - handles all MCP traffic
      if (url.pathname === '/mcp') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        // For stateless mode or new sessions, create transport per request
        if (stateless) {
          // Stateless: new transport for each request
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined, // No session management
          });
          const server = createServer();
          await server.connect(transport);
          await transport.handleRequest(req, res);
          return;
        }

        // Stateful mode
        if (sessionId && sessions.has(sessionId)) {
          // Existing session - reuse transport
          const session = sessions.get(sessionId)!;
          await session.transport.handleRequest(req, res);
        } else if (!sessionId && req.method === 'POST') {
          // New session - create transport and server
          const server = createServer();

          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              console.error(`[${newSessionId}] Session initialized`);
              sessions.set(newSessionId, { transport, server });
            },
            onsessionclosed: (closedSessionId) => {
              console.error(`[${closedSessionId}] Session closed`);
              sessions.delete(closedSessionId);
            },
          });

          await server.connect(transport);
          await transport.handleRequest(req, res);
        } else if (sessionId && !sessions.has(sessionId)) {
          // Invalid session ID
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session not found' }));
        } else {
          // Missing session ID for non-initialization request
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing mcp-session-id header' }));
        }
        return;
      }

      // Not found
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. Use /mcp for MCP requests or /health for status.' }));
    });

    httpServer.listen(port, host, () => {
      console.error(`ksp-mcp server running on http://${host}:${port}`);
      console.error(`  MCP endpoint: http://${host}:${port}/mcp`);
      console.error(`  Health check: http://${host}:${port}/health`);
      console.error(`  Mode: ${stateless ? 'stateless' : 'stateful (session-based)'}`);
    });

    // Cleanup on shutdown
    process.on('SIGINT', async () => {
      console.error('\nShutting down...');
      for (const [sessionId, session] of sessions) {
        console.error(`Closing session ${sessionId}`);
        await session.transport.close();
      }
      httpServer.close();
      process.exit(0);
    });

    return httpServer;
  }

  async function main() {
    if (values.help) {
      showHelp();
      process.exit(0);
    }

    if (values.transport === 'http') {
      // Streamable HTTP transport for network access
      const port = Number.parseInt(values.port!, 10);
      const host = values.host!;
      await startHttpServer(host, port, values.stateless ?? false);
    } else {
      // Default: stdio transport
      const server = createServer();
      const transport = new StdioServerTransport();
      await server.connect(transport);
    }
  }

  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
