/**
 * ksp-mcp Library
 *
 * Re-exports from mechjeb/ (MechJeb programs) and kos/ (pure kOS programs)
 */

// =============================================================================
// MechJeb Programs (require kOS.MechJeb2.Addon)
// =============================================================================

// Main client
export { MechJebClient } from './mechjeb/index.js';

// Programs
export { AscentProgram, AscentHandle } from './mechjeb/ascent.js';
export { ManeuverProgram } from './mechjeb/maneuver.js';
export type { ManeuverResult, SetTargetResult, GetTargetInfo, ClearTargetResult } from './mechjeb/maneuver.js';

// Orchestrator - high-level API with target/execute handling
export { ManeuverOrchestrator, withTargetAndExecute } from './mechjeb/orchestrator.js';
export type { ManeuverOptions, OrchestratedResult } from './mechjeb/orchestrator.js';

// Node execution
export {
  executeNode,
  getNodeProgress,
  isNodeExecutorEnabled,
  disableNodeExecutor
} from './mechjeb/execute-node.js';
export type { ExecuteNodeResult, ExecuteNodeProgress } from './mechjeb/execute-node.js';

// Maneuver operations - Basic
export { ellipticize, changeSemiMajorAxis } from './mechjeb/basic/index.js';

// Maneuver operations - Orbital
export { changeEccentricity, changeLAN, changeLongitudeOfPeriapsis } from './mechjeb/orbital/index.js';

// Maneuver operations - Rendezvous
export { matchPlane, killRelativeVelocity } from './mechjeb/rendezvous/index.js';

// Maneuver operations - Transfer
export { resonantOrbit, returnFromMoon, interplanetaryTransfer } from './mechjeb/transfer/index.js';

// Discovery (for advanced use)
export {
  discoverModules,
  isMechJebAvailable,
  discoverAscentSuffixes,
  discoverVesselSuffixes,
  discoverInfoSuffixes
} from './mechjeb/discovery.js';

// Telemetry (for advanced use)
export {
  getVesselState,
  getOrbitInfo,
  getMechJebInfo,
  getQuickStatus,
  getShipTelemetry,
  getStatus
} from './mechjeb/telemetry.js';
export type {
  ShipTelemetryOptions,
  ShipTelemetry,
  VesselInfo,
  OrbitTelemetry,
  ManeuverInfo,
  EncounterInfo,
  TargetInfo,
  AvailableTargets
} from './mechjeb/telemetry.js';

// =============================================================================
// Pure kOS Programs (no MechJeb dependency)
// =============================================================================

export * from './kos/index.js';

// =============================================================================
// Shared Types
// =============================================================================

export type {
  MechJebModules,
  VesselState,
  OrbitInfo,
  MechJebInfo,
  AscentSettings,
  AscentStatus,
  AscentProgress,
  AscentResult,
  LaunchOptions
} from './types.js';
