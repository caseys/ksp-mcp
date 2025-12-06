#!/usr/bin/env node
/**
 * Test targeting functionality
 * Usage: npm run test:targeting [target_name] [type]
 */

import { KosConnection } from '../transport/kos-connection.js';

async function main() {
  const targetName = process.argv[2] || 'Mun';
  const targetType = process.argv[3] as 'auto' | 'body' | 'vessel' || 'auto';

  console.log(`=== Test Targeting ===\n`);
  console.log(`Target: ${targetName}`);
  console.log(`Type: ${targetType}\n`);

  const conn = new KosConnection({
    cpuLabel: 'guidance',
  });

  try {
    console.log('1. Connecting to kOS...');
    await conn.connect();
    console.log('   Connected!\n');

    // Check current body
    console.log('2. Current location...');
    const locationResult = await conn.execute(
      'PRINT "Vessel: " + SHIP:NAME. ' +
      'PRINT "Orbiting: " + SHIP:BODY:NAME.'
    );
    console.log(`   ${locationResult.output.trim()}\n`);

    // Set target
    console.log(`3. Setting target to "${targetName}"...`);
    let setCmd: string;
    if (targetType === 'body') {
      setCmd = `SET TARGET TO BODY("${targetName}").`;
    } else if (targetType === 'vessel') {
      setCmd = `SET TARGET TO VESSEL("${targetName}").`;
    } else {
      setCmd = `SET TARGET TO "${targetName}".`;
    }

    await conn.execute(setCmd);

    // Verify target was set by checking HASTARGET
    const hasTargetResult = await conn.execute('PRINT HASTARGET.');

    if (!hasTargetResult.output.includes('True')) {
      console.log(`   ❌ Failed to set target "${targetName}"`);
      console.log('   The target may not exist or may not be loaded.\n');
      return;
    }

    // Get target info
    const verifyResult = await conn.execute(
      'PRINT "Target: " + TARGET:NAME + " (" + TARGET:TYPENAME + ")". ' +
      'IF TARGET:TYPENAME = "Body" { ' +
      '  PRINT "Radius: " + ROUND(TARGET:RADIUS / 1000, 1) + " km". ' +
      '} ELSE IF TARGET:TYPENAME = "Vessel" { ' +
      '  PRINT "Distance: " + ROUND(TARGET:DISTANCE / 1000, 1) + " km". ' +
      '}'
    );

    console.log(`   ✅ ${verifyResult.output.trim()}\n`);

    // Get detailed target info
    console.log('4. Target details...');
    const detailsResult = await conn.execute(
      'IF HASTARGET { ' +
      '  PRINT "Distance: " + ROUND(TARGET:DISTANCE / 1000, 1) + " km". ' +
      '  IF TARGET:TYPENAME = "Body" { ' +
      '    PRINT "Radius: " + ROUND(TARGET:RADIUS / 1000, 1) + " km". ' +
      '    IF SHIP:BODY <> TARGET { ' +
      '      PRINT "Orbital altitude: " + ROUND(TARGET:ALTITUDE / 1000, 1) + " km". ' +
      '      PRINT "Orbital period: " + ROUND(TARGET:ORBIT:PERIOD / 3600, 1) + " hours". ' +
      '    } ' +
      '  } ELSE IF TARGET:TYPENAME = "Vessel" { ' +
      '    PRINT "Status: " + TARGET:STATUS. ' +
      '    PRINT "Relative velocity: " + ROUND(TARGET:VELOCITY:ORBIT:MAG, 1) + " m/s". ' +
      '    IF TARGET:ORBIT:HASNEXTPATCH = FALSE { ' +
      '      PRINT "Orbiting: " + TARGET:BODY:NAME. ' +
      '    } ' +
      '  } ' +
      '}'
    );
    console.log(`   ${detailsResult.output.trim()}\n`);

    // Test getting target
    console.log('5. Testing GET target...');
    const getResult = await conn.execute(
      'IF HASTARGET { ' +
      '  PRINT "Current target is: " + TARGET:NAME. ' +
      '} ELSE { ' +
      '  PRINT "No target set". ' +
      '}'
    );
    console.log(`   ${getResult.output.trim()}\n`);

    // Test clearing target
    console.log('6. Clearing target...');
    await conn.execute('UNSET TARGET.');
    const clearResult = await conn.execute(
      'IF HASTARGET { ' +
      '  PRINT "Still have target: " + TARGET:NAME. ' +
      '} ELSE { ' +
      '  PRINT "Target cleared successfully". ' +
      '}'
    );
    console.log(`   ${clearResult.output.trim()}\n`);

    console.log('✅ Targeting test complete!\n');

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : String(error));
  } finally {
    await conn.disconnect();
    console.log('Disconnected.\n');
  }
}

main().catch(console.error);
