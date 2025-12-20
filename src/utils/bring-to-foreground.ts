/**
 * Cross-platform utility to bring KSP window to foreground
 *
 * KSP locks certain operations (like target switching) when backgrounded.
 * This utility brings the window to focus before such operations.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const platform = process.platform;

/**
 * Bring KSP window to the foreground.
 *
 * @returns true if successful, false if failed (logs warning but doesn't throw)
 */
export async function bringKspToForeground(): Promise<boolean> {
  try {
    if (platform === 'darwin') {
      // macOS: Use AppleScript
      await execAsync('osascript -e \'tell application "KSP" to activate\'');
      return true;
    }

    if (platform === 'win32') {
      // Windows: Use PowerShell to find and activate KSP window
      const script = `
        Add-Type @"
          using System;
          using System.Runtime.InteropServices;
          public class Win32 {
            [DllImport("user32.dll")]
            public static extern bool SetForegroundWindow(IntPtr hWnd);
          }
"@
        $ksp = Get-Process -Name "KSP*" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($ksp) {
          [Win32]::SetForegroundWindow($ksp.MainWindowHandle)
          exit 0
        }
        exit 1
      `.trim();
      await execAsync(`powershell -Command "${script.replaceAll('"', String.raw`\"`)}"`);
      return true;
    }

    if (platform === 'linux') {
      // Linux: Try wmctrl first, fall back to xdotool
      try {
        await execAsync('wmctrl -a "Kerbal Space Program"');
        return true;
      } catch {
        try {
          await execAsync('xdotool search --name "Kerbal Space Program" windowactivate');
          return true;
        } catch {
          console.error('[bringKspToForeground] Neither wmctrl nor xdotool available on Linux');
          return false;
        }
      }
    }

    console.error(`[bringKspToForeground] Unsupported platform: ${platform}`);
    return false;
  } catch (error) {
    console.error('[bringKspToForeground] Failed to bring KSP to foreground:', error);
    return false;
  }
}
