// PROOF 1: Trigger Persistence Test - Part B (Check)
//
// Run this AFTER proof1_install_trigger has exited.
// Checks if the trigger fired after the installing program exited.

@LAZYGLOBAL OFF.

PRINT "=== PROOF 1: Checking Trigger ===".

IF NOT (DEFINED _PROOF1_FIRED) {
    PRINT "FAIL: _PROOF1_FIRED not defined!".
    PRINT "Did you run proof1_install_trigger first?".
} ELSE IF _PROOF1_FIRED {
    PRINT "PASS: Trigger persisted and fired!".
    PRINT "Fire count: " + _PROOF1_COUNT.
    PRINT "".
    PRINT "This confirms WHEN triggers survive program exit.".
    PRINT "The event-driven architecture is VIABLE.".
} ELSE {
    PRINT "PENDING: Trigger not yet fired.".
    PRINT "Wait a few more seconds and run this again.".
    PRINT "(Trigger set to fire 2s after install)".
}
