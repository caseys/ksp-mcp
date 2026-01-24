// ==================================================
// mcp-align.ks
//
// Align vessel to maneuver node with smart RCS control.
//
// Strategy:
//   1) Normalize control (no SAS, no steering)
//   2) Try SAS MANEUVER first (crewed vessels)
//   3) Fall back to kOS LOCK STEERING if needed
//   4) Adaptive RCS thrust based on angular velocity
//   5) Stuck detection with full restart
//   6) Freeze final attitude with SAS STABILITY
//
// PARAMETERS:
//   RCS_MODE (0-3) - ascending aggressiveness
//     0 = do not touch RCS
//     1 = short burst at start + end (lightest)
//     2 = pulsed + adaptive RCS (medium)
//     3 = continuous + adaptive RCS (strongest)
//
//   USE_SAS (BOOLEAN)
//     TRUE  = allow SAS MANEUVER attempt
//     FALSE = force kOS steering
// ==================================================


// ------------------ parameters ------------------
PARAMETER RCS_MODE IS 0.
PARAMETER USE_SAS IS TRUE.


// ------------------ helper functions ------------------
FUNCTION SET_RCS_POWER {
    PARAMETER pct.
    FOR part IN SHIP:PARTS {
        IF part:HASMODULE("ModuleRCSFX") {
            part:GETMODULE("ModuleRCSFX"):SETFIELD("thrust limiter", pct).
        }
    }
}

FUNCTION DO_ALIGN {
    // Try SAS MANEUVER first (crewed vessels only)
    IF USE_SAS AND HASNODE AND SHIP:CREW:LENGTH > 0 {
        SET SAS TO TRUE. WAIT 0.
        SET SASMODE TO "MANEUVER". WAIT 0.
        IF SASMODE = "MANEUVER" {
            PRINT "ALIGN: SAS MANEUVER active".
            RETURN "SAS".
        }
    }

    // Fallback: kOS steering
    PRINT "ALIGN: kOS steering".
    SET SAS TO FALSE. WAIT 0.
    LOCK STEERING TO NEXTNODE:BURNVECTOR.
    RETURN "KOS".
}


// ------------------ save state ------------------
LOCAL origSAS IS SAS.
LOCAL origRCS IS RCS.


// ------------------ enter physics warp x2 ------------------
SET KUNIVERSE:TIMEWARP:MODE TO "PHYSICS".
WAIT 0.
SET KUNIVERSE:TIMEWARP:RATE TO 1.    // 2x physics warp
WAIT 0.
PRINT "ALIGN: physics warp x2 engaged".


// ------------------ normalize control ------------------
UNLOCK STEERING.
SET SAS TO FALSE.
WAIT 0.


// ------------------ RCS setup ------------------
IF RCS_MODE = 1 {
    // Mode 1: brief burst at start
    SET RCS TO TRUE.
    WAIT 0.1.
    SET RCS TO FALSE.
} ELSE IF RCS_MODE >= 2 {
    // Modes 2-3: RCS on, adaptive control
    SET RCS TO TRUE.
    SET_RCS_POWER(100).
    WAIT 0.
}


// ==================================================
// Main alignment loop with restart capability
// ==================================================
LOCAL alignAttempts IS 0.
LOCAL maxAttempts IS 3.
LOCAL aligned IS FALSE.
LOCAL method IS "KOS".

UNTIL alignAttempts >= maxAttempts {
    SET alignAttempts TO alignAttempts + 1.
    SET method TO DO_ALIGN().

    LOCAL stuckTime IS 0.
    LOCAL lastAngle IS 999.
    LOCAL tStart IS TIME:SECONDS.

    // RCS pulse burst for mode 2
    IF RCS_MODE = 2 {
        PRINT "ALIGN: RCS pulse assist".
        LOCAL idx IS 0.
        UNTIL idx >= 3 {
            SET RCS TO TRUE.
            WAIT 0.05.
            SET RCS TO FALSE.
            WAIT 0.1.
            SET idx TO idx + 1.
        }
        SET RCS TO TRUE.
    }

    // Alignment loop (30 second timeout per attempt)
    UNTIL TIME:SECONDS - tStart > 30 {
        LOCAL errAngle IS VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR).
        LOCAL angVel IS SHIP:ANGULARVEL:MAG.

        // Success - aligned within 1 degree
        IF errAngle < 1 {
            PRINT "ALIGN: " + method + " aligned (" + ROUND(errAngle, 1) + " deg)".
            SET aligned TO TRUE.
            BREAK.
        }

        // Adaptive RCS thrust control (modes 2-3)
        IF RCS_MODE >= 2 {
            IF angVel > 0.1 {
                SET_RCS_POWER(25).       // Fast rotation - prevent overshoot
            } ELSE IF angVel > 0.05 {
                SET_RCS_POWER(50).       // Medium rotation
            } ELSE IF angVel < 0.01 AND errAngle > 5 {
                SET_RCS_POWER(100).      // Stuck with large error - full power
            } ELSE {
                SET_RCS_POWER(75).       // Normal operation
            }
        }

        // Stuck detection: no angle change + low angular velocity
        IF ABS(errAngle - lastAngle) < 0.1 AND angVel < 0.005 AND errAngle > 2 {
            SET stuckTime TO stuckTime + 0.2.
            IF stuckTime > 2.0 {
                PRINT "ALIGN: stuck, restarting (attempt " + alignAttempts + "/" + maxAttempts + ")".
                UNLOCK STEERING.
                SET_RCS_POWER(100).
                WAIT 0.2.
                BREAK.  // Exit inner loop, retry with DO_ALIGN
            }
        } ELSE {
            SET stuckTime TO 0.
        }

        SET lastAngle TO errAngle.
        WAIT 0.2.
    }

    IF aligned { BREAK. }
}


// ------------------ RCS end burst (mode 1) ------------------
IF RCS_MODE = 1 {
    SET RCS TO TRUE.
    WAIT 0.1.
}


// ------------------ restore RCS ------------------
IF RCS_MODE >= 2 {
    SET_RCS_POWER(100).  // Restore full thrust
}
SET RCS TO origRCS.
WAIT 0.


// ------------------ restore SAS (freeze attitude) ------------------
SET SAS TO origSAS.
WAIT 0.
IF origSAS {
    SET SASMODE TO "STABILITY".
    WAIT 0.
}


// ------------------ clean warp exit ------------------
SET KUNIVERSE:TIMEWARP:MODE TO "RAILS".
WAIT 0.
SET KUNIVERSE:TIMEWARP:RATE TO 0.
WAIT 0.


// ------------------ report final state ------------------
LOCAL finalError IS ROUND(VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR), 1).
CLEARSCREEN.
PRINT "ALIGN_COMPLETE:" + method + ":" + finalError.
