// PROOF 5: Trigger Timing During WAIT
//
// Tests when WHEN triggers fire relative to WAIT statements.
// This helps understand the execution model.
//
// INSTRUCTIONS:
// 1. Run: RUNPATH("0:/proofs/proof5_trigger_timing").
// 2. Observe when "TRIGGER" messages appear relative to "MAIN" messages.

@LAZYGLOBAL OFF.

PRINT "=== PROOF 5: Trigger Timing ===".
PRINT "".

GLOBAL _PROOF5_LOG IS LIST().
GLOBAL _PROOF5_START IS TIME:SECONDS.

FUNCTION logEvent {
    PARAMETER msg.
    LOCAL elapsed IS ROUND(TIME:SECONDS - _PROOF5_START, 2).
    LOCAL entry IS "[" + elapsed + "s] " + msg.
    _PROOF5_LOG:ADD(entry).
    PRINT entry.
}

logEvent("Installing triggers...").

// Trigger 1: Time-based (fires after 1 second)
WHEN TIME:SECONDS > _PROOF5_START + 1 THEN {
    logEvent("TRIGGER-TIME: 1s elapsed").
}

// Trigger 2: Immediate (TRUE is always true)
// This tests if triggers can fire during our script's WAIT
LOCAL triggerCount IS 0.
WHEN TRUE THEN {
    SET triggerCount TO triggerCount + 1.
    IF triggerCount <= 3 {
        logEvent("TRIGGER-TRUE: fire #" + triggerCount).
        PRESERVE.
    }
}

logEvent("Triggers installed").
logEvent("MAIN: Starting 3-second wait...").

// This is the key test: do triggers fire DURING this wait?
WAIT 3.

logEvent("MAIN: Wait complete").
logEvent("MAIN: Doing some work...").

// Some busy work
LOCAL sum IS 0.
FROM {LOCAL i IS 0.} UNTIL i > 1000 STEP {SET i TO i + 1.} DO {
    SET sum TO sum + i.
}

logEvent("MAIN: Work done (sum=" + sum + ")").

PRINT "".
PRINT "=== Analysis ===".
PRINT "If TRIGGER messages appear DURING the 3s wait,".
PRINT "triggers fire at yield points (WAIT statements).".
PRINT "".
PRINT "If TRIGGER messages only appear AFTER wait,".
PRINT "triggers queue until script yields.".
PRINT "".
PRINT "Log entries: " + _PROOF5_LOG:LENGTH.
