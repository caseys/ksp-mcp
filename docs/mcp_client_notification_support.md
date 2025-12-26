# MCP Client Notification Support

This document describes how MCP clients can receive progress updates from ksp-mcp during long-running operations like `launch_ascent`, `crash_avoidance`, and `execute_node`.

## Overview

ksp-mcp supports two notification mechanisms for long-running operations:

1. **Progress Notifications** (preferred) - Client opts in by sending a `progressToken`
2. **Logging Notifications** (fallback) - Sent automatically when no `progressToken` is provided

## Progress Notifications

Progress notifications allow clients to:
- Receive real-time status updates during long operations
- Reset request timeouts to prevent premature termination
- Track operation progress with incrementing counters

### Client Implementation

To receive progress notifications, clients must:

1. **Generate a unique `progressToken`** for each request
2. **Include the token in request `_meta`**
3. **Handle `notifications/progress` messages**
4. **Enable `resetTimeoutOnProgress`** to keep the connection alive

#### Example (TypeScript with MCP SDK)

```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'node:crypto';

async function callToolWithProgress(
  client: Client,
  toolName: string,
  args: Record<string, unknown>
) {
  const progressToken = randomUUID();

  const result = await client.callTool(
    {
      name: toolName,
      arguments: args,
      _meta: { progressToken },
    },
    CallToolResultSchema,
    {
      onprogress: (progress) => {
        // Display progress message to user
        if (progress.message) {
          console.log(`[Progress] ${progress.message}`);
        }
      },
      // Reset timeout when progress is received
      resetTimeoutOnProgress: true,
      // Long timeout as fallback (10 minutes)
      timeout: 600_000,
    }
  );

  return result;
}
```

### Progress Notification Format

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/progress",
  "params": {
    "progressToken": "550e8400-e29b-41d4-a716-446655440000",
    "progress": 5,
    "message": "[Ascent] APO:85km PER:72km"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `progressToken` | string/number | Token from the original request |
| `progress` | number | Incrementing counter (1, 2, 3, ...) |
| `message` | string | Human-readable status message |

## Logging Notifications (Fallback)

When a client doesn't provide a `progressToken`, ksp-mcp falls back to sending logging notifications. These are informational and don't reset timeouts.

### Logging Notification Format

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/message",
  "params": {
    "level": "info",
    "logger": "ksp-mcp",
    "data": "[Ascent] APO:85km PER:72km"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `level` | string | Log level: "debug", "info", "warning", "error" |
| `logger` | string | Logger name (always "ksp-mcp") |
| `data` | any | Log message or structured data |

### Handling Logging Notifications

Clients that support the MCP logging capability will receive these automatically. The client can optionally send `logging/setLevel` to filter messages:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "logging/setLevel",
  "params": {
    "level": "info"
  }
}
```

## Tools with Progress Support

The following tools send progress notifications:

| Tool | Typical Duration | Progress Messages |
|------|------------------|-------------------|
| `launch_ascent` | 2 - 10min | MechJeb status, apoapsis/periapsis updates, orbit achieved |
| `crash_avoidance` | 30s - 5min | Alignment, throttle %, periapsis updates |
| `execute_node` | 10s - 4min | Burn status, delta-v remaining, completion |
| `warp` | 10s - 5min | Warp target, ETA countdown, SOI status |
| `run_script` | 1s - 60s | Script start, progress updates every 5s, completion |
| `interplanetary_transfer` | 1s - 30s | Transfer planning start/completion |

## Timeout Recommendations

| Client Type | Recommendation |
|-------------|----------------|
| With `progressToken` | Use `resetTimeoutOnProgress: true`, set 10min fallback timeout |
| Without `progressToken` | Set timeout to 10 minutes (600,000ms) for long operations |
| Interactive clients | Consider showing progress messages to users |

## Server Behavior

ksp-mcp's `createProgressCallback` function determines which notification type to use:

```
Request has progressToken?
    |-- Yes --> Send notifications/progress (resets client timeout)
    |-- No  --> Send notifications/message (logging, informational only)
```

Both paths ensure the same status messages are delivered - only the notification mechanism differs.

## References

- [MCP Progress Specification](https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/utilities/progress/)
- [MCP Logging Specification](https://modelcontextprotocol.io/specification/2025-06-18/server/utilities/logging)
