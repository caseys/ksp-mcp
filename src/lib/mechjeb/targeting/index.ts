/**
 * MechJeb Targeting Module
 *
 * Provides access to MechJeb's target controller for:
 * - Position targeting (lat/lng for landing)
 * - Rendezvous calculations (phase angle, closest approach)
 * - Target orbital info
 */

// Shared types and utilities
export * from './shared.js';

// Tool definitions
export { setPositionTargetTool, setPositionTargetOp } from './set-position-target.js';
export { getTargetInfoTool, getUnifiedTargetInfo } from './get-target-info.js';

// Legacy exports for library use (queries still available)
export { getRendezvousInfo } from './rendezvous-info.js';
export { getTargetOrbitInfo, getTargetPositionInfo } from './target-info.js';
