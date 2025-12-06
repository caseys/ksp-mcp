/**
 * kOS Output Parser Utilities
 *
 * Helpers for parsing labeled output from batched kOS commands.
 *
 * Example usage:
 *   // kOS command: PRINT "ALT:" + ALTITUDE. PRINT "APO:" + APOAPSIS.
 *   // Output: "ALT:85000\nAPO:100000"
 *   const parsed = parseLabeled(output);
 *   // { ALT: "85000", APO: "100000" }
 */

/**
 * Parse labeled output from batched kOS PRINT commands.
 *
 * Expected format: "LABEL:value" on each line.
 * Example: "ALT:85000\nAPO:100000\nENA:True"
 *
 * @param output Raw kOS output string
 * @returns Record mapping labels to their string values
 */
export function parseLabeled(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = output.split('\n');

  for (const line of lines) {
    // Match LABEL:value pattern (label must be alphanumeric/underscore)
    const match = line.match(/^(\w+):(.*)$/);
    if (match) {
      result[match[1]] = match[2].trim();
    }
  }

  return result;
}

/**
 * Parse a labeled value as a number.
 * Returns 0 if not found or not parseable.
 */
export function parseLabeledNumber(output: string, label: string): number {
  const parsed = parseLabeled(output);
  const value = parsed[label];
  if (!value) return 0;

  // Handle scientific notation and negative numbers
  const num = parseFloat(value);
  return isNaN(num) ? 0 : num;
}

/**
 * Parse a labeled value as a boolean.
 * Returns false if not found.
 */
export function parseLabeledBool(output: string, label: string): boolean {
  const parsed = parseLabeled(output);
  const value = parsed[label];
  return value?.toLowerCase() === 'true';
}

/**
 * Parse multiple labeled numbers at once.
 *
 * @param output Raw kOS output
 * @param labels Labels to extract
 * @returns Object with numeric values (0 for missing/invalid)
 */
export function parseLabeledNumbers(
  output: string,
  labels: string[]
): Record<string, number> {
  const parsed = parseLabeled(output);
  const result: Record<string, number> = {};

  for (const label of labels) {
    const value = parsed[label];
    result[label] = value ? parseFloat(value) || 0 : 0;
  }

  return result;
}

/**
 * Parse time string like "31m 10s" or "5h 23m 10s" to seconds.
 * Also handles plain numeric values (already in seconds).
 */
export function parseTimeString(output: string): number {
  // Try standard number first (pure seconds)
  const numMatch = output.match(/^[\s\S]*?([\d.]+)\s*$/);
  if (numMatch) {
    const val = parseFloat(numMatch[1]);
    if (!isNaN(val) && val > 0) return val;
  }

  // Parse human-readable format: Xh Ym Zs
  let seconds = 0;
  const hoursMatch = output.match(/(\d+)\s*h/i);
  const minsMatch = output.match(/(\d+)\s*m/i);
  const secsMatch = output.match(/(\d+)\s*s/i);

  if (hoursMatch) seconds += parseInt(hoursMatch[1]) * 3600;
  if (minsMatch) seconds += parseInt(minsMatch[1]) * 60;
  if (secsMatch) seconds += parseInt(secsMatch[1]);

  return seconds;
}

/**
 * Parse a numeric value from kOS output (legacy - for backwards compatibility).
 * Looks for patterns like "23.80  m/s" or just bare numbers.
 */
export function parseNumber(output: string): number {
  // First try to find a number with units (e.g., "23.80  m/s")
  const withUnits = output.match(/(\d+(?:\.\d+)?)\s*m\/s/i);
  if (withUnits) {
    return parseFloat(withUnits[1]);
  }

  // Otherwise find all numbers that start with a digit
  const allNumbers = output.match(/\d+(?:\.\d+)?(?:E[+-]?\d+)?/gi);
  if (allNumbers && allNumbers.length > 0) {
    // Take the last number which is most likely the actual value
    return parseFloat(allNumbers[allNumbers.length - 1]);
  }

  return 0;
}
