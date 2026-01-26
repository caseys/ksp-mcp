// =======================================
// DEPRECATED - Alignment is now done inline from TypeScript
// =======================================
//
// The alignment approach that works reliably:
//
// 1. WHEN triggers defined in SCRIPTS get garbage collected when program ends
// 2. WHEN triggers defined from INTERPRETER persist
//
// So alignment is done by sending commands directly from TypeScript, not via RUNPATH:
//
//   SAS OFF.
//   LOCK STEERING TO NEXTNODE:BURNVECTOR.
//   WHEN HASNODE AND VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR) > 1 THEN {
//       SET RCS TO NOT RCS.  // Toggle RCS on/off (pulse)
//       WAIT 0.25.           // Pulse interval
//       PRESERVE.            // Keep firing until condition becomes false
//   }
//
// The trigger self-stops when error < 1 degree (condition becomes false).
// Then cleanup with: UNLOCK STEERING. SET RCS TO FALSE.
//
// See: src/utils/kos-scripts.ts runAlignScript()

PRINT "This script is deprecated. See comments for new approach.".
