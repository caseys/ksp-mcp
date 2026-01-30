/**
 * Shared utilities for MechJeb landing operations
 *
 * Provides access to MechJeb's landing autopilot for:
 * - Starting/stopping powered descent
 * - Configuration (touchdown speed, gear/chute deployment)
 * - Landing predictions
 */

import type { KosConnection } from '../../../transport/kos-connection.js';
import { formatTime, fmtDist, fmtVel, formatMeasurements } from '../../utils/format.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Landing autopilot status
 */
export interface LandingStatus {
  enabled: boolean;
  status: string;           // "Powered descent", "Waiting to land", etc.
  landingAtTarget: boolean; // True if landing at position target
  predictionReady: boolean;
  predictedLat?: number;
  predictedLng?: number;
  predictedAlt?: number;    // ASL meters
  predictedOutcome?: string; // LANDED, AEROBRAKED, NO_REENTRY, etc.
  timeToLanding?: number;   // seconds
  speed?: number;           // Vertical speed in m/s (negative = descending)
  altitude?: number;        // Radar altitude (above ground) in meters
  formatted: string;
}

/**
 * Landing configuration settings
 */
export interface LandingConfig {
  touchdownSpeed: number;   // m/s
  deployGears: boolean;
  deployChutes: boolean;
  useRCS: boolean;
  gearStage: number;
  chuteStage: number;
}

/**
 * Landing prediction data
 */
export interface LandingPrediction {
  ready: boolean;
  latitude?: number;
  longitude?: number;
  altitude?: number;        // ASL meters
  time?: number;            // UT
  timeToLanding?: number;   // seconds from now
  outcome?: string;         // LANDED, AEROBRAKED, NO_REENTRY, etc.
  maxAllowedSpeed?: number; // m/s
  decelEndAltitude?: number; // meters
  usingAtmosphere?: boolean;
  chutesReady?: boolean;
  formatted: string;
}

/**
 * Position target for landing (internal use)
 */
interface PositionTarget {
  latitude: number;
  longitude: number;
  body: string;
}

// Silence unused warning for internal type
void (undefined as unknown as PositionTarget);

// ============================================================================
// Landing Status
// ============================================================================

/**
 * Clean up MechJeb status strings:
 * - Add newline before "Course correction" (MechJeb concatenates without separator)
 * - Format measurements (distances, velocities, times) using formatMeasurements()
 */
function formatMechJebStatus(status: string): string {
  let result = status;

  // Add newline before "Course correction" (MechJeb concatenates status lines)
  result = result.replaceAll(/(\S)(Course correction)/g, '$1\n$2');

  // Format all embedded measurements (distances, velocities, times)
  result = formatMeasurements(result);

  return result;
}

/**
 * Get current landing autopilot status
 */
export async function getLandingStatus(conn: KosConnection): Promise<LandingStatus> {
  // Query all landing status info in one command
  const result = await conn.queue(
    'SET LAND TO ADDONS:MJ:LANDING. ' +
    'PRINT "LSTAT|" + LAND:ENABLED + "|" + LAND:STATUS + "|" + LAND:LANDATTARGET + "|" + ' +
    'LAND:PREDICTIONREADY + "|" + LAND:PREDICTEDLAT + "|" + LAND:PREDICTEDLNG + "|" + ' +
    'LAND:PREDICTEDALT + "|" + LAND:PREDICTEDOUTCOME + "|" + LAND:PREDICTEDUT + "|" + TIME:SECONDS + "|" + ' +
    'ROUND(SHIP:VERTICALSPEED) + "|" + ROUND(ALT:RADAR).',
    5000
  );

  const match = result.output.match(
    /LSTAT\|(True|False)\|([^|]*)\|(True|False)\|(True|False)\|([-\d.]+)\|([-\d.]+)\|([-\d.]+)\|(\w+)\|([-\d.E+]+)\|([-\d.E+]+)\|([-\d]+)\|([-\d]+)/i
  );

  if (!match) {
    // Throw error so resilience utility treats this as a connection issue
    // (common during blackout recovery when we get partial/garbage data)
    throw new Error(`Failed to parse landing status: ${result.output.slice(0, 100)}`);
  }

  const enabled = match[1].toLowerCase() === 'true';
  const status = formatMechJebStatus(match[2].trim() || 'Idle');
  const landingAtTarget = match[3].toLowerCase() === 'true';
  const predictionReady = match[4].toLowerCase() === 'true';
  const predictedLat = Number.parseFloat(match[5]);
  const predictedLng = Number.parseFloat(match[6]);
  const predictedAlt = Number.parseFloat(match[7]);
  const predictedOutcome = match[8];
  const predictedUT = Number.parseFloat(match[9]);
  const currentUT = Number.parseFloat(match[10]);
  const speed = Number.parseInt(match[11]);
  const altitude = Number.parseInt(match[12]);
  const timeToLanding = predictionReady ? Math.max(0, predictedUT - currentUT) : undefined;

  // Build formatted output
  let formatted = `Landing autopilot: ${enabled ? 'ACTIVE' : 'inactive'}\n`;
  if (enabled) {
    formatted += `Status: ${status}\n`;
    formatted += `Mode: ${landingAtTarget ? 'targeted' : 'untargeted'}\n`;
  }
  if (predictionReady) {
    formatted += `Predicted landing: ${predictedLat.toFixed(3)}°, ${predictedLng.toFixed(3)}°\n`;
    formatted += `Predicted altitude: ${fmtDist(predictedAlt)} ASL\n`;
    formatted += `Outcome: ${predictedOutcome}\n`;
    if (timeToLanding !== undefined) {
      formatted += `Time to landing: ${formatTime(timeToLanding)}`;
    }
  } else {
    formatted += 'Prediction: not ready';
  }

  return {
    enabled,
    status,
    landingAtTarget,
    predictionReady,
    predictedLat: predictionReady ? predictedLat : undefined,
    predictedLng: predictionReady ? predictedLng : undefined,
    predictedAlt: predictionReady ? predictedAlt : undefined,
    predictedOutcome: predictionReady ? predictedOutcome : undefined,
    timeToLanding,
    speed,
    altitude,
    formatted,
  };
}

// ============================================================================
// Landing Configuration
// ============================================================================

/**
 * Get current landing configuration
 */
export async function getLandingConfig(conn: KosConnection): Promise<LandingConfig> {
  const result = await conn.queue(
    'SET LAND TO ADDONS:MJ:LANDING. ' +
    'PRINT "LCFG|" + LAND:TOUCHDOWNSPEED + "|" + LAND:DEPLOYGEARS + "|" + LAND:DEPLOYCHUTES + "|" + ' +
    'LAND:RCSADJUSTMENT + "|" + LAND:LIMITGEARSSTAGE + "|" + LAND:LIMITCHUTESSTAGE.',
    3000
  );

  const match = result.output.match(
    /LCFG\|([-\d.]+)\|(True|False)\|(True|False)\|(True|False)\|([-\d]+)\|([-\d]+)/i
  );

  if (!match) {
    console.log('[getLandingConfig] Failed to parse result:', result.output);
    return {
      touchdownSpeed: 2,
      deployGears: true,
      deployChutes: true,
      useRCS: true,
      gearStage: 0,
      chuteStage: 0,
    };
  }

  return {
    touchdownSpeed: Number.parseFloat(match[1]),
    deployGears: match[2].toLowerCase() === 'true',
    deployChutes: match[3].toLowerCase() === 'true',
    useRCS: match[4].toLowerCase() === 'true',
    gearStage: Number.parseInt(match[5]),
    chuteStage: Number.parseInt(match[6]),
  };
}

/**
 * Set landing configuration
 */
export async function setLandingConfig(
  conn: KosConnection,
  config: Partial<LandingConfig>
): Promise<void> {
  const commands: string[] = ['SET LAND TO ADDONS:MJ:LANDING.'];

  if (config.touchdownSpeed !== undefined) {
    commands.push(`SET LAND:TOUCHDOWNSPEED TO ${config.touchdownSpeed}.`);
  }
  if (config.deployGears !== undefined) {
    commands.push(`SET LAND:DEPLOYGEARS TO ${config.deployGears ? 'TRUE' : 'FALSE'}.`);
  }
  if (config.deployChutes !== undefined) {
    commands.push(`SET LAND:DEPLOYCHUTES TO ${config.deployChutes ? 'TRUE' : 'FALSE'}.`);
  }
  if (config.useRCS !== undefined) {
    commands.push(`SET LAND:RCSADJUSTMENT TO ${config.useRCS ? 'TRUE' : 'FALSE'}.`);
  }
  if (config.gearStage !== undefined) {
    commands.push(`SET LAND:LIMITGEARSSTAGE TO ${config.gearStage}.`);
  }
  if (config.chuteStage !== undefined) {
    commands.push(`SET LAND:LIMITCHUTESSTAGE TO ${config.chuteStage}.`);
  }

  await conn.raw(commands.join(' '), 5000);
}

// ============================================================================
// Position Target (for landing)
// ============================================================================

/**
 * Set position target for landing
 */
export async function setLandingPositionTarget(
  conn: KosConnection,
  latitude: number,
  longitude: number
): Promise<{ success: boolean; error?: string }> {
  if (latitude < -90 || latitude > 90) {
    return { success: false, error: 'Latitude must be between -90 and 90' };
  }
  if (longitude < -180 || longitude > 180) {
    return { success: false, error: 'Longitude must be between -180 and 180' };
  }

  // Set target and verify it was set correctly on the current body
  const result = await conn.queue(
    `SET TGT TO ADDONS:MJ:TARGET. TGT:SETTARGET(${latitude}, ${longitude}). ` +
    `IF TGT:POSITIONTARGETEXISTS AND TGT:TARGETBODY = SHIP:BODY:NAME { PRINT "OK". } ` +
    `ELSE { PRINT "FAIL|" + TGT:POSITIONTARGETEXISTS + "|" + TGT:TARGETBODY. }`,
    5000
  );

  if (!result.success) {
    return { success: false, error: result.error ?? 'Failed to set position target' };
  }

  if (result.output.includes('OK')) {
    return { success: true };
  }

  // Parse failure info for better error message
  const failMatch = result.output.match(/FAIL\|(True|False)\|(.+)/i);
  if (failMatch) {
    const exists = failMatch[1].toLowerCase() === 'true';
    const targetBody = failMatch[2].trim();
    if (!exists) {
      return { success: false, error: 'Failed to set position target (target not created)' };
    } else {
      return { success: false, error: `Position target set for ${targetBody} but ship is at different body` };
    }
  }

  return { success: false, error: 'Failed to set position target' };
}

/**
 * Set KSC as position target for landing
 */
export async function setLandingPositionTargetKSC(
  conn: KosConnection
): Promise<{ success: boolean; error?: string }> {
  const result = await conn.queue(
    'SET TGT TO ADDONS:MJ:TARGET. PRINT TGT:SETTARGETKSC().',
    5000
  );

  return {
    success: result.output.includes('True'),
    error: result.output.includes('True') ? undefined : 'Failed to set KSC target',
  };
}

/**
 * Check if a position target is currently set
 */
export async function hasLandingPositionTarget(conn: KosConnection): Promise<boolean> {
  const result = await conn.queue(
    'SET TGT TO ADDONS:MJ:TARGET. PRINT TGT:POSITIONTARGETEXISTS.',
    3000
  );
  return result.output.includes('True');
}

// ============================================================================
// Landing Control
// ============================================================================

/**
 * Start landing at position target
 */
export async function startTargetedLanding(
  conn: KosConnection
): Promise<{ success: boolean; error?: string }> {
  // Enable autowarp via Node module (landing autopilot reads Core.Node.Autowarp)
  const result = await conn.queue(
    'SET ADDONS:MJ:NODE:AUTOWARP TO TRUE. ' +
    'SET LAND TO ADDONS:MJ:LANDING. PRINT LAND:LANDATPOSITIONTARGET().',
    5000
  );

  const success = result.output.includes('True');
  if (!success) {
    return {
      success: false,
      error: 'Failed to start targeted landing. Ensure a position target is set.',
    };
  }

  return { success: true };
}

/**
 * Start untargeted landing (land anywhere)
 */
export async function startUntargetedLanding(
  conn: KosConnection
): Promise<{ success: boolean; error?: string }> {
  // Enable autowarp via Node module (landing autopilot reads Core.Node.Autowarp)
  const result = await conn.queue(
    'SET ADDONS:MJ:NODE:AUTOWARP TO TRUE. ' +
    'SET LAND TO ADDONS:MJ:LANDING. PRINT LAND:LANDUNTARGETED().',
    5000
  );

  const success = result.output.includes('True');
  if (!success) {
    return {
      success: false,
      error: 'Failed to start untargeted landing.',
    };
  }

  return { success: true };
}


// ============================================================================
// Landing Prediction
// ============================================================================

/**
 * Get detailed landing prediction
 */
export async function getLandingPrediction(conn: KosConnection): Promise<LandingPrediction> {
  const result = await conn.queue(
    'SET LAND TO ADDONS:MJ:LANDING. ' +
    'PRINT "LPRED|" + LAND:PREDICTIONREADY + "|" + LAND:PREDICTEDLAT + "|" + ' +
    'LAND:PREDICTEDLNG + "|" + LAND:PREDICTEDALT + "|" + LAND:PREDICTEDUT + "|" + ' +
    'LAND:PREDICTEDOUTCOME + "|" + LAND:MAXALLOWEDSPEED + "|" + LAND:DECELERATIONENDALT + "|" + ' +
    'LAND:USEATMOSPHERETOBRAKE + "|" + LAND:PARACHUTESDEPLOYABLE + "|" + TIME:SECONDS.',
    5000
  );

  const match = result.output.match(
    /LPRED\|(True|False)\|([-\d.]+)\|([-\d.]+)\|([-\d.]+)\|([-\d.E+]+)\|(\w+)\|([-\d.]+)\|([-\d.]+)\|(True|False)\|(True|False)\|([-\d.E+]+)/i
  );

  if (!match) {
    console.log('[getLandingPrediction] Failed to parse result:', result.output);
    return {
      ready: false,
      formatted: 'Landing prediction not available. Start descent or deorbit burn to get predictions.',
    };
  }

  const ready = match[1].toLowerCase() === 'true';
  const latitude = Number.parseFloat(match[2]);
  const longitude = Number.parseFloat(match[3]);
  const altitude = Number.parseFloat(match[4]);
  const time = Number.parseFloat(match[5]);
  const outcome = match[6];
  const maxAllowedSpeed = Number.parseFloat(match[7]);
  const decelEndAltitude = Number.parseFloat(match[8]);
  const usingAtmosphere = match[9].toLowerCase() === 'true';
  const chutesReady = match[10].toLowerCase() === 'true';
  const currentUT = Number.parseFloat(match[11]);
  const timeToLanding = ready ? Math.max(0, time - currentUT) : undefined;

  // Build formatted output
  let formatted: string;
  if (!ready) {
    formatted = 'Landing prediction: not ready\nStart descent or deorbit burn to get predictions.';
  } else {
    formatted = `Landing prediction:\n`;
    formatted += `  Location: ${latitude.toFixed(3)}°, ${longitude.toFixed(3)}°\n`;
    formatted += `  Altitude: ${fmtDist(altitude)} ASL\n`;
    formatted += `  Outcome: ${outcome}\n`;
    if (timeToLanding !== undefined) {
      formatted += `  Time to landing: ${formatTime(timeToLanding)}\n`;
    }
    formatted += `  Max safe speed: ${fmtVel(maxAllowedSpeed)}\n`;
    formatted += `  Decel end altitude: ${fmtDist(decelEndAltitude)}\n`;
    formatted += `  Using atmosphere: ${usingAtmosphere ? 'yes' : 'no'}\n`;
    formatted += `  Parachutes ready: ${chutesReady ? 'yes' : 'no'}`;
  }

  return {
    ready,
    latitude: ready ? latitude : undefined,
    longitude: ready ? longitude : undefined,
    altitude: ready ? altitude : undefined,
    time: ready ? time : undefined,
    timeToLanding,
    outcome: ready ? outcome : undefined,
    maxAllowedSpeed: ready ? maxAllowedSpeed : undefined,
    decelEndAltitude: ready ? decelEndAltitude : undefined,
    usingAtmosphere: ready ? usingAtmosphere : undefined,
    chutesReady: ready ? chutesReady : undefined,
    formatted,
  };
}

