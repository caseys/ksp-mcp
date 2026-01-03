/**
 * Target management tools and functions
 */

// Tool definitions
export { setTargetTool, setTarget } from './set-target.js';
export { getTargetsTool, listTargets } from './get-targets.js';
export { clearTargetTool, clearTarget } from './clear-target.js';

// Library function (tool moved to mechjeb/targeting/get-target-info.ts)
export { getTargetInfo } from './get-target.js';

// Shared utilities
export { hasTarget, getSOIBody, formatDistance } from './shared.js';

// Validation
export {
  validateTarget,
  getTargetValidationInfo,
  type TargetClass,
  type TargetInfo,
  type TargetRequirements,
  type ValidationResult,
} from './validate.js';

// Types
export type {
  SetTargetResult,
  GetTargetInfo,
  ClearTargetResult,
  ListTargetsResult,
} from './types.js';
