/**
 * kOS Terminal Monitoring System
 *
 * Tracks kOS terminal output for error loop detection and status reporting.
 * Used by MCP resources to provide real-time insight into kOS execution state.
 */

export interface MonitorStatus {
  recentLines: string[];
  hasErrors: boolean;
  isLooping: boolean;
  errorPattern: string | null;
  errorCount: number;
  lastError: string | null;
}

export interface LoopDetection {
  isLooping: boolean;
  pattern?: string;
}

export class KosMonitor {
  private recentLines: string[] = [];
  private errorCounts: Map<string, number> = new Map();
  private lastError: string | null = null;
  private readonly maxLines = 100;
  private readonly errorPatterns = [
    /Error:/i,
    /Exception/i,
    /GET Suffix.*not found/i,
    /SET Suffix.*not found/i,
    /Tried to push Infinity/i,
    /null reference/i,
    /^kOS: /,  // kOS system messages often indicate problems
  ];

  /**
   * Track a new line of terminal output
   */
  trackLine(line: string): void {
    if (!line || line.trim().length === 0) {
      return;
    }

    const trimmedLine = line.trim();

    // Add to recent lines buffer
    this.recentLines.push(trimmedLine);
    if (this.recentLines.length > this.maxLines) {
      this.recentLines.shift();
    }

    // Track errors
    if (this.isErrorLine(trimmedLine)) {
      const key = this.normalizeError(trimmedLine);
      this.errorCounts.set(key, (this.errorCounts.get(key) || 0) + 1);
      this.lastError = trimmedLine;
    }
  }

  /**
   * Track multiple lines at once
   */
  trackLines(lines: string[]): void {
    for (const line of lines) this.trackLine(line);
  }

  /**
   * Check if a line matches error patterns
   */
  private isErrorLine(line: string): boolean {
    return this.errorPatterns.some(pattern => pattern.test(line));
  }

  /**
   * Normalize error message for counting duplicates
   * Removes specific values but keeps error type
   */
  private normalizeError(line: string): string {
    return line
      .replaceAll(/\d+/g, 'N')  // Replace numbers with N
      .replaceAll(/'[^']*'/g, "'X'")  // Replace quoted strings with 'X'
      .replaceAll(/"[^"]*"/g, '"X"')  // Replace quoted strings with "X"
      .slice(0, 100);  // Limit length
  }

  /**
   * Detect if terminal is stuck in an error loop
   * Returns true if same error appears 5+ times in last 20 lines
   */
  detectLoop(): LoopDetection {
    const recent = this.recentLines.slice(-20);
    const errorMap = new Map<string, number>();

    // Count normalized errors in recent lines
    for (const line of recent) {
      if (this.isErrorLine(line)) {
        const key = this.normalizeError(line);
        errorMap.set(key, (errorMap.get(key) || 0) + 1);
      }
    }

    // Find most common error
    let maxCount = 0;
    let patternKey = null;

    for (const [key, count] of errorMap.entries()) {
      if (count > maxCount) {
        maxCount = count;
        patternKey = key;
      }
    }

    // Loop detected if same error appears 5+ times
    if (maxCount >= 5 && patternKey) {
      return {
        isLooping: true,
        pattern: patternKey
      };
    }

    return { isLooping: false };
  }

  /**
   * Get current monitoring status
   */
  getStatus(): MonitorStatus {
    const loopCheck = this.detectLoop();

    return {
      recentLines: this.recentLines.slice(-50),  // Last 50 lines
      hasErrors: this.errorCounts.size > 0,
      isLooping: loopCheck.isLooping,
      errorPattern: loopCheck.pattern || null,
      errorCount: this.getTotalErrorCount(),
      lastError: this.lastError
    };
  }

  /**
   * Get total error count from current session
   */
  getTotalErrorCount(): number {
    let total = 0;
    for (const count of this.errorCounts.values()) {
      total += count;
    }
    return total;
  }

  /**
   * Get last error message
   */
  getLastError(): string | null {
    return this.lastError;
  }

  /**
   * Get recent lines (default: last 50)
   */
  getRecentLines(count: number = 50): string[] {
    return this.recentLines.slice(-count);
  }

  /**
   * Clear monitoring state
   * Call this when starting a new operation
   */
  clear(): void {
    this.recentLines = [];
    this.errorCounts.clear();
    this.lastError = null;
  }

  /**
   * Get summary statistics
   */
  getSummary(): string {
    const loopCheck = this.detectLoop();
    const errorCount = this.getTotalErrorCount();

    if (loopCheck.isLooping) {
      return `ERROR LOOP DETECTED: "${loopCheck.pattern}" (${errorCount} total errors)`;
    }

    if (errorCount > 0) {
      return `${errorCount} errors detected, last: "${this.lastError}"`;
    }

    return `No errors (${this.recentLines.length} lines tracked)`;
  }
}

// Singleton instance for global monitoring
export const globalKosMonitor = new KosMonitor();
