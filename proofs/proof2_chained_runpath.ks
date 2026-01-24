// PROOF 2: Chained RUNPATH Test
//
// Tests if multiple RUNPATH commands on one line execute sequentially.
// This is CRITICAL for the pattern: RUNPATH("action"). RUNPATH("status").
//
// INSTRUCTIONS:
// 1. Run: RUNPATH("0:/proofs/proof2_chained_runpath").
// 2. PASS if you see both "Script A" and "Script B" messages in order.

@LAZYGLOBAL OFF.

PRINT "=== PROOF 2: Chained RUNPATH ===".
PRINT "This script will chain two RUNPATH calls...".
PRINT "".

// Create helper scripts dynamically
LOG "@LAZYGLOBAL OFF." TO "0:/proofs/_proof2a.ks".
LOG "PRINT \"[A] Script A executed at \" + TIME:SECONDS." TO "0:/proofs/_proof2a.ks".
LOG "GLOBAL _PROOF2_A_RAN IS TRUE." TO "0:/proofs/_proof2a.ks".

LOG "@LAZYGLOBAL OFF." TO "0:/proofs/_proof2b.ks".
LOG "PRINT \"[B] Script B executed at \" + TIME:SECONDS." TO "0:/proofs/_proof2b.ks".
LOG "GLOBAL _PROOF2_B_RAN IS TRUE." TO "0:/proofs/_proof2b.ks".

PRINT "Helper scripts created. Now testing chain...".
PRINT "Executing: RUNPATH(_proof2a). RUNPATH(_proof2b).".
PRINT "---".

// Reset state
SET _PROOF2_A_RAN TO FALSE.
SET _PROOF2_B_RAN TO FALSE.

// THE CRITICAL TEST: Do both scripts run?
RUNPATH("0:/proofs/_proof2a"). RUNPATH("0:/proofs/_proof2b").

// If we get here, check results
PRINT "---".
IF _PROOF2_A_RAN AND _PROOF2_B_RAN {
    PRINT "PASS: Both scripts executed!".
    PRINT "Chained RUNPATH works as expected.".
    PRINT "".
    PRINT "This confirms we can use:".
    PRINT "  RUNPATH(action). RUNPATH(status).".
} ELSE {
    PRINT "FAIL: Not all scripts ran!".
    PRINT "A ran: " + _PROOF2_A_RAN.
    PRINT "B ran: " + _PROOF2_B_RAN.
}

// Cleanup
DELETEPATH("0:/proofs/_proof2a.ks").
DELETEPATH("0:/proofs/_proof2b.ks").
