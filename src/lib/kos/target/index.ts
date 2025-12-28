/**
 * Target management tools and functions
 */

// Tool definitions
export { setTargetTool, setTarget } from './set-target.js';
export { getTargetTool, getTargetInfo } from './get-target.js';
export { getTargetsTool, listTargets } from './get-targets.js';
export { clearTargetTool, clearTarget } from './clear-target.js';

// Shared utilities
export { hasTarget, getSOIBody, formatDistance } from './shared.js';

// Types
export type {
  SetTargetResult,
  GetTargetInfo,
  ClearTargetResult,
  ListTargetsResult,
} from './types.js';
