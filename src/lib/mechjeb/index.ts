/**
 * MechJeb Client
 *
 * Main interface for controlling MechJeb via kOS
 */

import type { KosConnection } from '../../transport/kos-connection.js';
import type { MechJebModules, VesselState, OrbitInfo, MechJebInfo } from '../types.js';
import { discoverModules, isMechJebAvailable, discoverAscentSuffixes } from './discovery.js';
import { getVesselState, getOrbitInfo, getMechJebInfo, getQuickStatus } from './telemetry.js';
import { AscentProgram } from './ascent.js';
import { ManeuverProgram } from './maneuver.js';

export class MechJebClient {
  private _ascent: AscentProgram | null = null;
  private _maneuver: ManeuverProgram | null = null;
  private _modules: MechJebModules | null = null;

  constructor(private conn: KosConnection) {}

  /**
   * Check if MechJeb is available on the current vessel
   */
  async isAvailable(): Promise<boolean> {
    return isMechJebAvailable(this.conn);
  }

  /**
   * Discover what MechJeb modules are available
   */
  async discoverModules(): Promise<MechJebModules> {
    this._modules = await discoverModules(this.conn);
    return this._modules;
  }

  /**
   * Get cached module info (call discoverModules first)
   */
  get modules(): MechJebModules | null {
    return this._modules;
  }

  /**
   * Get Ascent Program interface
   */
  get ascent(): AscentProgram {
    if (!this._ascent) {
      this._ascent = new AscentProgram(this.conn);
    }
    return this._ascent;
  }

  /**
   * Get Maneuver Program interface
   */
  get maneuver(): ManeuverProgram {
    if (!this._maneuver) {
      this._maneuver = new ManeuverProgram(this.conn);
    }
    return this._maneuver;
  }

  get rendezvous(): null {
    // TODO: Implement when available in kOS.MechJeb2.Addon
    return null;
  }

  get landing(): null {
    // TODO: Implement when available in kOS.MechJeb2.Addon
    return null;
  }

  // Telemetry methods

  /**
   * Get full vessel state from MechJeb
   */
  async getVesselState(): Promise<VesselState> {
    return getVesselState(this.conn);
  }

  /**
   * Get orbital parameters
   */
  async getOrbitInfo(): Promise<OrbitInfo> {
    return getOrbitInfo(this.conn);
  }

  /**
   * Get MechJeb calculated info (TWR, delta-V, etc.)
   */
  async getInfo(): Promise<MechJebInfo> {
    return getMechJebInfo(this.conn);
  }

  /**
   * Quick status query (minimal latency)
   */
  async getQuickStatus() {
    return getQuickStatus(this.conn);
  }

  /**
   * Discover what suffixes are available on the ascent module
   * (useful for debugging/exploring the API)
   */
  async getAscentSuffixes(): Promise<string[]> {
    return discoverAscentSuffixes(this.conn);
  }

  /**
   * Execute a raw MechJeb command (for advanced use)
   */
  async raw(command: string): Promise<string> {
    const result = await this.conn.execute(command);
    return result.output;
  }
}
