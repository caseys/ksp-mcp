// PROOF 1: Trigger Persistence Test - Part A (Install)
//
// This tests if WHEN triggers survive after the program exits.
// This is CRITICAL - if triggers don't persist, the architecture fails.
//
// INSTRUCTIONS:
// 1. Run this script: RUNPATH("0:/proofs/proof1_install_trigger").
// 2. Wait for it to exit (you'll see "Trigger installed, program exiting...")
// 3. Optionally run another script or just wait
// 4. Run the check: RUNPATH("0:/proofs/proof1_check_trigger").
// 5. PASS if _PROOF1_FIRED is TRUE

@LAZYGLOBAL OFF.

// Reset test state
GLOBAL _PROOF1_FIRED IS FALSE.
GLOBAL _PROOF1_COUNT IS 0.
GLOBAL _PROOF1_INITIAL_STATUS IS SHIP:STATUS.

PRINT "=== PROOF 1: Trigger Persistence ===".
PRINT "Initial SHIP:STATUS: " + SHIP:STATUS.
PRINT "Installing WHEN trigger...".

// Install a trigger that fires when status changes OR on any physics tick
// We use a time-based trigger to ensure it fires even without status change
GLOBAL _PROOF1_START IS TIME:SECONDS.

WHEN TIME:SECONDS > _PROOF1_START + 2 THEN {
    SET _PROOF1_FIRED TO TRUE.
    SET _PROOF1_COUNT TO _PROOF1_COUNT + 1.
    // Don't PRESERVE - we only need it to fire once
}

PRINT "Trigger installed!".
PRINT "Program exiting in 1 second...".
PRINT "(Trigger should fire 2 seconds after install)".
WAIT 1.
PRINT "Program exiting NOW. Run proof1_check_trigger in ~3 seconds.".
