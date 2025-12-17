/**
 * MechJeb Interface for kOS.MechJeb2.Addon
 */

// Main client
export { MechJebClient } from './mechjeb-client.js';

// Programs
export { AscentProgram, AscentHandle } from './programs/ascent.js';
export { ManeuverProgram } from './programs/maneuver.js';
export type { ManeuverResult, SetTargetResult, GetTargetInfo, ClearTargetResult } from './programs/maneuver.js';

// Orchestrator - high-level API with target/execute handling
export { ManeuverOrchestrator, withTargetAndExecute } from './programs/orchestrator.js';
export type { ManeuverOptions, OrchestratedResult } from './programs/orchestrator.js';

// Node execution
export {
  executeNode,
  getNodeProgress,
  isNodeExecutorEnabled,
  disableNodeExecutor
} from './programs/node/index.js';
export type { ExecuteNodeResult, ExecuteNodeProgress } from './programs/node/index.js';

// Maneuver operations - Basic
export { ellipticize, changeSemiMajorAxis } from './programs/basic/index.js';

// Maneuver operations - Orbital
export { changeEccentricity, changeLAN, changeLongitudeOfPeriapsis } from './programs/orbital/index.js';

// Maneuver operations - Rendezvous
export { matchPlane, killRelativeVelocity } from './programs/rendezvous/index.js';

// Maneuver operations - Transfer
export { resonantOrbit, returnFromMoon, interplanetaryTransfer } from './programs/transfer/index.js';

// Types
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

// Discovery (for advanced use)
export {
  discoverModules,
  isMechJebAvailable,
  discoverAscentSuffixes,
  discoverVesselSuffixes,
  discoverInfoSuffixes
} from './discovery.js';

// Telemetry (for advanced use)
export {
  getVesselState,
  getOrbitInfo,
  getMechJebInfo,
  getQuickStatus
} from './telemetry.js';
