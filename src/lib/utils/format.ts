/**
 * Formatting utilities for human-readable output
 */

/**
 * Format seconds into human-readable time
 * Examples: "45 seconds", "2 minutes 30 seconds", "1 hours 15 minutes", "2 days 4 hours"
 */
export function formatTime(seconds: number): string {
  const s = Math.abs(seconds);
  if (s < 60) return `${s.toFixed(0)} seconds`;
  if (s < 3600) return `${Math.floor(s / 60)} minutes ${Math.floor(s % 60)} seconds`;
  if (s < 86_400) return `${Math.floor(s / 3600)} hours ${Math.floor((s % 3600) / 60)} minutes`;
  return `${Math.floor(s / 86_400)} days ${Math.floor((s % 86_400) / 3600)} hours`;
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
