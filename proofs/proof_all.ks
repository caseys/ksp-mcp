// PROOF ALL: Run all non-interactive proofs
//
// Runs proofs 2-5 in sequence (proof 1 requires two separate runs).
//
// INSTRUCTIONS:
// 1. First run proof 1 manually (two-part test)
// 2. Then run: RUNPATH("0:/proofs/proof_all").

@LAZYGLOBAL OFF.

PRINT "".
PRINT "========================================".
PRINT "  NEW WORLD ARCHITECTURE PROOF SUITE".
PRINT "========================================".
PRINT "".
PRINT "NOTE: Proof 1 (trigger persistence) must be".
PRINT "run separately as a two-part test.".
PRINT "".
WAIT 2.

PRINT "--- Running Proof 2: Chained RUNPATH ---".
RUNPATH("0:/proofs/proof2_chained_runpath").
PRINT "".
WAIT 2.

PRINT "--- Running Proof 3: Ready Marker ---".
RUNPATH("0:/proofs/proof3_ready_marker").
PRINT "".
WAIT 2.

PRINT "--- Running Proof 4: MOVEPATH ---".
RUNPATH("0:/proofs/proof4_movepath").
PRINT "".
WAIT 2.

PRINT "--- Running Proof 5: Trigger Timing ---".
RUNPATH("0:/proofs/proof5_trigger_timing").
PRINT "".

PRINT "========================================".
PRINT "  PROOF SUITE COMPLETE".
PRINT "========================================".
PRINT "".
PRINT "Review results above. Key questions:".
PRINT "1. Did Proof 2 show both scripts ran?".
PRINT "2. Did Proof 3 show JSON + ready marker?".
PRINT "3. Did Proof 4 show atomic MOVEPATH?".
PRINT "4. When did Proof 5 triggers fire?".
PRINT "".
PRINT "Don't forget to run Proof 1 separately!".
