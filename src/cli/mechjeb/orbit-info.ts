#!/usr/bin/env node
/**
 * CLI: Get quick orbital parameters
 *
 * Usage: npm run orbit-info
 */

import { ensureConnected } from '../../transport/connection-tools.js';
import { getOrbitInfo } from '../../lib/mechjeb/telemetry.js';

async function main() {
  const conn = await ensureConnected();
  const info = await getOrbitInfo(conn);

  console.log('=== Orbital Parameters ===');
  console.log(`Apoapsis:     ${(info.apoapsis / 1000).toFixed(1)} km`);
  console.log(`Periapsis:    ${(info.periapsis / 1000).toFixed(1)} km`);
  console.log(`Period:       ${info.period.toFixed(0)} s`);
  console.log(`Inclination:  ${info.inclination.toFixed(2)}°`);
  console.log(`Eccentricity: ${info.eccentricity.toFixed(4)}`);
  console.log(`LAN:          ${info.lan.toFixed(2)}°`);

  await conn.disconnect();
}

main().catch(console.error);
