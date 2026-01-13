/**
 * Formatting utilities for human-readable output
 */

/**
 * Format seconds into human-readable time
 * Examples: "45 seconds", "2 minutes 30 seconds", "1 hours 15 minutes", "2 days 4 hours"
 */
export function formatTime(seconds: number): string {
  const s = Math.abs(seconds);
  if (s < 60) return `${s.toFixed(0)}sec`;
  if (s < 3600) return `${Math.floor(s / 60)}min ${Math.floor(s % 60)}sec`;
  if (s < 86_400) return `${Math.floor(s / 3600)}hrs ${Math.floor((s % 3600) / 60)}min`;
  return `${Math.floor(s / 86_400)}days ${Math.floor((s % 86_400) / 3600)}hrs`;
}

/**
 * Format a number: whole numbers if |n| >= 1, decimals if |n| < 1
 */
function formatNum(n: number): string {
  if (Math.abs(n) < 1) {
    return n.toFixed(2);
  }
  return Math.round(n).toString();
}

/**
 * Format a number for display: whole numbers if |n| >= 1, decimals if |n| < 1
 * Examples: 45.3 → "45", 0.003 → "0.003", -0.5 → "-0.50"
 */
export function fmtNum(n: number): string {
  if (Math.abs(n) < 1) {
    // Keep 2 decimals for small values to preserve precision
    return n.toFixed(2);
  }
  return Math.round(n).toString();
}

/**
 * Format distance in meters: show km for values >= 10,000m
 * Examples: 5000 → "5000m", 15000 → "15km", 2227598 → "2228km"
 */
export function fmtDist(meters: number): string {
  if (Math.abs(meters) >= 10_000) {
    return `${fmtNum(meters / 1000)}km`;
  }
  return `${fmtNum(meters)}m`;
}

/**
 * Format orbit as "Ap by Pe" (e.g., "100km by 80km" or "100.5km by 80.2km")
 * TTS-friendly format with units on each value
 */
export function formatOrbit(apoapsisM: number, periapsisM: number): string {
  const apo = Math.abs(apoapsisM);
  const pe = Math.abs(periapsisM);

  // Use Mm if either value is >= 1,000,000m
  if (apo >= 1_000_000 || pe >= 1_000_000) {
    return `${formatNum(apoapsisM / 1_000_000)}Mm by ${formatNum(periapsisM / 1_000_000)}Mm`;
  }
  return `${formatNum(apoapsisM / 1000)}km by ${formatNum(periapsisM / 1000)}km`;
}

/**
 * Format Pe/Ap for display. If circular (within 10%), show single value.
 * Examples:
 *   - Circular: "100km" or "100km (circular)" if showCircularLabel=true
 *   - Elliptical: "Pe: 80km, Ap: 120km"
 */
export function fmtPeAp(periapsisM: number, apoapsisM: number, showCircularLabel = false): string {
  const pe = Math.abs(periapsisM);
  const ap = Math.abs(apoapsisM);

  // Check if circular: ap and pe within 10% of each other
  const isCircular = ap > 0 && Math.abs(ap - pe) / ap < 0.1;

  if (isCircular) {
    const avgAlt = (pe + ap) / 2;
    return showCircularLabel ? `${fmtDist(avgAlt)} (circular)` : fmtDist(avgAlt);
  }

  return `Pe: ${fmtDist(pe)}, Ap: ${fmtDist(ap)}`;
}

/**
 * Format velocity for TTS: @20m/sec or @-20m/sec
 * Note: number touches 'm' with no space for TTS clarity
 */
export function fmtVel(metersPerSecond: number): string {
  return `${Math.round(metersPerSecond)}_m/sec`;
}

/**
 * Format embedded measurements in a sentence or a raw number:
 * - If given a number, formats it as a distance (meters → km/Mm)
 * - If given a string with measurements:
 *   - Distances: "2400000m" → "2400km", "203m" → "203m"
 *   - Velocities: "27.2 m/s" or "27.2m/s" → "27_m/sec"
 *   - Times: "5s" or "30s" → "5sec" or "30sec"
 */
export function formatMeasurements(input: string | number): string {
  // If it's a number, format as distance
  if (typeof input === 'number') {
    return fmtDist(input);
  }

  let result = input;

  // Format velocities first (before distances, since m/s contains 'm')
  // Matches: "27.2 m/s", "27.2m/s", "100 m/s"
  result = result.replaceAll(/(\d+(?:\.\d+)?)\s*m\/s\b/g, (_, num) => {
    return fmtVel(parseFloat(num));
  });

  // Format distances: "2400000m", "203m" (but not "m/s" which was already handled)
  // Matches: digits followed by 'm' not followed by '/' or letters
  result = result.replaceAll(/(\d+(?:\.\d+)?)m(?![/a-z])/gi, (_, num) => {
    return fmtDist(parseFloat(num));
  });

  // Format times: "5s", "30s" (standalone seconds, not part of words)
  // Matches: digits followed by 's' at word boundary
  result = result.replaceAll(/(\d+(?:\.\d+)?)s\b/g, (_, num) => {
    return formatTime(parseFloat(num));
  });

  return result;
}
