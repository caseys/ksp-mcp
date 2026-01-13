/**
 * MechJeb Types for kOS.MechJeb2.Addon
 */

export interface MechJebModules {
  available: boolean;
  version?: string;
  hasAscent: boolean;
  hasLanding: boolean;
  hasManeuver: boolean;
  hasRendezvous: boolean;
  allSuffixes: string[];
}

export interface VesselState {
  // Position
  altitudeTrue: number;
  altitudeASL: number;
  latitude: number;
  longitude: number;

  // Velocity
  speedSurface: number;
  speedOrbital: number;
  speedVertical: number;

  // Attitude
  heading: number;
  pitch: number;
  roll: number;

  // Aerodynamics
  dynamicPressure: number;
  angleOfAttack: number;
  mach: number;
}

export interface OrbitInfo {
  apoapsis: number;
  periapsis: number;
  period: number;
  inclination: number;
  eccentricity: number;
  lan: number;  // Longitude of ascending node
  altitude?: number;  // Current altitude (meters)
  speed?: number;     // Surface speed (m/s)
}

export interface MechJebInfo {
  // Performance
  surfaceTWR: number;
  localTWR: number;
  currentThrust: number;
  maxThrust: number;
  acceleration: number;

  // Maneuver
  nextNodeDeltaV?: number;
  timeToManeuverNode?: number;

  // Other
  timeToImpact?: number;
  escapeVelocity?: number;
}

export interface AscentSettings {
  desiredAltitude: number;
  desiredInclination: number;
  autostage: boolean;
  skipCircularization: boolean;
  autowarp: boolean;

  // Gravity turn profile
  turnStartAltitude?: number;
  turnStartVelocity?: number;
  turnEndAltitude?: number;
  turnEndAngle?: number;
  turnShapeExponent?: number;
  autoPath?: boolean;

  // Limits
  limitAoA?: boolean;
  maxAoA?: number;
  limitQEnabled?: boolean;
  limitQ?: number;

  // Roll control
  forceRoll?: boolean;
  verticalRoll?: number;
  turnRoll?: number;

  // Launch mode settings (for Launch to Plane / Launch to Rendezvous)
  launchingToPlane?: boolean;
  launchingToRendezvous?: boolean;
  launchPhaseAngle?: number;
  launchLANDifference?: number;
  desiredLan?: number;
  overrideWarpToPlane?: boolean;
}

export interface AscentStatus {
  enabled: boolean;
  ascentType: string;
  settings: Partial<AscentSettings>;
}

export interface AscentProgress {
  phase: 'prelaunch' | 'launching' | 'gravity_turn' | 'coasting' | 'circularizing' | 'complete' | 'unknown';
  altitude: number;
  apoapsis: number;
  periapsis: number;
  enabled: boolean;
  shipStatus: string;
}

export interface AscentResult {
  success: boolean;
  finalOrbit: {
    apoapsis: number;
    periapsis: number;
  };
  aborted: boolean;
}

/** Launch mode for ascent guidance */
export type LaunchMode = 'orbit' | 'rendezvous' | 'plane';

export interface LaunchOptions {
  /** Target orbit altitude in meters */
  altitude: number;
  /** Target orbit inclination in degrees (default: 0) */
  inclination?: number;
  /** Enable automatic staging (default: true) */
  autoStage?: boolean;
  /** Circularize orbit after ascent (default: true) */
  circularize?: boolean;
  /** Auto-warp to maneuver nodes (default: true) */
  autoWarp?: boolean;

  // Launch mode options
  /** Launch mode: 'orbit' (default), 'rendezvous' (phase angle), or 'plane' (orbital plane) */
  launchMode?: LaunchMode;
  /** Target name for rendezvous/plane modes (required if launchMode is not 'orbit') */
  target?: string;
  // phaseAngle and lanDifference removed - always reset to 0 internally
}
