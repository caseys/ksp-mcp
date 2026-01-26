// =======================================
// RCS Pulse Alignment - MUST be defined from interpreter, not script!
// =======================================
//
// WHEN triggers defined in scripts get garbage collected when program ends.
// WHEN triggers defined from interpreter persist.
//
// Time-gated pattern (no WAIT inside trigger - bad pattern):
//
//   SAS OFF.
//   LOCK STEERING TO LOOKDIRUP(NEXTNODE:BURNVECTOR, SHIP:FACING:TOPVECTOR).
//   SET LAST_TICK TO 0.
//   SET RCS_STATE TO FALSE.
//   WHEN HASNODE AND VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR) > 1
//        AND TIME:SECONDS - LAST_TICK >= 0.25 THEN {
//       SET LAST_TICK TO TIME:SECONDS.
//       SET RCS_STATE TO NOT RCS_STATE.
//       SET RCS TO RCS_STATE.
//       PRESERVE.
//   }
//
// Cleanup when done:
//   UNLOCK STEERING.
//   SET RCS TO FALSE.
//
// This is implemented in TypeScript: src/lib/mechjeb/execute-node.ts runAlignScript()

PRINT "See script comments for RCS pulse alignment pattern.".
